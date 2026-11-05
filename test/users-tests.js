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
const { newThread } = require('./link-helper');
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
    DATA_DIR: path.join(dir, 'data'), WORK_DIR: path.join(dir, 'work'), LOG_DIR: path.join(dir, 'logs'), UPLOAD_DIR: path.join(dir, 'uploads'), FAKE_CODEX_STATE: path.join(dir, 'state'), CODEX_HOME: path.join(dir, 'codex-home'), CODEX_TIMEOUT_MS: '5000', ...extra } });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await pause(25);
  }
  const linked = new Map();
  const call = async (auth, route, opts = {}) => {
    const b = opts.body;
    const hookRoute = /^\/webhook(\/queue|\/steer)?$/.exec(route);
    if (opts.method === 'POST' && (hookRoute || route === '/api/send') && b && typeof b.session === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(b.session) && b.codex_session_id === undefined && !opts.noLink && (auth === token || adminTokens.has(auth))) {
      if (!linked.has(b.session)) linked.set(b.session, (fs.existsSync(path.join(dir, 'data', 'sessions.json')) && JSON.parse(fs.readFileSync(path.join(dir, 'data', 'sessions.json'), 'utf8'))[b.session]) ? null
        : raw(token, `/api/sessions/${encodeURIComponent(b.session)}`, { method: 'PUT', body: { codex_session_id: newThread(path.join(dir, 'codex-home')) } }));
      await linked.get(b.session);
    }
    // The shared /webhook is retired: tests that used it now go through the session's own hook.
    if (hookRoute && opts.method === 'POST' && (auth === token || adminTokens.has(auth))) {
      const sessionKey = b?.session ?? opts.form?.get('session');
      const hook = await raw(token, `/api/sessions/${encodeURIComponent(sessionKey)}/webhook`);
      if (hook.status !== 200) return hook;
      const body = b && { ...b, ...(hookRoute[1] ? { mode: hookRoute[1].slice(1) } : {}) };
      if (body) delete body.session;
      return raw(hook.body.webhook.secret, hook.body.webhook.path, { ...opts, body });
    }
    return raw(auth, route, opts);
  };
  const raw = async (auth, route, { method = 'GET', body, form } = {}) => {
    const headers = auth ? { Authorization: `Bearer ${auth}` } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)) });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, body: type.includes('json') ? await response.json() : await response.arrayBuffer() };
  };
  return { base, call, dir };
}
const enc = encodeURIComponent;
const adminTokens = new Set();

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
  const { call, dir, base } = await boot('main', { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-pass-1' });
  assert.equal((await call(null, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'nope-nope' } })).status, 401);
  assert.equal((await call(null, '/api/auth/login', { method: 'POST', body: { username: 'ghost', password: 'nope-nope' } })).status, 401);
  const adminLogin = await call(null, '/api/auth/login', { method: 'POST', body: { username: 'ADMIN', password: 'admin-pass-1' } });
  assert.equal(adminLogin.status, 200, 'usernames are case-insensitive');
  const admin = adminLogin.body.token;
  adminTokens.add(admin);
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
  // Unknown/unlinked sessions are rejected and no Codex thread is created, for every caller.
  const before = fs.existsSync(path.join(dir, 'codex-home', 'sessions')) ? fs.readdirSync(path.join(dir, 'codex-home', 'sessions'), { recursive: true }).length : 0;
  const unknown = await call(token, '/api/send', { method: 'POST', body: { session: 'never-linked', message: 'hi' }, noLink: true });
  assert.equal(unknown.status, 404); assert.match(unknown.body.error, /不会新建会话/);
  assert.equal((await call(token, '/api/sessions/never-linked/webhook')).status, 404, 'no hook for a missing session');

  // Per-session webhooks: own URL + own key; the shared /webhook is retired.
  for (const route of ['/webhook', '/webhook/queue', '/webhook/steer']) {
    const old = await fetch(base + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session: 's1', message: 'old' }) });
    assert.equal(old.status, 410, route); assert.match((await old.json()).error, /已停用/);
  }
  const hook1 = (await call(token, '/api/sessions/s1/webhook')).body.webhook, hook2 = (await call(admin, '/api/sessions/s2/webhook')).body.webhook;
  assert.match(hook1.path, /^\/hook\/[0-9a-f]{24}$/); assert.match(hook1.secret, /^dbk_[A-Za-z0-9_-]{32}$/); assert.notEqual(hook1.path, hook2.path);
  assert.deepEqual((await call(admin, '/api/sessions/s1/webhook')).body.webhook, hook1, 'stable once created');
  const viaHook = await call(hook1.secret, hook1.path, { method: 'POST', body: { message: 'via hook', session: 's2' } });
  assert.equal(viaHook.status, 200); assert.equal(viaHook.body.session, 's1', 'the hook decides the session'); assert.match(viaHook.body.reply, /echo:via hook/);
  assert.equal((await call(hook2.secret, hook1.path, { method: 'POST', body: { message: 'wrong key' } })).status, 401, "another session's key");
  assert.equal((await call(token, hook1.path, { method: 'POST', body: { message: 'admin token' } })).status, 401, 'WEBHOOK_TOKEN is not a hook key');
  assert.equal((await call(hook1.secret, '/hook/' + '0'.repeat(24), { method: 'POST', body: { message: 'x' } })).status, 401);
  assert.equal((await call(hook1.secret, '/api/sessions')).status, 401, 'a hook key opens nothing else');
  assert.equal((await call(hook1.secret, hook1.path, { method: 'POST', body: { message: 'bind', codex_session_id: '01a1a610-0000-7000-8000-00000000abcd' } })).status, 403);
  const hookListed = (await call(admin, '/api/sessions')).body.sessions.find(s => s.key === 's1');
  assert.ok(hookListed && !('hook' in hookListed), 'listing never carries the key');
  assert.ok(!JSON.stringify((await call(token, '/sessions')).body).includes(hook1.secret));
  const rotated = (await call(admin, '/api/sessions/s1/webhook/rotate', { method: 'POST' })).body.webhook;
  assert.equal(rotated.path, hook1.path, 'URL survives a reset'); assert.notEqual(rotated.secret, hook1.secret);
  assert.equal((await call(hook1.secret, hook1.path, { method: 'POST', body: { message: 'old key' } })).status, 401, 'old key dies at once');
  assert.equal((await call(rotated.secret, rotated.path, { method: 'POST', body: { message: 'new key' } })).status, 200);
  // Pause receiving: webhook messages are rejected with 423; the console still sends; only admins toggle.
  assert.equal((await call(admin, '/api/sessions/s1', { method: 'PATCH', body: { paused: 'yes' } })).status, 400);
  const paused = await call(admin, '/api/sessions/s1', { method: 'PATCH', body: { paused: true } });
  assert.equal(paused.status, 200); assert.equal(paused.body.session.paused, true); assert.ok(paused.body.session.paused_at);
  const refused = await call(rotated.secret, rotated.path, { method: 'POST', body: { message: 'while paused' } });
  assert.equal(refused.status, 423); assert.equal(refused.body.error, '该会话已暂停接收'); assert.equal(refused.body.paused, true);
  assert.equal((await call(hook1.secret, rotated.path, { method: 'POST', body: { message: 'bad key' } })).status, 401, 'auth is checked before pause');
  assert.equal((await call(admin, '/api/send', { method: 'POST', body: { session: 's1', message: 'console while paused' } })).status, 200);
  assert.ok((await call(admin, '/api/sessions')).body.sessions.find(s => s.key === 's1').paused);
  assert.equal((await call(admin, '/api/sessions/s1', { method: 'PATCH', body: { paused: false } })).body.session.paused, undefined);
  assert.equal((await call(rotated.secret, rotated.path, { method: 'POST', body: { message: 'resumed' } })).status, 200);
  assert.equal(fs.readdirSync(path.join(dir, 'codex-home', 'sessions'), { recursive: true }).length, before, 'no thread was started');
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, 'data', 'sessions.json'), 'utf8'))['never-linked']);

  // Admin CRUD.
  assert.equal((await call(admin, '/api/users', { method: 'POST', body: { username: 'bad name!', password: 'password-1' } })).status, 400);
  assert.equal((await call(admin, '/api/users', { method: 'POST', body: { username: 'alice', password: 'short' } })).status, 400);
  assert.equal((await call(admin, '/api/users', { method: 'POST', body: { username: 'alice', password: 'password-1', role: 'root' } })).status, 400);
  const alice = (await call(admin, '/api/users', { method: 'POST', body: { username: 'alice', password: 'alice-pass-1', sessions: ['s1'] } })).body.user;
  assert.deepEqual(alice.sessions, ['s1']); assert.equal(alice.role, 'user'); assert.ok(!('can_create' in alice), 'per-user can_create flag is gone');
  assert.equal((await call(admin, '/api/users', { method: 'POST', body: { username: 'Alice', password: 'alice-pass-1' } })).status, 409);
  const bob = (await call(admin, '/api/users', { method: 'POST', body: { username: 'bob', password: 'bob-pass-12', can_create: true } })).body.user;
  assert.ok(bob && !('can_create' in bob), 'a legacy can_create field is ignored');
  const list = (await call(admin, '/api/users')).body.users;
  assert.deepEqual(list.map(user => user.username), ['admin', 'alice', 'bob']);
  assert.ok(list.every(user => !('password_hash' in user)));
  assert.equal((await call(admin, `/api/users/${alice.id}`)).body.user.username, 'alice');
  assert.equal((await call(admin, '/api/users/9999')).status, 404);

  const login = async (username, password) => (await call(null, '/api/auth/login', { method: 'POST', body: { username, password } })).body.token;
  const a = await login('alice', 'alice-pass-1'), b = await login('bob', 'bob-pass-12');
  { const r = await call(a, '/api/sessions/s1', { method: 'PATCH', body: { model: 'x' } }); assert.equal(r.status, 403, 'only admins set model'); }
  assert.equal((await call(a, '/api/sessions/s1', { method: 'PATCH', body: { effort: 'high', service_tier: 'fast' } })).status, 403);
  assert.equal((await call(a, '/api/models')).status, 403);
  { const r = await call(a, '/api/sessions/s1', { method: 'PATCH', body: { paused: true } }); assert.equal(r.status, 403, 'only admins pause'); assert.equal(r.body.error, '仅管理员可以修改会话'); }

  // Normal user: only granted sessions, everywhere.
  const whoA = (await call(a, '/api/whoami')).body;
  assert.equal(whoA.role, 'user'); assert.ok(!('can_create' in whoA)); assert.equal(whoA.auth, 'user');
  assert.deepEqual((await call(a, '/api/sessions')).body.sessions.map(s => s.key), ['s1']);
  assert.deepEqual(Object.keys((await call(a, '/sessions')).body.sessions), ['s1']);
  assert.equal((await call(a, '/api/sessions/s1/history')).status, 200);
  assert.equal((await call(a, '/api/sessions/s2/history')).status, 404);
  assert.equal((await call(a, '/api/sessions/never-made/history')).status, 404);
  assert.equal((await call(a, '/api/send', { method: 'POST', body: { session: 's2', message: 'sneak' } })).status, 404);
  assert.equal((await call(a, '/api/sessions/s1/webhook')).status, 403, 'only admins see a webhook');
  assert.equal((await call(a, '/api/sessions/s1/webhook/rotate', { method: 'POST' })).status, 403);
  const brandNew = await call(a, '/api/send', { method: 'POST', body: { session: 'brand-new', message: 'hi' } });
  assert.equal(brandNew.status, 404); assert.equal(brandNew.body.error, '会话不存在');
  assert.equal((await call(a, '/api/send', { method: 'POST', body: { session: 's1', message: 'bind', codex_session_id: '01a1a610-0000-7000-8000-00000000abcd' } })).status, 403);
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

  // Images referenced by replies are served through signed, grant-checked /api/media URLs.
  const picture = path.join(dir, 'work', 's1', 'out', 'plot.png');
  fs.mkdirSync(path.dirname(picture), { recursive: true });
  fs.writeFileSync(picture, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]));
  fs.symlinkSync('/etc/passwd', path.join(dir, 'work', 's1', 'out', 'link.png'));
  assert.equal((await call(a, '/api/send', { method: 'POST', body: { session: 's1', message: `![plot](${picture}) ![l](${path.join(dir, 'work', 's1', 'out', 'link.png')}) ![up](${path.join(dir, 'work', 's1', 'out', '..', '..', '..', 'data', 'users.db')})` } })).status, 200);
  const replyA = (await call(a, '/api/sessions/s1/history')).body.history.filter(entry => entry.role === 'assistant').at(-1).text;
  const signed = replyA.match(/\]\((\/api\/media\/[^)\s]+)\)/)?.[1];
  assert.ok(signed, replyA);
  assert.equal(replyA.match(/\/api\/media\//g).length, 1, 'symlinks out of the root and ../ traversal are not signed');
  const image = await fetch(base + signed);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [137, 80, 78, 71, 13, 10, 26, 10, 9, 9]);
  assert.equal((await fetch(base + signed.replace(/s=[^&]+/, 's=' + 'A'.repeat(32)))).status, 404, 'bad signature');
  const forged = new URL(base + signed);
  forged.searchParams.set('p', Buffer.from('/etc/passwd').toString('base64url'));
  assert.equal((await fetch(forged)).status, 404, 'path swap breaks the signature');
  forged.searchParams.set('p', new URL(base + signed).searchParams.get('p')); forged.searchParams.set('u', String(bob.id));
  assert.equal((await fetch(forged)).status, 404, 'uid swap breaks the signature');
  // Signed for alice, but the grant is checked at fetch time.
  await call(admin, `/api/users/${alice.id}/sessions`, { method: 'PUT', body: { sessions: [] } });
  assert.equal((await fetch(base + signed)).status, 404, 'revoked grant');
  await call(admin, `/api/users/${alice.id}/sessions`, { method: 'PUT', body: { sessions: ['s1'] } });
  assert.equal((await fetch(base + signed)).status, 200);
  assert.equal((await fetch(base + signed, { method: 'HEAD' })).status, 200);
  assert.equal((await call(b, '/api/sessions/s1/stream')).status, 404, 'no stream without a grant');
  for (const [method, route] of [['GET', '/api/sessions/s1/queue'], ['POST', '/api/sessions/s1/interrupt'], ['DELETE', '/api/sessions/s1/queue/00000000-0000-4000-8000-000000000000']])
    assert.equal((await call(b, route, { method })).status, 404, `no ${method} ${route} without a grant`);
  assert.deepEqual((await call(a, '/api/sessions/s1/queue')).body.queue, []);
  assert.equal((await call(a, '/api/sessions/s1/queue/00000000-0000-4000-8000-000000000000', { method: 'DELETE' })).status, 404);
  assert.equal((await call(a, '/api/sessions/s1/interrupt', { method: 'POST' })).status, 503, 'stop needs the app-server');
  assert.deepEqual(Object.keys((await call(a, '/api/whoami')).body.limits).sort(), ['max_file_bytes', 'max_files', 'max_total_bytes']);

  // Live stream over real HTTP: SSE headers, snapshot, heartbeat.
  const controller = new AbortController();
  const sse = await fetch(`${base}/api/sessions/s1/stream`, { headers: { Authorization: `Bearer ${a}` }, signal: controller.signal });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(sse.headers.get('x-accel-buffering'), 'no');
  const reader = sse.body.getReader();
  let sseText = '';
  const started = Date.now();
  while (!/: ping/.test(sseText) && Date.now() - started < 3000) sseText += Buffer.from((await reader.read()).value || []).toString();
  assert.match(sseText, /event: snapshot\ndata: \{"key":"s1"/);
  assert.match(sseText, /: ping/);
  controller.abort();

  const readSessions = () => JSON.parse(fs.readFileSync(path.join(dir, 'data', 'sessions.json'), 'utf8'));
  // Linking requires an existing Codex thread (exec mode: rollout files under CODEX_HOME).
  const missingLink = await call(admin, '/api/sessions/linkme', { method: 'PUT', body: { codex_session_id: '01a1a610-0000-7000-8000-0000000000ff' } });
  assert.equal(missingLink.status, 404); assert.equal(missingLink.body.error, '没有这个会话 ID');
  assert.equal((await call(admin, '/api/send', { method: 'POST', body: { session: 'linkme', message: 'x', codex_session_id: '01a1a610-0000-7000-8000-0000000000ff' } })).status, 404);
  assert.equal(readSessions().linkme, undefined);
  assert.equal((await call(a, '/api/sessions/s1', { method: 'PUT', body: { codex_session_id: readSessions().s1.codex_session_id } })).status, 403);
  assert.equal((await call(admin, '/api/sessions/linkme', { method: 'PUT', body: { codex_session_id: readSessions().s1.codex_session_id } })).status, 201);
  assert.equal((await call(admin, '/api/sessions/linkme', { method: 'DELETE' })).status, 200);
  assert.equal((await call(admin, '/api/codex/threads')).status, 503, 'picker needs the app-server');
  // Rename and avatar: admin only, stored locally, survive later session rewrites.
  assert.equal((await call(a, '/api/sessions/s1', { method: 'PATCH', body: { name: 'x' } })).status, 403);
  const renamed = await call(admin, '/api/sessions/s1', { method: 'PATCH', body: { name: '  客服一号  ' } });
  assert.equal(renamed.status, 200); assert.equal(renamed.body.session.name, '客服一号'); assert.equal(readSessions().s1.name, '客服一号');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const upload = (token, body) => fetch(`${base}/api/sessions/s1/avatar`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body });
  assert.equal((await upload(a, png)).status, 403);
  assert.equal((await upload(admin, Buffer.from('not an image at all'))).status, 415);
  const uploaded = await (await upload(admin, png)).json();
  assert.match(uploaded.session.avatar_url, /^\/api\/media\//);
  const stored = readSessions().s1.avatar;
  assert.ok(fs.existsSync(path.join(dir, 'data', 'avatars', stored)));
  const listed = (await call(a, '/api/sessions')).body.sessions.find(s => s.key === 's1');
  assert.equal(listed.name, '客服一号'); assert.equal(listed.avatar, undefined);
  const img = await fetch(`${base}${listed.avatar_url}`);
  assert.equal(img.status, 200); assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  assert.equal((await call(admin, '/api/sessions/s1/avatar', { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'data', 'avatars', stored))); assert.equal(readSessions().s1.avatar, undefined);
  assert.equal((await call(admin, '/api/sessions/s1', { method: 'PATCH', body: { name: '' } })).body.session.name, undefined);

  // Only admins create sessions. A normal user can never create one implicitly, not even for a key an
  // admin pre-granted, through any endpoint (JSON send, multipart attachments, webhook, async callback).
  assert.equal((await call(admin, `/api/users/${alice.id}/sessions`, { method: 'PUT', body: { sessions: ['s1', 'pre-granted'] } })).status, 200);
  const sessionsJson = () => JSON.parse(fs.readFileSync(path.join(dir, 'data', 'sessions.json'), 'utf8'));
  const traces = key => [path.join(dir, 'data', 'history', `${key}.jsonl`), path.join(dir, 'work', key), path.join(dir, 'uploads', key)].filter(fs.existsSync);
  for (const [who, key] of [[a, 'pre-granted'], [a, 'never-made'], [b, 'bob-new'], [b, 's1']]) {
    const attempts = [
      ['/api/send', { method: 'POST', body: { session: key, message: 'make it' } }],
    ];
    for (const route of ['/api/send']) {
      const upload = new FormData();
      upload.append('session', key); upload.append('message', 'with file'); upload.append('file', new Blob(['x']), 'x.txt');
      attempts.push([route, { method: 'POST', form: upload }]);
    }
    for (const [route, options] of attempts) {
      const response = await call(who, route, options);
      assert.equal(response.status, 404, `${route} ${key}`); assert.equal(response.body.error, '会话不存在');
    }
    assert.equal((await call(who, `/api/sessions/${enc(key)}/history`)).status, 404);
    assert.equal((await call(who, `/api/sessions/${enc(key)}`, { method: 'DELETE' })).status, 404);
  }
  await pause(100);
  for (const key of ['pre-granted', 'never-made', 'bob-new']) {
    assert.ok(!(key in sessionsJson()), `${key} not created`); assert.deepEqual(traces(key), [], `${key} left no files`);
  }
  assert.deepEqual((await call(a, '/api/sessions')).body.sessions.map(s => s.key), ['s1'], 'a pre-grant alone is not a session');
  assert.deepEqual((await call(admin, '/api/sessions')).body.sessions.map(s => s.key).sort(), ['s1', 's2']);
  assert.equal((await call(a, '/api/sessions/s1', { method: 'DELETE' })).status, 403, 'only admins delete sessions');

  // Admin logins and WEBHOOK_TOKEN still auto-create; once it exists, a pre-granted user can use it.
  assert.equal((await call(admin, '/api/send', { method: 'POST', body: { session: 'pre-granted', message: 'admin creates' } })).status, 200);
  assert.equal((await call(token, '/webhook', { method: 'POST', body: { session: 'tok-new', message: 'token creates' } })).status, 200);
  assert.ok(sessionsJson()['pre-granted'] && sessionsJson()['tok-new']);
  assert.deepEqual((await call(a, '/api/sessions')).body.sessions.map(s => s.key).sort(), ['pre-granted', 's1']);
  assert.equal((await call(a, '/api/send', { method: 'POST', body: { session: 'pre-granted', message: 'now ok' } })).status, 200);
  assert.equal((await call(a, '/api/sessions/tok-new/history')).status, 404);
  for (const key of ['pre-granted', 'tok-new']) assert.equal((await call(admin, `/api/sessions/${key}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await call(admin, `/api/users/${alice.id}`)).body.user.sessions, ['s1'], 'deleting a session drops its grants');

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

  // Migration: a v1 database with the can_create column is upgraded in place and keeps working.
  {
    const { DatabaseSync } = require('node:sqlite');
    const { hashPassword } = require('../lib/users');
    const oldDir = path.join(temp, 'migrate', 'data');
    fs.mkdirSync(oldDir, { recursive: true });
    const old = new DatabaseSync(path.join(oldDir, 'users.db'));
    old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0, can_create INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT)");
    const stamp = new Date().toISOString();
    old.prepare('INSERT INTO users (username, password_hash, role, can_create, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('legacy', await hashPassword('legacy-pass-1'), 'user', 1, stamp, stamp);
    old.prepare('INSERT INTO users (username, password_hash, role, can_create, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('boss', await hashPassword('boss-pass-12'), 'admin', 0, stamp, stamp);
    old.close();
    const { call: callM } = await boot('migrate');
    const legacy = (await callM(null, '/api/auth/login', { method: 'POST', body: { username: 'legacy', password: 'legacy-pass-1' } })).body;
    assert.ok(legacy.token && !('can_create' in legacy.user));
    const made = await callM(legacy.token, '/api/send', { method: 'POST', body: { session: 'legacy-new', message: 'x' } });
    assert.equal(made.status, 404, 'a former can_create user can no longer create sessions');
    const boss = (await callM(null, '/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'boss-pass-12' } })).body.token;
    assert.equal((await callM(boss, '/api/users', { method: 'POST', body: { username: 'fresh', password: 'fresh-pass-1' } })).status, 201);
    const check = new DatabaseSync(path.join(oldDir, 'users.db'));
    assert.ok(!check.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'can_create'), 'can_create column dropped');
    check.close();
  }

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
