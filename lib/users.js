'use strict';

// User accounts, per-session grants and console login tokens, stored in SQLite.
// Driver: Node's built-in node:sqlite (Node >= 22.5) or the better-sqlite3 package.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const USERNAME = /^[\p{L}\p{N}_.@-]{2,32}$/u;
const SESSION_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

function openDriver(file) {
  const preferred = process.env.SQLITE_DRIVER;
  const errors = [];
  const attempts = preferred === 'better-sqlite3' ? ['better-sqlite3'] : preferred === 'node' ? ['node'] : ['node', 'better-sqlite3'];
  for (const name of attempts) {
    try {
      if (name === 'node') {
        const { DatabaseSync } = require('node:sqlite');
        return { db: new DatabaseSync(file), driver: 'node:sqlite' };
      }
      const Database = require('better-sqlite3');
      return { db: new Database(file), driver: 'better-sqlite3' };
    } catch (error) { errors.push(`${name}: ${error.code || error.message}`); }
  }
  throw new Error(`No SQLite driver available (need Node >= 22.5 or \`npm install better-sqlite3\`): ${errors.join('; ')}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  avatar_url TEXT NOT NULL DEFAULT '',
  feishu_open_id TEXT,
  feishu_union_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  auth_provider TEXT NOT NULL DEFAULT 'password'
);
CREATE TABLE IF NOT EXISTS user_sessions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, session_key)
);
CREATE INDEX IF NOT EXISTS user_sessions_key ON user_sessions(session_key);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id);
`;

function failure(message, status) { return Object.assign(new Error(message), { status }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function now() { return new Date().toISOString(); }

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
// Spend the same work for unknown usernames so timing does not reveal which exist.
let dummyHash;

function checkUsername(username) {
  if (typeof username !== 'string' || !USERNAME.test(username)) throw failure('用户名需为 2-32 位字母、数字或 _ . @ -', 400);
  return username;
}
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw failure('密码长度需为 8-256 位', 400);
  return password;
}
function checkRole(role) {
  if (role !== 'admin' && role !== 'user') throw failure('Invalid role', 400);
  return role;
}
function checkKeys(keys) {
  if (!Array.isArray(keys) || keys.length > 5000 || keys.some(key => typeof key !== 'string' || !SESSION_KEY.test(key))) throw failure('Invalid sessions', 400);
  return [...new Set(keys)];
}


function maskOpenId(openId) {
  const s = String(openId || '');
  return s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-4)}` : '***';
}
function feishuUnusableHash() {
  return `!feishu!$${crypto.randomBytes(32).toString('base64url')}`;
}
function sanitizeFeishuUsername(name, openId) {
  let base = String(name || '').normalize('NFKC').replace(/[^\p{L}\p{N}_.@-]/gu, '').slice(0, 24);
  if (base.length < 2) {
    const tail = String(openId || '').replace(/[^A-Za-z0-9]/g, '').slice(-10);
    base = (tail.length >= 2 ? `fs_${tail}` : 'feishu').slice(0, 32);
  }
  return base;
}

class Users {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { db, driver } = openDriver(file);
    this.db = db;
    this.driver = driver;
    try { fs.chmodSync(file, 0o600); } catch {}
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    this.migrate();
    this.statements = new Map();
    this.failures = new Map();
  }
  sql(text) {
    let statement = this.statements.get(text);
    if (!statement) { statement = this.db.prepare(text); this.statements.set(text, statement); }
    return statement;
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  // v1 had a per-user can_create flag; only admins create sessions now. Drop the column when SQLite
  // supports it (>= 3.35); otherwise it is simply ignored (it has a default, so inserts still work).
  migrate() {
    const columns = this.db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
    if (columns.includes('can_create')) { try { this.db.exec('ALTER TABLE users DROP COLUMN can_create'); } catch {} }
    const add = [
      ['avatar_url', "ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''"],
      ['feishu_open_id', 'ALTER TABLE users ADD COLUMN feishu_open_id TEXT'],
      ['feishu_union_id', "ALTER TABLE users ADD COLUMN feishu_union_id TEXT NOT NULL DEFAULT ''"],
      ['display_name', "ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''"],
      ['auth_provider', "ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'password'"],
    ];
    for (const [name, ddl] of add) {
      if (!columns.includes(name)) this.db.exec(ddl);
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_feishu_open_id ON users(feishu_open_id) WHERE feishu_open_id IS NOT NULL AND feishu_open_id <> \'\'');
  }
  close() { try { this.db.close(); } catch {} }

  // ----- users -----
  publicUser(row) {
    if (!row) return null;
    const provider = row.auth_provider || 'password';
    const hash = String(row.password_hash || '');
    return {
      id: Number(row.id), username: row.username, role: row.role, disabled: !!row.disabled,
      created_at: row.created_at, updated_at: row.updated_at, last_login_at: row.last_login_at || null,
      avatar_url: row.avatar_url || '', display_name: row.display_name || '',
      auth_provider: provider, has_password: hash.startsWith('scrypt$'),
      feishu_open_id: row.feishu_open_id ? maskOpenId(row.feishu_open_id) : null,
    };
  }
  row(id) { return this.sql('SELECT * FROM users WHERE id = ?').get(Number(id)); }
  get(id) {
    const user = this.publicUser(this.row(id));
    if (user) user.sessions = this.grants(user.id);
    return user;
  }
  list() {
    const grants = new Map();
    for (const row of this.sql('SELECT user_id, session_key FROM user_sessions ORDER BY session_key').all()) {
      const id = Number(row.user_id);
      if (!grants.has(id)) grants.set(id, []);
      grants.get(id).push(row.session_key);
    }
    return this.sql('SELECT * FROM users ORDER BY role = \'admin\' DESC, username').all().map(row => ({ ...this.publicUser(row), sessions: grants.get(Number(row.id)) || [] }));
  }
  count() { return Number(this.sql('SELECT COUNT(*) AS n FROM users').get().n); }
  hasAdmin() { return !!this.sql("SELECT 1 AS x FROM users WHERE role = 'admin' AND disabled = 0 LIMIT 1").get(); }
  enabledAdmins() { return Number(this.sql("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n); }

  async create({ username, password, role = 'user', disabled = false, sessions = [] }) {
    checkUsername(username); checkPassword(password); checkRole(role);
    const keys = checkKeys(sessions);
    const hash = await hashPassword(password);
    const time = now();
    try {
      return this.get(this.transaction(() => {
        const id = Number(this.sql('INSERT INTO users (username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(username, hash, role, disabled ? 1 : 0, time, time).lastInsertRowid);
        for (const key of keys) this.sql('INSERT INTO user_sessions (user_id, session_key, granted_at) VALUES (?, ?, ?)').run(id, key, time);
        return id;
      }));
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) throw failure('用户名已存在', 409);
      throw error;
    }
  }
  update(id, changes) {
    const row = this.row(id);
    if (!row) throw failure('User not found', 404);
    const sets = [], values = [];
    if (changes.username !== undefined) { sets.push('username = ?'); values.push(checkUsername(changes.username)); }
    if (changes.role !== undefined) { sets.push('role = ?'); values.push(checkRole(changes.role)); }
    for (const field of ['disabled']) {
      if (changes[field] === undefined) continue;
      if (typeof changes[field] !== 'boolean') throw failure(`Invalid ${field}`, 400);
      sets.push(`${field} = ?`); values.push(changes[field] ? 1 : 0);
    }
    const demoting = (changes.role === 'user' && row.role === 'admin') || (changes.disabled === true && row.role === 'admin' && !row.disabled);
    if (demoting && this.enabledAdmins() <= 1) throw failure('至少需要保留一个启用的管理员', 409);
    if (sets.length) {
      sets.push('updated_at = ?'); values.push(now());
      try { this.sql(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, Number(id)); }
      catch (error) { if (/UNIQUE/i.test(error.message)) throw failure('用户名已存在', 409); throw error; }
    }
    if (changes.disabled === true) this.revokeUser(id);
    return this.get(id);
  }
  remove(id) {
    const row = this.row(id);
    if (!row) throw failure('User not found', 404);
    if (row.role === 'admin' && !row.disabled && this.enabledAdmins() <= 1) throw failure('至少需要保留一个启用的管理员', 409);
    this.sql('DELETE FROM users WHERE id = ?').run(Number(id));
  }
  async setPassword(id, password, keepTokenHash) {
    checkPassword(password);
    if (!this.row(id)) throw failure('User not found', 404);
    const hash = await hashPassword(password);
    this.sql('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now(), Number(id));
    if (keepTokenHash) this.sql('DELETE FROM auth_tokens WHERE user_id = ? AND token_hash <> ?').run(Number(id), keepTokenHash);
    else this.revokeUser(id);
  }
  async checkOwnPassword(id, password) {
    const row = this.row(id);
    return !!row && typeof password === 'string' && await verifyPassword(password, row.password_hash);
  }

  // ----- grants -----
  grants(id) { return this.sql('SELECT session_key FROM user_sessions WHERE user_id = ? ORDER BY session_key').all(Number(id)).map(row => row.session_key); }
  isGranted(id, key) { return !!this.sql('SELECT 1 AS x FROM user_sessions WHERE user_id = ? AND session_key = ?').get(Number(id), key); }
  setGrants(id, keys) {
    keys = checkKeys(keys);
    if (!this.row(id)) throw failure('User not found', 404);
    const time = now();
    this.transaction(() => {
      this.sql('DELETE FROM user_sessions WHERE user_id = ?').run(Number(id));
      for (const key of keys) this.sql('INSERT INTO user_sessions (user_id, session_key, granted_at) VALUES (?, ?, ?)').run(Number(id), key, time);
    });
    return this.grants(id);
  }
  forgetSession(key) { this.sql('DELETE FROM user_sessions WHERE session_key = ?').run(key); }
  /** Ordinary users currently granted this session (admins always see everything and are omitted). */
  grantees(key) {
    if (typeof key !== 'string' || !SESSION_KEY.test(key)) throw failure('Invalid session', 400);
    return this.sql(`SELECT u.id, u.username, u.role, u.disabled, u.display_name, u.avatar_url, u.auth_provider
      FROM user_sessions g JOIN users u ON u.id = g.user_id
      WHERE g.session_key = ? ORDER BY u.username COLLATE NOCASE`).all(key).map(row => this.publicUser(row));
  }
  /**
   * Replace who may use this session. Only non-admin user ids are stored; admins already see all sessions.
   * Other sessions granted to those users are left alone.
   */
  setSessionUsers(key, userIds) {
    if (typeof key !== 'string' || !SESSION_KEY.test(key)) throw failure('Invalid session', 400);
    if (!Array.isArray(userIds) || userIds.length > 5000) throw failure('Invalid users', 400);
    const ids = [...new Set(userIds.map(id => Number(id)))];
    if (ids.some(id => !Number.isInteger(id) || id < 1)) throw failure('Invalid users', 400);
    const time = now();
    this.transaction(() => {
      this.sql('DELETE FROM user_sessions WHERE session_key = ?').run(key);
      for (const id of ids) {
        const row = this.row(id);
        if (!row) throw failure('User not found', 404);
        if (row.role === 'admin') continue; // admins do not need a grant row
        this.sql('INSERT INTO user_sessions (user_id, session_key, granted_at) VALUES (?, ?, ?)').run(id, key, time);
      }
    });
    return this.grantees(key);
  }

  // ----- login tokens -----
  async login(username, password) {
    const key = String(username || '').toLowerCase();
    const recent = (this.failures.get(key) || []).filter(time => Date.now() - time < 15 * 60 * 1000);
    if (recent.length >= 10) throw failure('登录失败次数过多，请 15 分钟后再试', 429);
    const row = typeof username === 'string' && username.length <= 64 ? this.sql('SELECT * FROM users WHERE username = ?').get(username) : null;
    dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex'));
    const ok = await verifyPassword(typeof password === 'string' ? password.slice(0, 256) : '', row?.password_hash || dummyHash) && !!row;
    if (!ok || row.disabled) {
      if (this.failures.size > 10000) this.failures.clear();
      recent.push(Date.now()); this.failures.set(key, recent);
      throw failure(ok ? '账号已停用' : '用户名或密码错误', 401);
    }
    this.failures.delete(key);
    const token = this.issue(row.id);
    this.sql('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), Number(row.id));
    return { ...token, user: this.publicUser(this.row(row.id)) };
  }

  uniqueFeishuUsername(name, openId) {
    const base = sanitizeFeishuUsername(name, openId);
    let candidate = base;
    for (let n = 0; n < 64; n++) {
      if (!this.sql('SELECT 1 AS x FROM users WHERE username = ?').get(candidate)) return candidate;
      const suffix = `_${n + 1}`;
      candidate = `${base.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
    }
    return `fs_${crypto.randomBytes(8).toString('hex')}`.slice(0, 32);
  }

  /** Find or create a Feishu user (always role=user on create), then issue an rs_ token. */
  async loginOrCreateFeishu({ open_id, union_id, name, en_name, avatar_url }) {
    const openId = String(open_id || '').trim();
    if (!openId || openId.length > 128) throw failure('缺少飞书 open_id', 400);
    const display = String(name || en_name || '').trim().slice(0, 64) || '飞书用户';
    const avatar = String(avatar_url || '').startsWith('https://') ? String(avatar_url).slice(0, 500) : '';
    const union = String(union_id || '').trim().slice(0, 128);
    const time = now();
    let row = this.sql('SELECT * FROM users WHERE feishu_open_id = ?').get(openId);
    if (row) {
      if (row.disabled) throw failure('账号已停用', 403);
      this.sql('UPDATE users SET avatar_url = ?, display_name = ?, feishu_union_id = CASE WHEN ? <> \'\' THEN ? ELSE feishu_union_id END, last_login_at = ?, updated_at = ? WHERE id = ?')
        .run(avatar || row.avatar_url || '', display, union, union, time, time, Number(row.id));
    } else {
      const username = this.uniqueFeishuUsername(display, openId);
      const hash = feishuUnusableHash();
      try {
        const id = Number(this.transaction(() => {
          return this.sql(`INSERT INTO users (username, password_hash, role, disabled, created_at, updated_at, last_login_at, avatar_url, feishu_open_id, feishu_union_id, display_name, auth_provider)
            VALUES (?, ?, 'user', 0, ?, ?, ?, ?, ?, ?, ?, 'feishu')`)
            .run(username, hash, time, time, time, avatar, openId, union, display).lastInsertRowid;
        }));
        row = this.row(id);
      } catch (error) {
        if (/UNIQUE/i.test(error.message)) {
          // Race: another login created the same open_id; retry as update.
          row = this.sql('SELECT * FROM users WHERE feishu_open_id = ?').get(openId);
          if (!row) throw failure('用户名已存在', 409);
          if (row.disabled) throw failure('账号已停用', 403);
          this.sql('UPDATE users SET avatar_url = ?, display_name = ?, last_login_at = ?, updated_at = ? WHERE id = ?')
            .run(avatar || row.avatar_url || '', display, time, time, Number(row.id));
        } else throw error;
      }
    }
    const token = this.issue(row.id);
    return { ...token, user: this.publicUser(this.row(row.id)) };
  }

  issue(id) {
    const token = `rs_${crypto.randomBytes(32).toString('base64url')}`;
    const created = now(), expires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    this.sql('INSERT INTO auth_tokens (token_hash, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)').run(sha256(token), Number(id), created, expires, created);
    if (Math.random() < 0.05) this.sql('DELETE FROM auth_tokens WHERE expires_at < ?').run(created);
    return { token, expires_at: expires };
  }
  // Returns { user, tokenHash } for a valid, unexpired token of an enabled user.
  authenticate(token) {
    if (typeof token !== 'string' || !token.startsWith('rs_') || token.length > 100) return null;
    const hash = sha256(token);
    const row = this.sql('SELECT t.expires_at, t.last_used_at, u.* FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?').get(hash);
    if (!row || row.disabled || Date.parse(row.expires_at) <= Date.now()) return null;
    if (Date.now() - Date.parse(row.last_used_at || 0) > 60000) this.sql('UPDATE auth_tokens SET last_used_at = ? WHERE token_hash = ?').run(now(), hash);
    return { user: this.publicUser(row), tokenHash: hash };
  }
  revoke(tokenHash) { this.sql('DELETE FROM auth_tokens WHERE token_hash = ?').run(tokenHash); }
  revokeUser(id) { this.sql('DELETE FROM auth_tokens WHERE user_id = ?').run(Number(id)); }
  activeTokens(id) { return Number(this.sql('SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND expires_at > ?').get(Number(id), now()).n); }
}

module.exports = { Users, hashPassword, verifyPassword, TOKEN_TTL_MS };
