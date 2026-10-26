import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = { users: [], history: [], settings: {}, createdAt: Date.now() };

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 系统设置：可由管理员在后台修改
export function getSettings() {
  if (!db.settings) db.settings = {};
  return db.settings;
}

export function setSetting(key, value) {
  if (!db.settings) db.settings = {};
  db.settings[key] = value;
  saveDb();
  return db.settings;
}

// 是否允许自助注册（环境变量为默认值，管理员可在后台覆盖）
export function allowRegister() {
  const s = getSettings();
  if (typeof s.allowRegister === 'boolean') return s.allowRegister;
  return String(process.env.ALLOW_REGISTER ?? '1') !== '0';
}

// 是否开放记牌器（环境变量为默认值，管理员可在后台覆盖）
export function cardCounterEnabled() {
  const s = getSettings();
  if (typeof s.cardCounter === 'boolean') return s.cardCounter;
  return String(process.env.CARD_COUNTER ?? '1') !== '0';
}

export function publicSettings() {
  return {
    allowRegister: allowRegister(),
    cardCounter: cardCounterEnabled(),
  };
}

export function loadDb() {
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = {
        users: Array.isArray(raw.users) ? raw.users : [],
        history: Array.isArray(raw.history) ? raw.history : [],
        settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
        createdAt: raw.createdAt || Date.now(),
      };
    } catch (e) {
      console.error('读取 data/db.json 失败，使用空数据库:', e.message);
      db = { users: [], history: [], settings: {}, createdAt: Date.now() };
    }
  }
  seedAdmin();
  saveDb();
  return db;
}

export function saveDb() {
  ensureDir();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  try {
    const test = crypto.scryptSync(String(password), salt, 64);
    const known = Buffer.from(hash, 'hex');
    return known.length === test.length && crypto.timingSafeEqual(known, test);
  } catch {
    return false;
  }
}

function seedAdmin() {
  const username = (process.env.ADMIN_USER || 'admin').trim();
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return;
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const { salt, hash } = hashPassword(password);
  db.users.push({
    id: crypto.randomUUID(),
    username,
    nickname: '管理员',
    salt,
    hash,
    isAdmin: true,
    disabled: false,
    createdAt: Date.now(),
    lastLoginAt: null,
    games: 0,
    wins: 0,
  });
  console.log(`[init] 已创建默认管理员账号：${username} / ${password}（请尽快修改密码）`);
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname || u.username,
    isAdmin: !!u.isAdmin,
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    games: u.games || 0,
    wins: u.wins || 0,
  };
}

export function findById(id) {
  return db.users.find((u) => u.id === id) || null;
}

export function findByUsername(username) {
  const name = String(username || '').trim().toLowerCase();
  return db.users.find((u) => u.username.toLowerCase() === name) || null;
}

export function listUsers() {
  return db.users
    .slice()
    .sort((a, b) => (a.isAdmin === b.isAdmin ? a.createdAt - b.createdAt : a.isAdmin ? -1 : 1))
    .map(publicUser);
}

export function createUser({ username, password, nickname, isAdmin = false }) {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/.test(name)) {
    return { error: '账号需为 2-20 位中文/字母/数字/下划线' };
  }
  if (String(password || '').length < 4) return { error: '密码至少 4 位' };
  if (findByUsername(name)) return { error: '该账号已存在' };
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    username: name,
    nickname: (nickname || name).toString().slice(0, 20),
    salt,
    hash,
    isAdmin: !!isAdmin,
    disabled: false,
    createdAt: Date.now(),
    lastLoginAt: null,
    games: 0,
    wins: 0,
  };
  db.users.push(user);
  saveDb();
  return { user };
}

export function setPassword(id, password) {
  const u = findById(id);
  if (!u) return { error: '账号不存在' };
  if (String(password || '').length < 4) return { error: '密码至少 4 位' };
  const { salt, hash } = hashPassword(password);
  u.salt = salt;
  u.hash = hash;
  saveDb();
  return { ok: true };
}

export function updateUser(id, patch) {
  const u = findById(id);
  if (!u) return { error: '账号不存在' };
  if (typeof patch.nickname === 'string' && patch.nickname.trim()) u.nickname = patch.nickname.trim().slice(0, 20);
  if (typeof patch.isAdmin === 'boolean') u.isAdmin = patch.isAdmin;
  if (typeof patch.disabled === 'boolean') u.disabled = patch.disabled;
  saveDb();
  return { user: publicUser(u) };
}

export function deleteUser(id) {
  const u = findById(id);
  if (!u) return { error: '账号不存在' };
  db.users = db.users.filter((x) => x.id !== id);
  saveDb();
  return { ok: true };
}

export function touchLogin(id) {
  const u = findById(id);
  if (!u) return;
  u.lastLoginAt = Date.now();
  saveDb();
}

export function recordMatch({ mode, roomName, players, result }) {
  const entry = {
    id: crypto.randomUUID(),
    at: Date.now(),
    mode,
    roomName,
    result: {
      title: result.title,
      detail: result.detail,
      declarerName: result.declarerName,
      declarerPoints: result.declarerPoints,
      defenderPoints: result.defenderPoints,
      bidValue: result.bidValue,
    },
    players,
  };
  db.history.push(entry);
  if (db.history.length > 500) db.history.splice(0, db.history.length - 500);
  for (const p of players) {
    const u = findById(p.userId);
    if (!u) continue;
    u.games = (u.games || 0) + 1;
    if (p.won) u.wins = (u.wins || 0) + 1;
  }
  saveDb();
}

export function listHistory(limit = 30) {
  return db.history.slice(-limit).reverse();
}

export function stats() {
  return {
    users: db.users.length,
    games: db.history.length,
    online: 0,
  };
}
