'use strict';

// Exercise the handler and fake CLI protocol in VMs without sockets or subprocesses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { newThread } = require('./link-helper');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-in-process-'));
const originalEnv = { ...process.env };
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const wrapper = path.join(temp, 'codex');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(__dirname, 'fake-codex.js'))} "$@"\n`, { mode: 0o755 });
Object.assign(process.env, {
  CODEX_APP_SERVER_SOCK: path.join(temp, 'missing.sock'), WEBHOOK_TOKEN: 'test-secret', DATA_DIR: path.join(temp, 'data'), WORK_DIR: path.join(temp, 'work'),
  UPLOAD_DIR: path.join(temp, 'uploads'), MAX_FILE_BYTES: '1024', MAX_FILES: '5', CONSOLE_UI: 'legacy',
  LOG_DIR: path.join(temp, 'logs'), CODEX_BIN: wrapper, CODEX_TIMEOUT_MS: '500',
  MAX_CONCURRENCY: '2', FAKE_CODEX_STATE: path.join(temp, 'state'), CODEX_HOME: path.join(temp, 'codex-home'), CODEX_MODEL: 'test-model', EXPECT_CODEX_MODEL: 'test-model',
});
const callbacks = [];
const children = new Map();
let nextPid = 10000;
let handler;
function simulatedSpawn(bin, args, options) {
  assert.equal(bin, wrapper);
  const child = new EventEmitter();
  child.pid = nextPid++;
  children.set(child.pid, child);
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.close = code => {
    if (!children.delete(child.pid)) return;
    child.emit('close', code);
  };
  child.stdin.end = message => queueMicrotask(() => {
    let ended, keepAlive = false;
    const input = new EventEmitter();
    input.setEncoding = () => {};
    const on = input.on.bind(input);
    input.on = (event, listener) => { if (event === 'end') ended = listener; else on(event, listener); return input; };
    const fakeProcess = {
      argv: [process.execPath, path.join(__dirname, 'fake-codex.js'), ...args], env: process.env,
      cwd: () => options.cwd, stdin: input, stdout: { write: text => child.stdout.emit('data', text) },
      exitCode: 0, exit: code => { fakeProcess.exitCode = code; throw new Error('fake exit'); },
    };
    const context = vm.createContext({
      require, process: fakeProcess, setTimeout,
      setInterval: () => { keepAlive = true; },
      console: { error: text => child.stderr.emit('data', Buffer.from(text + '\n')) },
    });
    try {
      vm.runInContext(fs.readFileSync(path.join(__dirname, 'fake-codex.js'), 'utf8'), context);
      input.emit('data', message);
      Promise.resolve(ended()).then(() => { if (!keepAlive) child.close(fakeProcess.exitCode); }).catch(error => {
        child.stderr.emit('data', Buffer.from(error.message));
        child.close(fakeProcess.exitCode || 1);
      });
    } catch (error) {
      child.stderr.emit('data', Buffer.from(error.message));
      child.close(fakeProcess.exitCode || 1);
    }
  });
  return child;
}
function load() {
  const context = vm.createContext({
    __dirname: path.resolve(__dirname, '..'),
    require: name => name === 'node:http' ? { createServer: callback => { handler = callback; return { listen() {} }; } } : name === 'node:child_process' ? { spawn: simulatedSpawn } : name === './lib/appserver' ? require('../lib/appserver') : name === './lib/attachments' ? require('../lib/attachments') : name === './lib/users' ? require('../lib/users') : name === './lib/settings' ? require('../lib/settings') : name === './lib/feishu' ? require('../lib/feishu') : name === './lib/media' ? require('../lib/media') : require(name),
    process: { env: process.env, exit: process.exit, kill: pid => children.get(-pid)?.close(null) }, Buffer, setTimeout, clearTimeout, AbortSignal,
    console: { log() {}, error: console.error },
    fetch: async (url, options) => { callbacks.push(JSON.parse(options.body)); return { ok: true }; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), context);
}
const linkedKeys = new Map();
async function request(url, body, auth = 'Bearer test-secret', method = body === undefined ? 'GET' : 'POST', contentType) {
  const multipartKey = Buffer.isBuffer(body) && /name="session"\r\n\r\n([^\r]+)\r\n/.exec(body.toString('latin1'))?.[1];
  if (multipartKey && method === 'POST' && auth === 'Bearer test-secret' && !linkedKeys.has(multipartKey)) {
    linkedKeys.set(multipartKey, rawRequest(`/api/sessions/${encodeURIComponent(multipartKey)}`, { codex_session_id: newThread(process.env.CODEX_HOME) }, auth, 'PUT'));
    await linkedKeys.get(multipartKey);
  }
  if (method === 'POST' && (url === '/webhook' || url === '/api/send') && auth === 'Bearer test-secret' && body && !Buffer.isBuffer(body) && typeof body.session === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(body.session) && body.codex_session_id === undefined && !body.__noLink) {
    if (!linkedKeys.has(body.session)) linkedKeys.set(body.session, rawRequest(`/api/sessions/${encodeURIComponent(body.session)}`, { codex_session_id: newThread(process.env.CODEX_HOME) }, auth, 'PUT'));
    await linkedKeys.get(body.session);
  }
  if (body && body.__noLink) { body = { ...body }; delete body.__noLink; }
  // The shared /webhook is retired: send through the session's own hook (URL + key). Requests that
  // cannot name a valid session go to /api/send, which applies the same validation.
  const hookRoute = /^\/webhook(\/queue|\/steer)?$/.exec(url);
  if (hookRoute && method === 'POST' && auth === 'Bearer test-secret') {
    const key = multipartKey || (body && !Buffer.isBuffer(body) ? body.session : undefined);
    const hook = typeof key === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(key) ? await rawRequest(`/api/sessions/${encodeURIComponent(key)}/webhook`, undefined, auth) : null;
    if (hook?.status === 200) {
      if (body && !Buffer.isBuffer(body)) { body = { ...body, ...(hookRoute[1] ? { mode: hookRoute[1].slice(1) } : {}) }; delete body.session; }
      return rawRequest(hook.body.webhook.path, body, `Bearer ${hook.body.webhook.secret}`, method, contentType);
    }
    url = '/api/send';
  }
  return rawRequest(url, body, auth, method, contentType);
}
function rawRequest(url, body, auth = 'Bearer test-secret', method = body === undefined ? 'GET' : 'POST', contentType) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    Object.assign(req, { url, method, headers: { authorization: auth, ...(contentType ? { 'content-type': contentType } : {}) } });
    const chunks = [];
    const res = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    res.writeHead = function(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; };
    res.on('finish', () => {
      const data = Buffer.concat(chunks), type = res.headers['Content-Type'];
      resolve({ status: res.status, body: type.startsWith('application/json') ? JSON.parse(data) : type.startsWith('text/html') ? data.toString() : data, headers: res.headers });
    });
    handler(req, res).catch(reject);
    queueMicrotask(() => {
      if (body !== undefined) req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  });
}
async function settleHook(accepted, userText) {
  if (accepted.status !== 202 || !accepted.body?.request_id) return accepted;
  const requestId = accepted.body.request_id, session = accepted.body.session;
  for (let i = 0; i < 400; i++) {
    const logs = (await request('/api/requests?limit=500')).body.requests;
    const done = logs.find(e => e.request_id === requestId);
    if (done) {
      if (!done.ok) return { status: done.status, body: { error: done.error, session } };
      const hist = (await request(`/api/sessions/${encodeURIComponent(session)}/history?limit=200`)).body.history || [];
      const assist = [...hist].reverse().find(e => e.role === 'assistant' && e.request_id === requestId)
        || hist.slice(Math.max(0, hist.findIndex(e => e.role === 'user' && (e.request_id === requestId || e.text === userText)))).find(e => e.role === 'assistant');
      return { status: 200, body: { reply: assist?.text, session, request_id: requestId, id: accepted.body.id, mode: accepted.body.mode, codex_session_id: assist?.codex_session_id, steered: accepted.body.status === 'steered', ...(accepted.body.steer_fallback ? { steer: accepted.body.steer_fallback } : {}) } };
    }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`hook job ${requestId} did not finish`);
}
async function post(body) {
  const accepted = await request('/webhook', body);
  return body.callback_url ? accepted : settleHook(accepted, body.message);
}
async function main() {
  load();
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/sessions', undefined, 'bad')).status, 401);
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/')).status, 404);
  for (const route of ['/console', '/console/']) {
    const page = await request(route, undefined, '');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('会话'));
    assert.ok(!page.body.includes(process.env.WEBHOOK_TOKEN));
    assert.equal(page.headers['Cache-Control'], 'no-store');
    assert.equal(page.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.ok(page.headers['Content-Security-Policy'].includes("frame-ancestors 'none'"));
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)[1];
    new vm.Script(script); // Check browser JavaScript syntax, without a DOM dependency.
  }
  for (const [route, method] of [['/api/whoami', 'GET'], ['/api/sessions', 'GET'], ['/api/sessions/one/history', 'GET'], ['/api/sessions/one', 'DELETE'], ['/api/send', 'POST'], ['/api/requests', 'GET'], ['/api/stats', 'GET']]) {
    const result = await request(route, undefined, '', method);
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'Unauthorized');
  }
  assert.equal((await request('/api/whoami')).body.ok, true);
  assert.equal((await request('/api/whoami')).body.auth, 'token');
  const consoleReply = await request('/api/send', { session: 'console:key', message: '<script>alert(1)</script>' });
  assert.equal(consoleReply.status, 200);
  const localHistory = (await request('/api/sessions/console%3Akey/history?limit=200')).body;
  assert.equal(localHistory.source, 'local', 'missing socket falls back to persisted relay history');
  assert.equal(localHistory.session, 'console:key');
  const consoleHistory = localHistory.history;
  assert.equal(consoleHistory.length, 2);
  assert.equal(consoleHistory[0].source, 'console');
  assert.equal(consoleHistory[0].text, '<script>alert(1)</script>');
  assert.equal(consoleHistory[1].role, 'assistant');
  assert.equal(consoleHistory[0].request_id, consoleHistory[1].request_id);
  assert.equal(typeof consoleHistory[1].duration_ms, 'number');
  assert.equal((await request('/api/sessions/console%3Akey/history?limit=1')).body.history.length, 1);
  for (const key of ['%2Fetc', '%ZZ', '..%2Fbad']) assert.equal((await request('/api/sessions/'+key+'/history')).status, 400);
  assert.equal((await request('/api/requests?limit=nope')).status, 400);
  assert.equal((await request('/api/sessions/console%3Akey/history?limit=0')).status, 400);
  assert.equal((await request('/api/send', { session: 'bad/key', message: 'hi' })).status, 400);
  assert.equal((await request('/api/send', { session: 'console-bind', message: 'bound', codex_session_id: consoleReply.body.codex_session_id })).status, 200);
  const firstBusy = request('/api/send', { session: 'busy', message: 'delay:100:busy' });
  const nextBusy = request('/api/send', { session: 'busy', message: 'next' });
  await new Promise(resolve => setTimeout(resolve, 10));
  const busy = (await request('/api/sessions')).body.sessions.find(s => s.key === 'busy');
  assert.equal(busy.status, 'running');
  assert.equal(busy.queued, 1);
  assert.equal((await request('/api/sessions/busy', undefined, undefined, 'DELETE')).status, 409);
  const busyStats = (await request('/api/stats')).body;
  assert.equal(busyStats.running, 1); assert.equal(busyStats.queued, 1);
  await Promise.all([firstBusy, nextBusy]);
  const persistedFile = path.join(temp, 'data/history/console_key.jsonl');
  assert.ok(fs.existsSync(persistedFile));
  assert.equal((await request('/api/sessions/console%3Akey', undefined, undefined, 'DELETE')).status, 200);
  assert.ok(!fs.existsSync(persistedFile));
  assert.ok(fs.existsSync(path.join(temp, 'work/console_key')));
  assert.equal((await request('/sessions')).body.sessions['console:key'], undefined);
  assert.equal((await request('/api/sessions/console%3Akey', undefined, undefined, 'DELETE')).status, 404);
  assert.equal((await post({ session: '../bad', message: 'hi' })).status, 400);
  assert.equal((await post({ session: 'large', message: 'x'.repeat(1024 * 1024) })).status, 413);
  const one = await post({ session: 'one', message: 'hello' });
  assert.equal(one.status, 200, JSON.stringify(one));
  assert.equal(one.body.reply, 'echo:hello|history:1');
  const two = await post({ session: 'one', message: 'again' });
  assert.equal(two.body.codex_session_id, one.body.codex_session_id);
  assert.equal(two.body.reply, 'echo:again|history:2');
  const webhookHistory = (await request('/api/sessions/one/history')).body.history;
  assert.equal(webhookHistory.length, 4);
  assert.equal(webhookHistory[0].source, 'webhook');
  const bound = await post({ session: 'bound', message: 'bound', codex_session_id: one.body.codex_session_id });
  assert.equal(bound.body.reply, 'echo:bound|history:3');
  const ordered = await Promise.all(['delay:100:first', 'second', 'third'].map(message => post({ session: 'queue', message })));
  ordered.forEach((result, i) => {
    assert.equal(result.status, 200);
    assert.ok(result.body.reply.endsWith(`history:${i + 1}`));
    assert.equal(result.body.codex_session_id, ordered[0].body.codex_session_id);
  });
  const started = Date.now();
  const parallel = await Promise.all([1, 2, 3].map(i => post({ session: `parallel${i}`, message: 'delay:150:test' })));
  assert.ok(parallel.every(result => result.status === 200));
  assert.ok(Date.now() - started >= 300);
  for (const [message, status, error] of [['__exit__', 500, 'fake stderr failure'], ['__error__', 500, 'fake event failure'], ['__turn_failed__', 500, 'fake turn failure'], ['__timeout__', 504, '响应超时']]) {
    const result = await post({ session: 'fail', message });
    assert.equal(result.status, status);
    assert.ok(result.body.error.includes(error), result.body.error);
    if (status === 409) {
      assert.ok(result.body.error.length < 160);
      assert.ok(!result.body.error.includes('thread-store conflict'));
      assert.ok(!result.body.error.includes('-32600'));
    }
  }
  const failedHistory = (await request('/api/sessions/fail/history')).body.history;
  assert.equal(failedHistory.filter(e => e.role === 'error').length, 4);
  // A thread held by another writer is not an error: the message stays queued and is sent once it is free.
  const held = await post({ session: 'held', message: '__active_writer_once__:held' });
  assert.equal(held.status, 200);
  assert.equal(held.body.reply, 'echo:__active_writer_once__:held|history:1');
  const heldHistory = (await request('/api/sessions/held/history')).body.history;
  assert.equal(heldHistory.filter(e => e.role === 'error').length, 0);
  assert.equal(heldHistory.filter(e => e.role === 'user').length, 1);
  // Webhook messages that arrive while a turn runs are sent together as one turn.
  const firstHook = post({ session: 'hookbatch', message: 'delay:400:a' });
  await new Promise(resolve => setTimeout(resolve, 120));
  const restHooks = [];
  for (const message of ['b', 'c', 'd']) { restHooks.push(await request('/webhook', { session: 'hookbatch', message })); }
  assert.ok((await firstHook).body.reply.endsWith('history:1'));
  const batched = await Promise.all(restHooks.map((accepted, i) => settleHook(accepted, ['b', 'c', 'd'][i])));
  assert.ok(batched.every(result => result.status === 200));
  const batchHistory = (await request('/api/sessions/hookbatch/history')).body.history;
  const batchReplies = batchHistory.filter(e => e.role === 'assistant');
  assert.equal(batchReplies.length, 2);
  assert.ok(batchReplies[1].text.includes('b') && batchReplies[1].text.includes('c') && batchReplies[1].text.includes('d'));
  assert.ok(batchReplies[1].text.endsWith('history:2'));
  assert.equal((await post({ session: 'fail', message: 'recovered' })).status, 200);
  assert.equal((await post({ session: 'output', message: '__output__' })).body.reply, 'echo:__output__|history:1');
  assert.equal((await post({ session: 'fallback', message: '__fallback__' })).body.reply, 'echo:__fallback__|history:1');
  const immediateStarted = Date.now();
  const immediate = await request('/webhook', { session: 'immediate', message: 'delay:300:slow' });
  assert.equal(immediate.status, 202, JSON.stringify(immediate));
  assert.equal(immediate.body.accepted, true);
  assert.ok(immediate.body.request_id);
  assert.ok(Date.now() - immediateStarted < 250, 'hook should return before the turn finishes');
  assert.equal((await settleHook(immediate, 'delay:300:slow')).body.reply, 'echo:delay:300:slow|history:1');
  assert.equal((await post({ session: 'callback', message: 'delay:100:callback', callback_url: 'https://example.test/callback' })).status, 202);
  assert.equal(callbacks.length, 0);
  for (let i = 0; i < 100 && !callbacks.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(callbacks[0].reply, 'echo:delay:100:callback|history:1');
  assert.equal((await request('/sessions')).body.sessions.one.messages, 2);
  const logs = (await request('/api/requests?limit=500')).body.requests;
  assert.ok(logs.some(e => e.source === 'console' && e.status === 200));
  assert.ok(logs.some(e => e.source === 'webhook' && e.status === 504 && !e.ok));
  assert.ok(logs.every(e => ['/hook', '/api/send'].includes(e.path) && e.request_id && typeof e.duration_ms === 'number'));
  assert.ok(!JSON.stringify(logs).includes('test-secret'));
  const stats = (await request('/api/stats')).body;
  assert.equal(stats.today.calls, logs.length);
  assert.equal(stats.today.failures, logs.filter(e => !e.ok).length);
  assert.equal(typeof stats.today.avg_duration_ms, 'number');
  assert.equal(stats.running, 0); assert.equal(stats.queued, 0);
  assert.ok(stats.total_sessions > 0); assert.equal(typeof stats.uptime_s, 'number');
  const beforePoll = logs.length;
  await request('/health'); await request('/api/whoami');
  assert.equal((await request('/api/requests?limit=500')).body.requests.length, beforePoll);
  load();
  assert.equal((await request('/api/requests?limit=500')).body.requests.length, beforePoll);
  assert.equal((await request('/api/stats')).body.today.calls, stats.today.calls);
  assert.equal((await request('/api/sessions/one/history')).body.history.length, 4);
  assert.equal((await post({ session: 'one', message: 'restart' })).body.reply, 'echo:restart|history:4');
  for (const session of ['__proto__', '.', '..']) assert.equal((await post({ session, message: 'safe' })).status, 200);
  assert.ok(fs.existsSync(path.join(temp, 'data/history/%2e.jsonl')));
  assert.ok(fs.existsSync(path.join(temp, 'data/history/%2e2e.jsonl')));
  for (const key of ['.', '..', '%2e', '%2e%2e', '%252E', '%252E%252E']) assert.equal((await request('/api/sessions/'+key+'/history')).body.history.length, 2);
  // Seed the history near its retention threshold and verify trimming on append.
  const oneHistory = path.join(temp, 'data/history/one.jsonl');
  fs.writeFileSync(oneHistory, Array.from({ length: 550 }, (_, i) => JSON.stringify({ role: 'user', text: String(i), time: new Date().toISOString() })).join('\n') + '\n');
  await post({ session: 'one', message: 'trim' });
  const trimmed = fs.readFileSync(oneHistory, 'utf8').trim().split('\n');
  assert.ok(trimmed.length <= 550 && trimmed.length >= 500);
  assert.equal(JSON.parse(trimmed.at(-1)).role, 'assistant');
  const logfile = path.join(temp, 'logs/relay.log');
  assert.ok(!fs.readFileSync(logfile, 'utf8').includes('test-secret'));
  fs.writeFileSync(logfile, 'x'.repeat(5 * 1024 * 1024 + 1));
  await request('/health');
  assert.ok(fs.existsSync(logfile + '.1'));
  // Verify both retention caps and daily totals beyond the 500-entry ring.
  const requestsFile = path.join(temp, 'data/requests.jsonl');
  const seed = { ...logs[0], time: new Date().toISOString(), ok: true, duration_ms: 10 };
  fs.writeFileSync(requestsFile, Array.from({ length: 2200 }, (_, i) => JSON.stringify({ ...seed, request_id: 'seed-'+i })).join('\n') + '\n');
  fs.unlinkSync(path.join(temp, 'data/stats.json'));
  load();
  assert.equal((await request('/api/requests?limit=500')).body.requests.length, 500);
  assert.equal((await request('/api/stats')).body.today.calls, 2200);
  await post({ session: 'retention', message: 'hello' });
  assert.equal(fs.readFileSync(requestsFile, 'utf8').trim().split('\n').length, 2000);
  assert.equal((await request('/api/stats')).body.today.calls, 2201);
  load();
  assert.equal((await request('/api/stats')).body.today.calls, 2201);
  assert.equal((await request('/api/requests?limit=1')).body.requests[0].session, 'retention');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  const multipart = Buffer.concat([
    Buffer.from('--upload-boundary\r\nContent-Disposition: form-data; name="session"\r\n\r\nupload:test\r\n--upload-boundary\r\nContent-Disposition: form-data; name="file"; filename="tiny.png"\r\nContent-Type: image/png\r\n\r\n'), png,
    Buffer.from("\r\n--upload-boundary\r\nContent-Disposition: form-data; name=\"files\"; filename*=UTF-8''%E7%AD%86%E8%A8%98.txt\r\nContent-Type: text/plain\r\n\r\nhello attachment\r\n--upload-boundary--\r\n"),
  ]);
  const uploaded = await request('/api/send', multipart, undefined, 'POST', 'multipart/form-data; boundary="upload-boundary"');
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded));
  assert.ok(uploaded.body.reply.includes('[附件 · linebot-relay]'));
  assert.ok(uploaded.body.reply.includes('--- 筆記.txt ---\nhello attachment'));
  const attachmentHistory = (await request('/api/sessions/upload%3Atest/history')).body.history;
  assert.equal(attachmentHistory[0].text, '请查看附件。');
  const files = attachmentHistory[0].attachments;
  assert.equal(files.length, 2);
  assert.equal(files[0].kind, 'image');
  assert.equal(files[1].name, '筆記.txt');
  files.forEach(file => {
    assert.ok(file.path.startsWith(path.join(temp, 'uploads/upload_test/')));
    assert.match(path.basename(file.path), /^\d{8}-\d{6}-[a-f0-9]{4}-/);
    assert.equal(fs.statSync(file.path).mode & 0o777, 0o644);
  });
  assert.equal(fs.statSync(path.dirname(files[0].path)).mode & 0o777, 0o755);
  const fileRoute = file => '/api/files?path='+encodeURIComponent(file);
  assert.equal((await request(fileRoute(files[0].path), undefined, '')).status, 401);
  const served = await request(fileRoute(files[0].path));
  assert.deepEqual(served.body, png);
  assert.equal(served.headers['Content-Type'], 'image/png');
  assert.equal(served.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(served.headers['Cache-Control'], 'private, max-age=3600');
  assert.ok(served.headers['Content-Disposition'].startsWith('inline;'));
  const textFile = await request(fileRoute(files[1].path));
  assert.equal(textFile.body.toString(), 'hello attachment');
  assert.equal(textFile.headers['Content-Type'], 'application/octet-stream');
  assert.ok(textFile.headers['Content-Disposition'].startsWith('attachment;'));
  const outside = path.join(temp, 'outside.txt'); fs.writeFileSync(outside, 'outside');
  assert.equal((await request(fileRoute(outside))).status, 403);
  assert.equal((await request(fileRoute(path.join(temp, 'uploads/../outside.txt')))).status, 403);
  fs.symlinkSync(outside, path.join(temp, 'uploads/escape.txt'));
  assert.equal((await request(fileRoute(path.join(temp, 'uploads/escape.txt')))).status, 403);
  assert.equal((await request(fileRoute('/no-such-attachment'))).status, 404);
  const encoded = await post({session:'base64', files:[{name:'../.notes.txt', content_base64:Buffer.from('encoded text').toString('base64')}]});
  assert.equal(encoded.status, 200); assert.ok(encoded.body.reply.includes('encoded text'));
  const svg = await post({session:'svg', files:[{name:'unsafe.svg', mime:'image/svg+xml', content_base64:Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')}]});
  assert.equal(svg.status, 200);
  const svgFile = (await request('/api/sessions/svg/history')).body.history[0].attachments[0];
  assert.equal(svgFile.kind, 'file');
  assert.equal((await request(fileRoute(svgFile.path))).headers['Content-Type'], 'application/octet-stream');
  for (const url of ['http://127.0.0.1/file', 'http://[::1]/file', 'http://169.254.169.254/latest', 'file:///tmp/file']) {
    assert.equal((await post({session:'ssrf', file_urls:[url]})).status, 400);
  }
  for (const content_base64 of ['!invalid', 'a', 'ab=c']) assert.equal((await post({session:'invalid', files:[{name:'bad',content_base64}]})).status, 400);
  assert.equal((await post({session:'oversize', files:[{name:'large',content_base64:Buffer.alloc(1025).toString('base64')}]})).status, 413);
  assert.equal((await post({session:'too-many', files:Array.from({length:6},()=>({name:'x',content_base64:''}))})).status, 413);
  const tooLargeMultipart = Buffer.concat([Buffer.from('--b\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\n'),Buffer.alloc(1025),Buffer.from('\r\n--b--')]);
  assert.equal((await request('/webhook',tooLargeMultipart,undefined,'POST','multipart/form-data; boundary=b')).status,413);
  assert.equal((await request('/webhook',Buffer.alloc(2*1024*1024),undefined,'POST','multipart/form-data; boundary=b')).status,413);
  console.log('In-process handler and CLI protocol tests passed (simulated transport)');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(temp, { recursive: true, force: true });
});
