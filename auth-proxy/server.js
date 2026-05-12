'use strict';

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;
const WEBTOP_URL = process.env.WEBTOP_URL || 'http://webtop:3000';
const PRINT_DIR = path.join(__dirname, 'print-output');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';
const DB_PATH = path.join(__dirname, 'db', 'users.json');
const SESSIONS_PATH = path.join(__dirname, 'db', 'sessions.json');
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000; // 8 hours

// Active WebSocket connections: sessionId -> socket
const activeSockets = new Map();

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
// Helpers — webtop reset
// ---------------------------------------------------------------------------

function resetWebtop() {
  exec('docker exec webtop rm -rf /config/.cache/sessions && docker restart webtop', (err) => {
    if (err) console.error('[webtop] reset failed:', err.message);
    else console.log('[webtop] session cleared and restarted');
  });
}

// Clear webtop session cache without restarting the container.
// Used on concurrent login kick: the new window can connect immediately
// because we remove the stale KasmVNC session files without taking webtop offline.
function clearWebtopSessionCache() {
  exec('docker exec webtop rm -rf /config/.cache/sessions', (err) => {
    if (err) console.error('[webtop] session cache clear failed:', err.message);
    else console.log('[webtop] session cache cleared');
  });
}

// ---------------------------------------------------------------------------
// Helpers — session termination
// ---------------------------------------------------------------------------

// Mark sessions as terminated, close their WebSocket connections, and reset webtop.
// Pass shouldResetWebtop=false on concurrent-login kick so webtop stays up but
// the stale session cache is still wiped (new window connects without a bounce).
function terminateSessionBatch(sessionIds, shouldResetWebtop = true) {
  if (!sessionIds.length) return;
  const sessions = readSessions();
  for (const id of sessionIds) {
    if (sessions[id]) sessions[id].terminated = true;
    const sock = activeSockets.get(id);
    if (sock) {
      try { sock.destroy(); } catch (_) {}
      activeSockets.delete(id);
    }
  }
  writeSessions(sessions);
  if (shouldResetWebtop) resetWebtop();
  else clearWebtopSessionCache();
}

function removeSession(sessionId) {
  const sessions = readSessions();
  delete sessions[sessionId];
  writeSessions(sessions);
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
  if (/Android/.test(ua))        device = 'Android';
  else if (/iPhone/.test(ua))    device = 'iPhone';
  else if (/iPad/.test(ua))      device = 'iPad';
  else if (/Windows/.test(ua))   device = 'Windows';
  else if (/Macintosh/.test(ua)) device = 'macOS';
  else if (/Linux/.test(ua))     device = 'Linux';

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
// Session monitor script (injected into webtop HTML)
// Polls /api/session/info every 30s. On 401, shows overlay and redirects to /login.
// ---------------------------------------------------------------------------

const SESSION_MONITOR_SCRIPT = `
<script>
(function () {
  var POLL_MS = 30000;
  var shown = false;

  function showOverlay(msg) {
    if (shown) return;
    shown = true;
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.88);' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'font-family:sans-serif;color:#fff;gap:16px;pointer-events:all;';
    el.innerHTML =
      '<div style="font-size:20px;font-weight:600">&#9888;&#65039; ' + msg + '</div>' +
      '<div style="font-size:13px;opacity:.65">3초 후 로그인 페이지로 이동합니다...</div>';
    document.body.appendChild(el);
    setTimeout(function () { window.location.replace('/login'); }, 3000);
  }

  function check() {
    fetch('/api/session/info', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) showOverlay('세션이 종료되었습니다.');
      })
      .catch(function () {});
  }

  setInterval(check, POLL_MS);
})();
</script>
`;

// ---------------------------------------------------------------------------
// 인쇄 클라이언트 스크립트 (webtop HTML에 주입)
// /print-ws로 연결하여 바이너리 PDF를 수신하고 브라우저 프린트 다이얼로그를 실행한다.
// ---------------------------------------------------------------------------

const PRINT_CLIENT_SCRIPT = `
<script>
(function () {
  var RETRY_MS = 5000;
  var ws;

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/print-ws');
    ws.binaryType = 'blob';

    ws.onopen = function () {
      console.log('[print] connected');
    };

    ws.onmessage = function (e) {
      if (!(e.data instanceof Blob)) return;
      var blob = new Blob([e.data], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;width:0;height:0;border:none;visibility:hidden;';
      document.body.appendChild(iframe);
      iframe.onload = function () {
        try { iframe.contentWindow.print(); } catch (err) {}
        setTimeout(function () {
          document.body.removeChild(iframe);
          URL.revokeObjectURL(url);
        }, 60000);
      };
      iframe.src = url;
    };

    ws.onclose = function () {
      setTimeout(connect, RETRY_MS);
    };
    ws.onerror = function () {
      ws.close();
    };
  }

  connect();
})();
</script>
`;

// ---------------------------------------------------------------------------
// Periodic cleanup — terminate expired sessions every minute
// ---------------------------------------------------------------------------

setInterval(() => {
  const sessions = readSessions();
  const now = Date.now();
  const expired = Object.keys(sessions).filter(id =>
    !sessions[id].terminated &&
    sessions[id].expiresAt &&
    new Date(sessions[id].expiresAt).getTime() < now
  );
  if (expired.length > 0) {
    console.log(`[cleanup] terminating ${expired.length} expired session(s)`);
    terminateSessionBatch(expired);
  }
}, 60_000);

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

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.username));
passport.deserializeUser((username, done) => {
  const user = readUsers().find(u => u.username === username);
  done(null, user || false);
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: '/auth/google/callback',
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    if (!email) return done(new Error('No email returned from Google'));

    const users = readUsers();
    let user = users.find(u => u.googleId === profile.id || u.username === email);

    if (!user) {
      user = {
        username: email,
        googleId: profile.id,
        role: 'user',
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      writeUsers(users);
    } else if (!user.googleId) {
      const idx = users.findIndex(u => u.username === user.username);
      users[idx].googleId = profile.id;
      user = users[idx];
      writeUsers(users);
    }

    done(null, user);
  }));
}

