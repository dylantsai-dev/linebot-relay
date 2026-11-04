#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node test/attachments-tests.js
node test/console-dist-tests.js
node test/users-tests.js
node test/in-process-tests.js
node test/appserver-tests.js
node test/appserver-tests.js --sockets
node <<'NODE'
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'linebot-relay-'));
const token = crypto.randomBytes(24).toString('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, receiver, diagnostics = '';
async function freePort() {
  const socket = http.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await closed;
}
async function main() {
  const wrapper = path.join(temp, 'codex');
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'test/fake-codex.js'))} "$@"\n`, { mode: 0o755 });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, CODEX_APP_SERVER_SOCK: 'off', WEBHOOK_TOKEN: token, HOST: '127.0.0.1', PORT: String(port), CODEX_BIN: wrapper, DATA_DIR: path.join(temp, 'data'), WORK_DIR: path.join(temp, 'work'), LOG_DIR: path.join(temp, 'logs'), FAKE_CODEX_STATE: path.join(temp, 'state'), MAX_CONCURRENCY: '2', CODEX_TIMEOUT_MS: '1500', CODEX_MODEL: 'fake-model', EXPECT_CODEX_MODEL: 'fake-model' };
  async function start() {
    server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', data => { diagnostics += data; });
    server.stderr.on('data', data => { diagnostics += data; });
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`server exited: ${diagnostics}`);
      try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
      await pause(30);
    }
    throw new Error('server startup timeout');
  }
  async function request(route, options = {}) {
    const response = await fetch(base + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
    return { status: response.status, body: await response.json() };
  }
  const post = body => request('/webhook', { method: 'POST', body: JSON.stringify(body) });
  const ok = async (body, expected) => {
    const response = await post(body);
    assert.equal(response.status, 200, JSON.stringify(response));
    if (expected) assert.equal(response.body.reply, expected);
    return response.body;
  };
  const noToken = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...env, WEBHOOK_TOKEN: '' }, stdio: 'ignore' });
  assert.equal(await new Promise(resolve => noToken.once('exit', resolve)), 1);
  await start();
  assert.deepEqual(await request('/health', { headers: { Authorization: '' } }), { status: 200, body: { ok: true } });
  for (const route of ['/sessions', '/webhook']) {
    assert.equal((await request(route, { method: route === '/webhook' ? 'POST' : 'GET', headers: { Authorization: 'Bearer wrong' } })).status, 401);
  }
  assert.equal((await request('/unknown')).status, 404);
  assert.equal((await request('/')).status, 404);
  for (const route of ['/console', '/console/']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    const html = await response.text();
    assert.ok(!html.includes(token));
    assert.ok(html.includes('Codex Relay'));
  }
  for (const route of ['/api/whoami', '/api/sessions', '/api/requests', '/api/stats', '/api/sessions/example/history', '/api/send']) {
    assert.deepEqual(await request(route, { headers: { Authorization: '' } }), { status: 401, body: { error: 'Unauthorized' } });
  }
  assert.equal((await request('/api/whoami')).body.ok, true);
  assert.equal((await request('/api/whoami')).body.role, 'admin');
  const sent = await request('/api/send', { method: 'POST', body: JSON.stringify({ session: 'console:test', message: 'hello console' }) });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.reply, 'echo:hello console|history:1');
  const history = (await request('/api/sessions/console%3Atest/history')).body.history;
  assert.equal(history[0].source, 'console');
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[0].request_id, history[1].request_id);
  assert.equal((await request('/api/sessions/console%3Atest', { method: 'DELETE' })).status, 200);
  assert.equal((await request('/api/sessions/console%3Atest', { method: 'DELETE' })).status, 404);
  assert.ok(fs.existsSync(path.join(temp, 'work/console_test')));
  assert.ok(!fs.existsSync(path.join(temp, 'data/history/console_test.jsonl')));
  const busySend = request('/api/send', { method: 'POST', body: JSON.stringify({ session: 'console-busy', message: 'delay:400:busy' }) });
  let busy;
  for (let i = 0; i < 40; i++) {
    busy = (await request('/api/sessions')).body.sessions.find(s => s.key === 'console-busy');
    if (busy?.status === 'running') break;
    await pause(10);
  }
  assert.equal(busy.status, 'running');
  assert.equal((await request('/api/sessions/console-busy', { method: 'DELETE' })).status, 409);
  assert.equal((await busySend).status, 200);
  const stats = (await request('/api/stats')).body;
  assert.ok(stats.today.calls >= 2);
  assert.equal(typeof stats.today.avg_duration_ms, 'number');
  assert.equal(stats.running, 0); assert.equal(stats.queued, 0);
  const recent = (await request('/api/requests')).body.requests;
  assert.ok(recent.some(entry => entry.source === 'console' && entry.ok));
  assert.ok(recent.every(entry => entry.path === '/api/send' || entry.path === '/webhook'));
  for (const body of [null, {}, { session: '../escape', message: 'hi' }, { session: 'x', message: '' }, { session: 'x', message: '   ' }, { session: 'x', message: 4 }, { session: 'x', message: 'hi', codex_session_id: 'bad' }, { session: 'x', message: 'hi', callback_url: 'file:///tmp/x' }]) assert.equal((await post(body)).status, 400);
  assert.equal((await request('/webhook', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await post({ session: 'large', message: 'x'.repeat(1024 * 1024) })).status, 413);
  const first = await ok({ session: 'line:one', message: '你好\nsecond line' }, 'echo:你好\nsecond line|history:1');
  assert.ok(fs.statSync(path.join(temp, 'work/line_one')).isDirectory());
  const second = await ok({ session: 'line:one', message: 'again' }, 'echo:again|history:2');
  assert.equal(first.codex_session_id, second.codex_session_id);
  assert.equal((await request('/api/sessions/line%3Aone/history')).body.history[0].source, 'webhook');
  const other = await ok({ session: 'other', message: 'new' });
  assert.notEqual(first.codex_session_id, other.codex_session_id);
  const bound = await ok({ session: 'bound', message: 'bound', codex_session_id: first.codex_session_id }, 'echo:bound|history:3');
  assert.equal(bound.codex_session_id, first.codex_session_id);
  const ordered = await Promise.all([post({ session: 'ordered', message: 'delay:200:first' }), post({ session: 'ordered', message: 'second' }), post({ session: 'ordered', message: 'third' })]);
  ordered.forEach((result, index) => { assert.equal(result.status, 200); assert.ok(result.body.reply.endsWith(`history:${index + 1}`)); assert.equal(result.body.codex_session_id, ordered[0].body.codex_session_id); });
  const began = Date.now();
  const concurrent = await Promise.all([1, 2, 3].map(i => post({ session: `parallel${i}`, message: 'delay:400:parallel' })));
  assert.ok(concurrent.every(result => result.status === 200));
  assert.ok(Date.now() - began >= 800, 'global semaphore limits three jobs to two slots');
  await ok({ session: 'output', message: '__output__' }, 'echo:__output__|history:1');
  await ok({ session: 'fallback', message: '__fallback__' }, 'echo:__fallback__|history:1');
  for (const [prompt, status, error] of [['__exit__', 500, 'fake stderr failure'], ['__error__', 500, 'fake event failure'], ['__turn_failed__', 500, 'fake turn failure'], ['__timeout__', 504, 'Codex timed out']]) {
    const result = await post({ session: 'failures', message: prompt });
    assert.equal(result.status, status);
    assert.ok(result.body.error.includes(error));
  }
  await ok({ session: 'failures', message: 'recovered' }, 'echo:recovered|history:1');
  // Run the callback receiver in its own Node process, just like an external webhook consumer.
  const callbackFile = path.join(temp, 'callbacks.jsonl');
  const callbackPort = await freePort();
  receiver = spawn(process.execPath, ['-e', `const http=require('node:http'),fs=require('node:fs');http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{fs.appendFileSync(process.argv[1],body+'\\n');res.end('ok')})}).listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('ready'));`, callbackFile, String(callbackPort)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => receiver.stdout.once('data', resolve));
  const callback_url = `http://127.0.0.1:${callbackPort}/result`;
  const accepted = await post({ session: 'callback', message: 'delay:300:callback', callback_url });
  assert.deepEqual(accepted, { status: 202, body: { accepted: true, session: 'callback' } });
  assert.ok(!fs.existsSync(callbackFile), '202 arrives before completion');
  assert.equal((await post({ session: 'callback-error', message: '__error__', callback_url })).status, 202);
  let callbacks = [];
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(callbackFile)) callbacks = fs.readFileSync(callbackFile, 'utf8').trim().split('\n').map(JSON.parse);
    if (callbacks.length === 2) break;
    await pause(40);
  }
  assert.equal(callbacks.length, 2);
  assert.equal(callbacks.find(item => item.session === 'callback').reply, 'echo:delay:300:callback|history:1');
  assert.deepEqual(callbacks.find(item => item.session === 'callback-error'), { session: 'callback-error', error: 'fake event failure' });
  const listing = await request('/sessions');
  assert.equal(listing.body.sessions['line:one'].messages, 2);
  assert.equal(listing.body.sessions.bound.codex_session_id, first.codex_session_id);
  assert.ok(listing.body.sessions['line:one'].created_at);
  assert.ok(listing.body.sessions['line:one'].updated_at);
  await stop(server);
  await start();
  await ok({ session: 'line:one', message: 'after restart' }, 'echo:after restart|history:4');
  // Valid special object keys and dot directory names must stay safe.
  await ok({ session: '__proto__', message: 'safe' });
  await ok({ session: '..', message: 'safe' });
  await ok({ session: 'long-log', message: 'z'.repeat(300) });
  const logfile = path.join(temp, 'logs/relay.log');
  const logs = fs.readFileSync(logfile, 'utf8');
  assert.ok(!logs.includes(token));
  for (const line of logs.trim().split('\n')) {
    const entry = JSON.parse(line);
    assert.ok(entry.request_id);
    if (entry.message) assert.ok(entry.message.length <= 200);
    if (entry.reply) assert.ok(entry.reply.length <= 200);
  }
  fs.writeFileSync(logfile, 'x'.repeat(5 * 1024 * 1024 + 1));
  await request('/health');
  assert.ok(fs.existsSync(logfile + '.1'));
  assert.ok(fs.statSync(logfile).size < 1024);
  console.log('All tests passed');
}
main().catch(error => { console.error(error); console.error(diagnostics); process.exitCode = 1; }).finally(async () => {
  await stop(server);
  await stop(receiver);
  fs.rmSync(temp, { recursive: true, force: true });
});
NODE
