import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  loadDb,
  createUser,
  findByUsername,
  findById,
  verifyPassword,
  updateUser,
  deleteUser,
  setPassword,
  touchLogin,
  listUsers,
  listHistory,
  publicUser,
  stats,
  allowRegister,
  cardCounterEnabled,
  setSetting,
  publicSettings,
} from './src/db.js';
import {
  attachUser,
  requireAuth,
  requireAdmin,
  setAuthCookie,
  clearAuthCookie,
} from './src/auth.js';
import { Hub } from './src/hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

loadDb();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(attachUser);

// 简单登录限流（按 IP）
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > 5 * 60 * 1000) {
    attempts.set(ip, { count: 1, first: now });
    return false;
  }
  rec.count++;
  return rec.count > 20;
}

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

app.get('/api/me', (req, res) => {
  res.json({ user: publicUser(req.user), ...publicSettings() });
});

app.post('/api/register', (req, res) => {
  if (!allowRegister()) return res.status(403).json({ error: '管理员已关闭自助注册' });
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (tooMany(ip)) return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
  const { username, password, nickname } = req.body || {};
  const result = createUser({ username, password, nickname });
  if (result.error) return res.status(400).json({ error: result.error });
  touchLogin(result.user.id);
  setAuthCookie(res, result.user.id);
  res.json({ user: publicUser(result.user) });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (tooMany(ip)) return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
  const { username, password } = req.body || {};
  const user = findByUsername(username);
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  if (user.disabled) return res.status(403).json({ error: '账号已被禁用，请联系管理员' });
  touchLogin(user.id);
  setAuthCookie(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/rooms', requireAuth, (req, res) => {
  res.json({ rooms: [] });
});

// ---------- 管理员 ----------
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: listUsers() });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password, nickname, isAdmin } = req.body || {};
  const result = createUser({ username, password, nickname, isAdmin: !!isAdmin });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ user: publicUser(result.user) });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const target = findById(req.params.id);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  const patch = req.body || {};
  if (target.id === req.user.id) {
    if (patch.disabled === true) return res.status(400).json({ error: '不能禁用自己' });
    if (patch.isAdmin === false) return res.status(400).json({ error: '不能取消自己的管理员权限' });
  }
  if (patch.isAdmin === false && target.isAdmin) {
    const admins = listUsers().filter((u) => u.isAdmin && !u.disabled && u.id !== target.id);
    if (admins.length === 0) return res.status(400).json({ error: '至少需要保留一名管理员' });
  }
  const result = updateUser(target.id, patch);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ user: result.user });
});

app.post('/api/admin/users/:id/password', requireAdmin, (req, res) => {
  const target = findById(req.params.id);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  const result = setPassword(target.id, (req.body || {}).password);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const target = findById(req.params.id);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  if (target.isAdmin) {
    const admins = listUsers().filter((u) => u.isAdmin && !u.disabled && u.id !== target.id);
    if (admins.length === 0) return res.status(400).json({ error: '至少需要保留一名管理员' });
  }
  deleteUser(target.id);
  res.json({ ok: true });
});

app.get('/api/admin/history', requireAdmin, (req, res) => {
  res.json({ history: listHistory(50) });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({ ...stats(), online: hub.onlineCount() });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({ settings: publicSettings() });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (typeof body.allowRegister === 'boolean') setSetting('allowRegister', body.allowRegister);
  if (typeof body.cardCounter === 'boolean') setSetting('cardCounter', body.cardCounter);
  res.json({ settings: publicSettings() });
});

// ---------- 静态页面 ----------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = http.createServer(app);
const hub = new Hub();
hub.attach(server);

server.listen(PORT, HOST, () => {
  console.log(`《二五》服务已启动: http://${HOST}:${PORT}`);
  console.log(`默认管理员：admin / admin123（可通过 ADMIN_PASSWORD 环境变量修改初始密码）`);
});

function shutdown() {
  console.log('\n正在关闭服务...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