// Serve static assets (login.html, login.css) without auth
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Auth routes (public)
// ---------------------------------------------------------------------------

app.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.redirect('/login');
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=google' }),
  (req, res) => {
    const user = req.user;
    const existingSessions = readSessions();
    const toKick = Object.keys(existingSessions).filter(
      id => !existingSessions[id].terminated && existingSessions[id].username === user.username
    );
    if (toKick.length > 0) terminateSessionBatch(toKick, false);

    req.session.regenerate((err) => {
      if (err) return res.redirect('/login');
      req.session.user = { username: user.username, role: user.role };
      req.session.expiresAt = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
      req.session.save(() => {
        const clientIp = (req.ip || '').replace(/^::ffff:/, '');
        addSession(req.session.id, user.username, clientIp, req.headers['user-agent']);
        res.redirect('/');
      });
    });
  }
);

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

  if (!user || !user.passwordHash || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Kick all existing active sessions for this user before creating a new one
  const existingSessions = readSessions();
  const toKick = Object.keys(existingSessions).filter(
    id => !existingSessions[id].terminated && existingSessions[id].username === user.username
  );
  if (toKick.length > 0) {
    console.log(`[login] kicking ${toKick.length} existing session(s) for "${user.username}"`);
    terminateSessionBatch(toKick, false); // webtop은 재시작하지 않음 — 새 창이 이어서 사용
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
    resetWebtop();
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

  const sessions = readSessions();
  const s = sessions[req.session.id];

  // Session was terminated (concurrent login or admin kick)
  if (s?.terminated) {
    req.session.destroy(() => res.clearCookie('connect.sid'));
    if (req.headers['accept']?.includes('application/json')) {
      return res.status(401).json({ error: 'Session terminated' });
    }
    return res.redirect('/login');
  }

  // Session expired
  if (s?.expiresAt && new Date(s.expiresAt).getTime() < Date.now()) {
    terminateSessionBatch([req.session.id]);
    req.session.destroy(() => res.clearCookie('connect.sid'));
    if (req.headers['accept']?.includes('application/json')) {
      return res.status(401).json({ error: 'Session expired' });
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

  terminateSessionBatch([sessionId]);
  res.json({ ok: true });
});

app.delete('/api/sessions', requireAuth, (req, res) => {
  const { username, role } = req.session.user;
  const sessions = readSessions();

  const toKick = Object.keys(sessions).filter(id =>
    id !== req.session.id &&
    !sessions[id].terminated &&
    (role === 'admin' || sessions[id].username === username)
  );

  if (toKick.length > 0) terminateSessionBatch(toKick);
  res.json({ terminated: toKick.length });
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

app.get('/admin/users', requireAuth, requireAdmin, (_req, res) => {
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
// Webtop reverse proxy
// ---------------------------------------------------------------------------

const webtopProxy = createProxyMiddleware({
  target: WEBTOP_URL,
  changeOrigin: true,
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

// Inject session monitor into the webtop index HTML
const webtopTarget = new URL(WEBTOP_URL);

const CONNECTING_PAGE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>연결 중...</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;color:#e2e8f0;font-family:'Segoe UI',sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    height:100vh;gap:20px;}
  .spinner{width:44px;height:44px;border:4px solid rgba(255,255,255,.15);
    border-top-color:#60a5fa;border-radius:50%;animation:spin .9s linear infinite;}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:1.25rem;font-weight:600;letter-spacing:.01em;}
  p{font-size:.85rem;opacity:.5;}
</style>
</head>
<body>
<div class="spinner"></div>
<h1>데스크톱에 연결하는 중...</h1>
<p id="msg">잠시 후 자동으로 연결됩니다.</p>
<script>
(function(){
  var attempt = 0;
  var INTERVAL = 2500;
  function probe(){
    attempt++;
    fetch('/_rbi_ready_probe', {credentials:'same-origin'})
      .then(function(r){ if(r.ok) window.location.reload(); })
      .catch(function(){});
    document.getElementById('msg').textContent =
      '연결 시도 중... (' + attempt + ')';
  }
  setTimeout(probe, INTERVAL);
  setInterval(probe, INTERVAL);
})();
</script>
</body>
</html>`;

app.get('/_rbi_ready_probe', requireAuth, (_req, res) => {
  const options = {
    hostname: webtopTarget.hostname,
    port: Number(webtopTarget.port) || 80,
    path: '/',
    headers: { host: webtopTarget.host },
  };
  const req2 = http.get(options, (proxyRes) => {
    // Drain to avoid socket leak
    proxyRes.resume();
    const status = proxyRes.statusCode || 0;
    if (status >= 200 && status < 300) {
      res.json({ ready: true });
    } else {
      res.status(503).json({ ready: false, status });
    }
  });
  req2.on('error', () => res.status(503).json({ ready: false, error: 'unreachable' }));
  req2.setTimeout(3000, () => { req2.destroy(); res.status(503).json({ ready: false, error: 'timeout' }); });
});

app.get('/', requireAuth, (_req, res) => {
  const options = {
    hostname: webtopTarget.hostname,
    port: Number(webtopTarget.port) || 80,
    path: '/',
    headers: { host: webtopTarget.host },
  };
  http.get(options, (proxyRes) => {
    const status = proxyRes.statusCode || 0;

    // webtop이 아직 준비되지 않았거나 자체 /login으로 리다이렉트하는 경우
    // — 브라우저에 그대로 전달하면 로그인 화면으로 튕기므로 로딩 페이지로 대체
    if (status < 200 || status >= 300) {
      proxyRes.resume(); // drain
      console.log(`[proxy] GET / webtop returned ${status} — serving connecting page`);
      res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(CONNECTING_PAGE);
      return;
    }

    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', () => {
      let html = Buffer.concat(chunks).toString('utf8');
      const tag = html.includes('</body>') ? '</body>' : '</html>';
      html = html.replace(tag, SESSION_MONITOR_SCRIPT + PRINT_CLIENT_SCRIPT + tag);
      const headers = { ...proxyRes.headers };
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
      headers['content-length'] = String(Buffer.byteLength(html));
      res.writeHead(200, headers);
      res.end(html);
    });
  }).on('error', () => {
    console.log('[proxy] GET / webtop unreachable — serving connecting page');
    res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(CONNECTING_PAGE);
  });
});

app.use('/', requireAuth, webtopProxy);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`auth-proxy listening on http://0.0.0.0:${PORT}`);
  console.log(`proxying to webtop at ${WEBTOP_URL}`);
});

// ---------------------------------------------------------------------------
// 인쇄 WebSocket 서버 + 파일 감시
// ---------------------------------------------------------------------------

const printWss = new WebSocket.Server({ noServer: true });

fs.mkdirSync(PRINT_DIR, { recursive: true });

setInterval(() => {
  let files;
  try {
    files = fs.readdirSync(PRINT_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
  } catch { return; }
  console.log(`[print] poll: ${files.length} file(s), ${printWss.clients.size} client(s)`);
  if (!files.length || !printWss.clients.size) return;
  for (const fname of files) {
    const fpath = path.join(PRINT_DIR, fname);
    try {
      const data = fs.readFileSync(fpath);
      for (const client of printWss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      }
      fs.unlinkSync(fpath);
      console.log(`[print] sent ${fname} to ${printWss.clients.size} client(s), deleted`);
    } catch (e) {
      console.error(`[print] error processing ${fname}:`, e.message);
    }
  }
}, 3000);

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
      const s = sessions[req.session.id];

      if (s?.terminated || (s?.expiresAt && new Date(s.expiresAt).getTime() < Date.now())) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // /print-ws → printWss (직접 처리)
      if (req.url === '/print-ws') {
        printWss.handleUpgrade(req, socket, head, (ws) => {
          printWss.emit('connection', ws, req);
        });
        return;
      }

      // Track this socket so we can close it on termination
      activeSockets.set(req.session.id, socket);
      socket.on('close', () => activeSockets.delete(req.session.id));

      webtopProxy.upgrade(req, socket, head);
    });
  });
});
