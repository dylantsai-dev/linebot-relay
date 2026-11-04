'use strict';
// Users, login tokens, per-session grants and WEBHOOK_TOKEN compatibility against a real server.js
// process (exec transport with the fake Codex CLI; no app-server).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-users-'));
const token = crypto.randomBytes(24).toString('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const wrapper = path.join(temp, 'codex');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(__dirname, 'fake-codex.js'))} "$@"\n`, { mode: 0o755 });
const children = [];
async function freePort() {
  const s = http.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise(resolve => s.close(resolve));
  return port;
}
async function boot(name, extra = {}) {
  const port = await freePort(), dir = path.join(temp, name);
  let output = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', WEBHOOK_TOKEN: token, CODEX_APP_SERVER_SOCK: 'off', CODEX_BIN: wrapper, CONSOLE_UI: 'legacy',
    DATA_DIR: path.join(dir, 'data'), WORK_DIR: path.join(dir, 'work'), LOG_DIR: path.join(dir, 'logs'), UPLOAD_DIR: path.join(dir, 'uploads'), FAKE_CODEX_STATE: path.join(dir, 'state'), CODEX_TIMEOUT_MS: '5000', ...extra } });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await pause(25);
  }
  const call = async (auth, route, { method = 'GET', body, form } = {}) => {
    const headers = auth ? { Authorization: `Bearer ${auth}` } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)) });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, body: type.includes('json') ? await response.json() : await response.arrayBuffer() };
  };
  return { base, call, dir };
}
const enc = encodeURIComponent;

