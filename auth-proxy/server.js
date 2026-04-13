'use strict';

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const WEBTOP_URL = process.env.WEBTOP_URL || 'http://webtop:3000';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';
const DB_PATH = path.join(__dirname, 'db', 'users.json');
const SESSIONS_PATH = path.join(__dirname, 'db', 'sessions.json');
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000; // 8 hours

// ---------------------------------------------------------------------------
// Helpers — users
// ---------------------------------------------------------------------------

function readUsers() {
  if (!fs.existsSync(DB_PATH)) return [];
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeUsers(users) {
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers — sessions
// ---------------------------------------------------------------------------

function readSessions() {
  if (!fs.existsSync(SESSIONS_PATH)) return {};
  return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
}

function writeSessions(sessions) {
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers — User-Agent 파싱
// ---------------------------------------------------------------------------

function parseUserAgent(ua) {
  if (!ua) return { browser: '알 수 없음', device: '알 수 없음' };

  let browser = '알 수 없음';
  if (/Edg\//.test(ua))                              browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua))                   browser = 'Opera';
  else if (/SamsungBrowser\//.test(ua))              browser = 'Samsung Internet';
  else if (/Chrome\//.test(ua))                      browser = 'Chrome';
  else if (/Firefox\//.test(ua))                     browser = 'Firefox';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari';

  const versionMatch = ua.match(/(Edg|OPR|SamsungBrowser|Chrome|Firefox|Version)\/([\d]+)/);
  if (versionMatch) browser = `${browser} ${versionMatch[2]}`;

  let device = '알 수 없음';
  if (/Android/.test(ua))       device = 'Android';
  else if (/iPhone/.test(ua))   device = 'iPhone';
  else if (/iPad/.test(ua))     device = 'iPad';
  else if (/Windows/.test(ua))  device = 'Windows';
  else if (/Macintosh/.test(ua)) device = 'macOS';
  else if (/Linux/.test(ua))    device = 'Linux';

  return { browser, device };
}

// ---------------------------------------------------------------------------
// Helpers — IP 위치 조회 (비동기, 로그인 차단 없음)
// ---------------------------------------------------------------------------

const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$)/;

function lookupLocation(ip, sessionId) {
  const cleanIp = ip.replace(/^::ffff:/, '');
  if (PRIVATE_IP_RE.test(cleanIp) || cleanIp === 'localhost') return;

  https.get(`https://ip-api.com/json/${cleanIp}?fields=status,country,city&lang=ko`, (res) => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(raw);
        if (json.status === 'success') {
          const location = [json.city, json.country].filter(Boolean).join(', ');
          const sessions = readSessions();
          if (sessions[sessionId]) {
            sessions[sessionId].location = location;
            writeSessions(sessions);
          }
        }
      } catch (_) {}
    });
  }).on('error', () => {});
}

function addSession(sessionId, username, ip, ua) {
  const sessions = readSessions();
  const now = Date.now();
  const { browser, device } = parseUserAgent(ua);
  sessions[sessionId] = {
    username,
    ip,
    browser,
    device,
    location: null,
    startTime: new Date(now).toISOString(),
    lastActivity: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_MAX_AGE).toISOString(),
    terminated: false,
  };
  writeSessions(sessions);
  lookupLocation(ip, sessionId);
}

function removeSession(sessionId) {
  const sessions = readSessions();
  delete sessions[sessionId];
  writeSessions(sessions);
}

// Throttle file writes: update lastActivity at most once per 30s per session
const activityThrottles = new Map();
function touchSession(sessionId) {
  const now = Date.now();
  const last = activityThrottles.get(sessionId) || 0;
  if (now - last < 30_000) return;
  activityThrottles.set(sessionId, now);
  const sessions = readSessions();
  if (sessions[sessionId]) {
    sessions[sessionId].lastActivity = new Date(now).toISOString();
    writeSessions(sessions);
  }
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
    maxAge: SESSION_MAX_AGE,
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
    req.session.expiresAt = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
    req.session.save(() => {
      const clientIp = (req.ip || '').replace(/^::ffff:/, '');
      addSession(req.session.id, user.username, clientIp, req.headers['user-agent']);
      res.json({ redirect: '/' });
    });
  });
});

