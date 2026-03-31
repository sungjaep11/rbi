'use strict';

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8080;
const WEBTOP_URL = process.env.WEBTOP_URL || 'http://webtop:3000';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';
const DB_PATH = path.join(__dirname, 'db', 'users.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readUsers() {
  if (!fs.existsSync(DB_PATH)) return [];
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeUsers(users) {
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
});
app.use(sessionMiddleware);

// Serve static assets (login.html, login.css) without auth
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Auth routes (public)
// ---------------------------------------------------------------------------

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const users = readUsers();
  const user = users.find(u => u.username === username);

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error.' });
    req.session.user = { username: user.username, role: user.role };
    res.json({ redirect: '/' });
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
    exec('docker exec webtop rm -rf /config/.cache/sessions && docker restart webtop', (err) => {
      if (err) console.error('[logout] failed to reset webtop:', err.message);
      else console.log('[logout] webtop session cleared and restarted');
    });
  });
});

// ---------------------------------------------------------------------------
// Auth middleware — everything below requires a valid session
// ---------------------------------------------------------------------------

function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.headers['accept']?.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Forbidden' });
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

app.get('/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = readUsers().map(({ username, role, createdAt }) => ({
    username, role, createdAt,
  }));
  res.json(users);
});

app.post('/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role = 'user' } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required.' });
  }
  if (!['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'role must be "admin" or "user".' });
  }

  const users = readUsers();
  if (users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'Username already exists.' });
  }

  const newUser = {
    username,
    passwordHash: bcrypt.hashSync(password, 12),
    role,
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  writeUsers(users);

  res.status(201).json({ username: newUser.username, role: newUser.role, createdAt: newUser.createdAt });
});

app.delete('/admin/users/:username', requireAuth, requireAdmin, (req, res) => {
  const { username } = req.params;

  if (username === req.session.user.username) {
    return res.status(400).json({ error: 'Cannot delete yourself.' });
  }

  let users = readUsers();
  const exists = users.find(u => u.username === username);
  if (!exists) return res.status(404).json({ error: 'User not found.' });

  users = users.filter(u => u.username !== username);
  writeUsers(users);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Webtop reverse proxy (authenticated)
// ---------------------------------------------------------------------------

const LOGOUT_BUTTON_HTML = `
<style>
  #rbi-logout-form {
    position: fixed;
    bottom: 12px;
    right: 12px;
    z-index: 99999;
    margin: 0;
  }
  #rbi-logout-btn {
    padding: 6px 14px;
    background: rgba(30,30,30,0.85);
    color: #fff;
    border: 1px solid rgba(255,255,255,0.25);
    border-radius: 6px;
    font-family: sans-serif;
    font-size: 13px;
    cursor: pointer;
    backdrop-filter: blur(4px);
  }
  #rbi-logout-btn:hover { background: rgba(200,40,40,0.9); }
</style>
<form id="rbi-logout-form" action="/logout" method="POST" onsubmit="document.cookie.split(';').forEach(function(c){document.cookie=c.replace(/^ +/,'').replace(/=.*/,'=;expires='+new Date(0).toUTCString()+';path=/');})">
  <button id="rbi-logout-btn" type="submit">Logout</button>
</form>
`;

const webtopProxy = createProxyMiddleware({
  target: WEBTOP_URL,
  changeOrigin: true,
  selfHandleResponse: true,
  on: {
    proxyRes: responseInterceptor(async (responseBuffer, proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      if (contentType.includes('text/html')) {
        const html = responseBuffer.toString('utf8');
        const tag = html.includes('</body>') ? '</body>' : '</html>';
        return html.replace(tag, LOGOUT_BUTTON_HTML + tag);
      }
      return responseBuffer;
    }),
    error: (err, _req, res) => {
      console.error('[proxy error]', err.message);
      if (res.writeHead) {
        res.writeHead(502);
        res.end('Webtop is unreachable.');
      }
    },
  },
  ws: true,
});

app.use('/', requireAuth, webtopProxy);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`auth-proxy listening on http://0.0.0.0:${PORT}`);
  console.log(`proxying to webtop at ${WEBTOP_URL}`);
});

// Forward WebSocket upgrades to webtop
// Session middleware doesn't run on upgrade events, so run it manually
server.on('upgrade', (req, socket, head) => {
  // Run cookie + session middleware on the upgrade request
  cookieParser()(req, {}, () => {
    sessionMiddleware(req, {}, () => {
      if (req.session?.user) {
        webtopProxy.upgrade(req, socket, head);
      } else {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      }
    });
  });
});