async function main() {
  // ---- bootstrap without seed: WEBHOOK_TOKEN logs in and creates the first admin ----
  {
    const { call } = await boot('bootstrap');
    assert.deepEqual((await call(null, '/api/auth/status')).body, { needs_setup: true });
    const who = (await call(token, '/api/whoami')).body;
    assert.equal(who.auth, 'token'); assert.equal(who.role, 'admin'); assert.equal(who.needs_setup, true); assert.equal(who.user, null);
    assert.equal((await call(token, '/api/auth/setup', { method: 'POST', body: { username: 'x', password: 'short' } })).status, 400);
    const setup = await call(token, '/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'owner-pass-1' } });
    assert.equal(setup.status, 201); assert.match(setup.body.token, /^rs_/); assert.equal(setup.body.user.role, 'admin');
    assert.equal((await call(setup.body.token, '/api/whoami')).body.user.username, 'owner');
    assert.equal((await call(token, '/api/auth/setup', { method: 'POST', body: { username: 'owner2', password: 'owner-pass-1' } })).status, 409);
    assert.equal((await call(setup.body.token, '/api/auth/setup', { method: 'POST', body: { username: 'owner3', password: 'owner-pass-1' } })).status, 403);
    assert.deepEqual((await call(null, '/api/auth/status')).body, { needs_setup: false });
    // The webhook token keeps full access after an admin exists.
    assert.equal((await call(token, '/api/users')).status, 200);
  }

  // ---- seeded admin ----
  const { call, dir } = await boot('main', { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-pass-1' });
  assert.equal((await call(null, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'nope-nope' } })).status, 401);
  assert.equal((await call(null, '/api/auth/login', { method: 'POST', body: { username: 'ghost', password: 'nope-nope' } })).status, 401);
  const adminLogin = await call(null, '/api/auth/login', { method: 'POST', body: { username: 'ADMIN', password: 'admin-pass-1' } });
  assert.equal(adminLogin.status, 200, 'usernames are case-insensitive');
  const admin = adminLogin.body.token;
  assert.equal(adminLogin.body.user.role, 'admin');
  assert.ok(Date.parse(adminLogin.body.expires_at) - Date.now() > 29 * 24 * 3600 * 1000);
  const adminId = adminLogin.body.user.id;
  assert.equal((await call('rs_' + 'x'.repeat(43), '/api/whoami')).status, 401);

  // WEBHOOK_TOKEN backward compatibility: webhook + API with full access.
  for (const session of ['s1', 's2']) {
    const reply = await call(token, '/webhook', { method: 'POST', body: { session, message: `hello ${session}` } });
    assert.equal(reply.status, 200); assert.match(reply.body.reply, /^echo:hello/);
  }
  assert.equal((await call(token, '/sessions')).status, 200);

  // Admin CRUD.
  assert.equal((await call(admin, '/api/users', { method: 'POST', body: { username: 'bad name!', password: 'password-1' } })).status, 400);
  assert.equal((await call(admin, '/api/users', { method: 'POST', body: { username: 'alice', password: 'short' } })).status, 400);
  assert.equal((await call(admin, '/api/users', { method: 'POST', body: { username: 'alice', password: 'password-1', role: 'root' } })).status, 400);
  const alice = (await call(admin, '/api/users', { method: 'POST', body: { username: 'alice', password: 'alice-pass-1', sessions: ['s1'] } })).body.user;
  assert.deepEqual(alice.sessions, ['s1']); assert.equal(alice.role, 'user'); assert.equal(alice.can_create, false);
  assert.equal((await call(admin, '/api/users', { method: 'POST', body: { username: 'Alice', password: 'alice-pass-1' } })).status, 409);
  const bob = (await call(admin, '/api/users', { method: 'POST', body: { username: 'bob', password: 'bob-pass-12', can_create: true } })).body.user;
  assert.equal(bob.can_create, true);
  const list = (await call(admin, '/api/users')).body.users;
  assert.deepEqual(list.map(user => user.username), ['admin', 'alice', 'bob']);
  assert.ok(list.every(user => !('password_hash' in user)));
  assert.equal((await call(admin, `/api/users/${alice.id}`)).body.user.username, 'alice');
  assert.equal((await call(admin, '/api/users/9999')).status, 404);

  const login = async (username, password) => (await call(null, '/api/auth/login', { method: 'POST', body: { username, password } })).body.token;
  const a = await login('alice', 'alice-pass-1'), b = await login('bob', 'bob-pass-12');

  // Normal user: only granted sessions, everywhere.
  const whoA = (await call(a, '/api/whoami')).body;
  assert.equal(whoA.role, 'user'); assert.equal(whoA.can_create, false); assert.equal(whoA.auth, 'user');
  assert.deepEqual((await call(a, '/api/sessions')).body.sessions.map(s => s.key), ['s1']);
  assert.deepEqual(Object.keys((await call(a, '/sessions')).body.sessions), ['s1']);
  assert.equal((await call(a, '/api/sessions/s1/history')).status, 200);
  assert.equal((await call(a, '/api/sessions/s2/history')).status, 404);
  assert.equal((await call(a, '/api/sessions/never-made/history')).status, 404);
  assert.equal((await call(a, '/api/send', { method: 'POST', body: { session: 's2', message: 'sneak' } })).status, 404);
  assert.equal((await call(a, '/webhook', { method: 'POST', body: { session: 's2', message: 'sneak' } })).status, 404);
  assert.equal((await call(a, '/api/send', { method: 'POST', body: { session: 'brand-new', message: 'hi' } })).status, 403);
  assert.equal((await call(a, '/api/send', { method: 'POST', body: { session: 's1', message: 'bind', codex_session_id: '12345678-aaaa' } })).status, 403);
  const sent = await call(a, '/api/send', { method: 'POST', body: { session: 's1', message: 'from alice' } });
  assert.equal(sent.status, 200); assert.match(sent.body.reply, /echo:from alice/);
  assert.equal((await call(a, '/api/sessions/s1', { method: 'DELETE' })).status, 403);
  assert.equal((await call(a, '/api/sessions/s2', { method: 'DELETE' })).status, 404);
  for (const [route, method] of [['/api/users', 'GET'], ['/api/users', 'POST'], [`/api/users/${alice.id}`, 'PATCH'], [`/api/users/${bob.id}`, 'DELETE'], [`/api/users/${alice.id}/sessions`, 'PUT'], [`/api/users/${alice.id}/password`, 'POST'], ['/api/webhook-token', 'GET']]) {
    assert.equal((await call(a, route, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {} })).status, 403, `${method} ${route}`);
  }
  const requestsA = (await call(a, '/api/requests')).body.requests;
  assert.ok(requestsA.length >= 1 && requestsA.every(entry => entry.session === 's1'));
  const statsA = (await call(a, '/api/stats')).body;
  assert.equal(statsA.scope, 'granted'); assert.equal(statsA.total_sessions, 1); assert.ok(statsA.today.calls >= 1);
  const statsAdmin = (await call(admin, '/api/stats')).body;
  assert.equal(statsAdmin.total_sessions, 2); assert.equal(statsAdmin.scope, undefined);
  const tokenResponse = await call(admin, '/api/webhook-token');
  assert.equal(tokenResponse.status, 200); assert.equal(tokenResponse.body.token, token);

  // Attachments are only downloadable from granted sessions.
  const form = new FormData();
  form.append('session', 's1'); form.append('message', 'file'); form.append('file', new Blob(['hello file']), 'note.txt');
  assert.equal((await call(a, '/api/send', { method: 'POST', form })).status, 200);
  const file = (await call(a, '/api/sessions/s1/history')).body.history.find(entry => entry.attachments)?.attachments[0];
  assert.ok(file?.path);
  assert.equal((await call(a, `/api/files?path=${enc(file.path)}`)).status, 200);
  assert.equal((await call(b, `/api/files?path=${enc(file.path)}`)).status, 404);
  assert.equal((await call(admin, `/api/files?path=${enc(file.path)}`)).status, 200);

  // can_create: new sessions are auto-granted; existing ones stay hidden.
  assert.equal((await call(b, '/api/send', { method: 'POST', body: { session: 's1', message: 'sneak' } })).status, 404);
  assert.equal((await call(b, '/api/send', { method: 'POST', body: { session: 'bob-new', message: 'mine' } })).status, 200);
  assert.deepEqual((await call(b, '/api/sessions')).body.sessions.map(s => s.key), ['bob-new']);
  assert.deepEqual((await call(admin, `/api/users/${bob.id}`)).body.user.sessions, ['bob-new']);
  assert.equal((await call(a, '/api/sessions/bob-new/history')).status, 404);
  assert.equal((await call(a, '/api/send', { method: 'POST', body: { session: 'bob-new', message: 'x' } })).status, 404);
  assert.equal((await call(b, '/api/sessions/bob-new', { method: 'DELETE' })).status, 200);
  assert.deepEqual((await call(admin, `/api/users/${bob.id}`)).body.user.sessions, [], 'deleting a session drops its grants');

  // Bulk grants.
  assert.equal((await call(admin, `/api/users/${alice.id}/sessions`, { method: 'PUT', body: { sessions: ['../x'] } })).status, 400);
  assert.deepEqual((await call(admin, `/api/users/${alice.id}/sessions`, { method: 'PUT', body: { sessions: ['s2', 's1', 's1'] } })).body.sessions, ['s1', 's2']);
  assert.deepEqual((await call(a, '/api/sessions')).body.sessions.map(s => s.key).sort(), ['s1', 's2']);
  assert.deepEqual((await call(admin, `/api/users/${alice.id}`, { method: 'PATCH', body: { sessions: [] } })).body.user.sessions, []);
  assert.deepEqual((await call(a, '/api/sessions')).body.sessions, []);

  // Disable / enable, reset password, change own password, logout.
  assert.equal((await call(admin, `/api/users/${alice.id}`, { method: 'PATCH', body: { disabled: true } })).body.user.disabled, true);
  assert.equal((await call(a, '/api/whoami')).status, 401, 'disabling revokes tokens');
  assert.equal((await call(null, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alice-pass-1' } })).status, 401);
  await call(admin, `/api/users/${alice.id}`, { method: 'PATCH', body: { disabled: false } });
  const a2 = await login('alice', 'alice-pass-1');
  assert.equal((await call(admin, `/api/users/${alice.id}/password`, { method: 'POST', body: { password: 'alice-reset-1' } })).status, 200);
  assert.equal((await call(a2, '/api/whoami')).status, 401, 'password reset revokes tokens');
  const a3 = await login('alice', 'alice-reset-1');
  assert.ok(a3);
  assert.equal((await call(a3, '/api/auth/password', { method: 'POST', body: { current_password: 'wrong-pass', new_password: 'alice-own-12' } })).status, 400);
  assert.equal((await call(a3, '/api/auth/password', { method: 'POST', body: { current_password: 'alice-reset-1', new_password: 'alice-own-12' } })).status, 200);
  assert.equal((await call(a3, '/api/whoami')).status, 200, 'own password change keeps the current token');
  assert.equal((await call(token, '/api/auth/password', { method: 'POST', body: { current_password: 'x', new_password: 'y'.repeat(8) } })).status, 400);
  assert.equal((await call(a3, '/api/auth/logout', { method: 'POST' })).status, 200);
  assert.equal((await call(a3, '/api/whoami')).status, 401);

  // Admin guards.
  assert.equal((await call(admin, `/api/users/${adminId}`, { method: 'PATCH', body: { role: 'user' } })).status, 409);
  assert.equal((await call(admin, `/api/users/${adminId}`, { method: 'PATCH', body: { disabled: true } })).status, 409);
  assert.equal((await call(admin, `/api/users/${adminId}`, { method: 'DELETE' })).status, 409);
  assert.equal((await call(token, `/api/users/${adminId}`, { method: 'PATCH', body: { disabled: true } })).status, 409, 'last enabled admin');
  assert.equal((await call(admin, `/api/users/${bob.id}`, { method: 'PATCH', body: { role: 'admin' } })).body.user.role, 'admin');
  assert.deepEqual((await call(b, '/api/sessions')).body.sessions.map(s => s.key).sort(), ['s1', 's2'], 'admins see everything');
  assert.equal((await call(admin, `/api/users/${bob.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(b, '/api/whoami')).status, 401);
  assert.equal((await call(admin, `/api/users/${bob.id}`)).status, 404);

  // Storage: hashed passwords and tokens only.
  const dbFile = path.join(dir, 'data', 'users.db');
  assert.equal(fs.statSync(dbFile).mode & 0o777, 0o600);
  const raw = Buffer.concat([dbFile, `${dbFile}-wal`].filter(fs.existsSync).map(f => fs.readFileSync(f))).toString('latin1');
  for (const secret of ['admin-pass-1', 'alice-own-12', admin.slice(3), token]) assert.ok(!raw.includes(secret), 'no plaintext secrets in users.db');

  // The other SQLite driver, when installed.
  let better = false;
  try { require.resolve('better-sqlite3'); better = true; } catch {}
  if (better) {
    const { call: callB } = await boot('better', { SQLITE_DRIVER: 'better-sqlite3', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-pass-1' });
    const t = (await callB(null, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-1' } })).body.token;
    assert.equal((await callB(t, '/api/users', { method: 'POST', body: { username: 'carol', password: 'carol-pass-1', sessions: ['k'] } })).status, 201);
    assert.deepEqual((await callB(t, '/api/users')).body.users.map(u => u.username), ['admin', 'carol']);
  }
  console.log(`User management tests passed${better ? ' (node:sqlite and better-sqlite3)' : ''}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const child of children) child.kill();
  setTimeout(() => fs.rmSync(temp, { recursive: true, force: true }), 300);
});