app.post('/logout', (req, res) => {
  const sessionId = req.session.id;
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    removeSession(sessionId);
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
  if (!req.session.user) {
    if (req.headers['accept']?.includes('application/json')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login');
  }

  // Check if this session was remotely terminated
  const sessions = readSessions();
  if (sessions[req.session.id]?.terminated) {
    req.session.destroy(() => res.clearCookie('connect.sid'));
    if (req.headers['accept']?.includes('application/json')) {
      return res.status(401).json({ error: 'Session terminated' });
    }
    return res.redirect('/login');
  }

  touchSession(req.session.id);
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Forbidden' });
}

// ---------------------------------------------------------------------------
// RBI API — 현재 사용자 정보
// ---------------------------------------------------------------------------

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    username: req.session.user.username,
    role: req.session.user.role,
  });
});

// ---------------------------------------------------------------------------
// RBI API — 세션 정보 / 연장
// ---------------------------------------------------------------------------

app.get('/api/session/info', requireAuth, (req, res) => {
  res.json({
    username: req.session.user.username,
    expiresAt: req.session.expiresAt,
  });
});

app.post('/api/session/extend', requireAuth, (req, res) => {
  const newExpiresAt = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
  req.session.expiresAt = newExpiresAt;
  req.session.cookie.maxAge = SESSION_MAX_AGE;

  const sessions = readSessions();
  if (sessions[req.session.id]) {
    sessions[req.session.id].expiresAt = newExpiresAt;
    writeSessions(sessions);
  }

  req.session.save(() => res.json({ expiresAt: newExpiresAt }));
});

// ---------------------------------------------------------------------------
// RBI API — 활성 세션 목록 / 강제 종료
// ---------------------------------------------------------------------------

app.get('/api/sessions', requireAuth, (req, res) => {
  const sessions = readSessions();
  const { username, role } = req.session.user;

  const list = Object.entries(sessions)
    .filter(([, s]) => !s.terminated && (role === 'admin' || s.username === username))
    .map(([id, s]) => ({
      sessionId: id,
      username: s.username,
      ip: s.ip,
      browser: s.browser || null,
      device: s.device || null,
      location: s.location || null,
      startTime: s.startTime,
      lastActivity: s.lastActivity,
      expiresAt: s.expiresAt,
      isCurrent: id === req.session.id,
    }));

  res.json(list);
});

app.delete('/api/sessions/:sessionId', requireAuth, (req, res) => {
  const { sessionId } = req.params;
  const { username, role } = req.session.user;

  if (sessionId === req.session.id) {
    return res.status(400).json({ error: '현재 세션은 이 API로 종료할 수 없습니다. /logout을 사용하세요.' });
  }

  const sessions = readSessions();
  const target = sessions[sessionId];

  if (!target) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  if (role !== 'admin' && target.username !== username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  sessions[sessionId].terminated = true;
  writeSessions(sessions);
  res.json({ ok: true });
});

app.delete('/api/sessions', requireAuth, (req, res) => {
  const { username, role } = req.session.user;
  const sessions = readSessions();

  let count = 0;
  for (const [id, s] of Object.entries(sessions)) {
    if (id === req.session.id) continue;
    if (role !== 'admin' && s.username !== username) continue;
    sessions[id].terminated = true;
    count++;
  }

  writeSessions(sessions);
  res.json({ terminated: count });
});

// ---------------------------------------------------------------------------
// RBI API — 비밀번호 변경
// ---------------------------------------------------------------------------

app.patch('/api/me/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword와 newPassword가 필요합니다.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '새 비밀번호는 6자 이상이어야 합니다.' });
  }

  const users = readUsers();
  const idx = users.findIndex(u => u.username === req.session.user.username);
  if (idx === -1) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

  if (!bcrypt.compareSync(currentPassword, users[idx].passwordHash)) {
    return res.status(401).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
  }

  users[idx].passwordHash = bcrypt.hashSync(newPassword, 12);
  writeUsers(users);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin API — 사용자 관리
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

const webtopProxy = createProxyMiddleware({
  target: WEBTOP_URL,
  changeOrigin: true,
  ws: true,
  on: {
    error: (err, _req, res) => {
      console.error('[proxy error]', err.message);
      if (res.writeHead) {
        res.writeHead(502);
        res.end('Webtop is unreachable.');
      }
    },
  },
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
server.on('upgrade', (req, socket, head) => {
  cookieParser()(req, {}, () => {
    sessionMiddleware(req, {}, () => {
      if (!req.session?.user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const sessions = readSessions();
      if (sessions[req.session.id]?.terminated) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      webtopProxy.upgrade(req, socket, head);
    });
  });
});
