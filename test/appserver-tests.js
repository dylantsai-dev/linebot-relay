'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { FakeAppServer } = require('./fake-appserver');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-appserver-'));
const socketPath = path.join(temp, 'app.sock');
const fake = new FakeAppServer();
const socketMode = process.argv.includes('--sockets');
const clients = [];
let broken = false, handler, relayContext, spawnCount = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class MemoryWebSocket extends EventEmitter {
  constructor() {
    super();
    this.open = false;
    clients.push(this);
    this.deliver = value => { if (this.open) this.emit('message', JSON.stringify(value)); };
    queueMicrotask(() => {
      if (broken) this.emit('error', new Error('ECONNREFUSED'));
      else { this.open = true; this.emit('open'); }
    });
  }
  send(text) {
    if (!this.open) throw new Error('closed');
    queueMicrotask(() => {
      if (this.open) fake.handle(JSON.parse(text), this.deliver, () => this.close());
    });
  }
  close() { if (this.open) { this.open = false; fake.connections.delete(this.deliver); this.emit('close'); } }
}

function appServerClass() {
  if (socketMode) return require('../lib/appserver').AppServer;
  const context = vm.createContext({ require: () => ({ UnixWebSocket: MemoryWebSocket }), module: { exports: {} }, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/appserver.js'), 'utf8'), context);
  return context.module.exports.AppServer;
}

let client;
function loadRelay() {
  const AppServer = appServerClass();
  class TestClient extends AppServer {
    constructor(sock, options) { super(sock, { ...options, backoff: 40, requestTimeout: 100 }); client = this; }
  }
  const env = {
    WEBHOOK_TOKEN: 'test-token', CODEX_APP_SERVER_SOCK: socketPath, CODEX_TIMEOUT_MS: '80', CODEX_MODEL: 'test-model',
    CODEX_HOME: path.join(temp, 'codex-home'), STREAM_HEARTBEAT_MS: '50', UPLOAD_DIR: path.join(temp, 'uploads'), DATA_DIR: path.join(temp, 'data'), WORK_DIR: path.join(temp, 'work'), LOG_DIR: path.join(temp, 'logs'),
  };
  const context = vm.createContext({
    __dirname: path.resolve(__dirname, '..'), Buffer, setTimeout, clearTimeout, setInterval, clearInterval, AbortSignal, URLSearchParams,
    console: { log() {}, error: console.error },
    process: { env },
    require: name => {
      if (name === './lib/appserver') return { AppServer: TestClient, summarizeItem: require('../lib/appserver').summarizeItem };
      if (name === 'node:http') return { createServer: callback => { handler = callback; return { listen() {} }; } };
      if (name === 'node:child_process') return { spawn() { spawnCount++; throw new Error('EXEC_FALLBACK'); } };
      if (name === './lib/attachments') return require('../lib/attachments');
      if (name === './lib/users') return require('../lib/users');
      if (name === './lib/settings') return require('../lib/settings');
      if (name === './lib/feishu') return require('../lib/feishu');
      if (name === './lib/media') return require('../lib/media');
      return require(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), context);
  relayContext = context;
}

function persistedKeys() { try { return JSON.parse(fs.readFileSync(path.join(temp, 'data/sessions.json'), 'utf8')); } catch { return {}; } }
// The relay never starts threads: like the admin would, link a thread that already exists in Codex.
const linkedKeys = new Map();
let seq = 0;
async function post(session, message, codex_session_id, extra = {}) {
  const key = Buffer.isBuffer(extra) ? /name="session"\r\n\r\n([^\r]+)\r\n/.exec(extra.toString('latin1'))?.[1] : session;
  if (!codex_session_id && typeof key === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(key) && !extra.__noLink && !persistedKeys()[key]) {
    if (!linkedKeys.has(key)) {
      let id;
      fake.handle({ id: `pre-${++seq}`, method: 'thread/start', params: {} }, value => { if (value.result?.thread) id = value.result.thread.id; }, () => {});
      linkedKeys.set(key, api('PUT', `/api/sessions/${encodeURIComponent(key)}`, { codex_session_id: id }));
    }
    await linkedKeys.get(key);
  }
  if (extra && extra.__noLink) { extra = { ...extra }; delete extra.__noLink; }
  return rawPost(session, message, codex_session_id, extra);
}
// The shared /webhook is retired: posts go through the session's own hook when it has one, else
// /api/send (binding a key to a thread, or validation cases), which applies the same checks.
async function hookFor(session) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(session)) return null;
  const found = await api('GET', `/api/sessions/${encodeURIComponent(session)}/webhook`);
  return found.status === 200 ? found.body.webhook : null;
}
async function rawPost(session, message, codex_session_id, extra = {}) {
  const key = Buffer.isBuffer(extra) ? /name="session"\r\n\r\n([^\r]+)\r\n/.exec(extra.toString('latin1'))?.[1] : session;
  const hook = codex_session_id ? null : await hookFor(key);
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    Object.assign(req, { url: hook ? hook.path : '/api/send', method: 'POST', headers: { authorization: hook ? `Bearer ${hook.secret}` : 'Bearer test-token', ...(Buffer.isBuffer(extra) ? {'content-type':'multipart/form-data; boundary=app-upload'} : {}) } });
    const res = { headersSent: false,
      writeHead(status) { this.status = status; this.headersSent = true; },
      end(text) { resolve({ status: this.status, body: JSON.parse(text) }); },
    };
    handler(req, res).catch(reject);
    queueMicrotask(() => {
      req.emit('data', Buffer.isBuffer(extra) ? extra : Buffer.from(JSON.stringify({ session, message, ...extra, ...(codex_session_id ? { codex_session_id } : {}) })));
      req.emit('end');
    });
  });
}

async function api(method, route, body) {
  const hookRoute = method === 'POST' && /^\/webhook(\/queue|\/steer)?$/.exec(route);
  if (hookRoute) {
    const hook = await hookFor(body?.session);
    if (hook) {
      const { session, ...rest } = body;
      return rawApi(method, hook.path, { ...rest, ...(hookRoute[1] ? { mode: hookRoute[1].slice(1) } : {}) }, `Bearer ${hook.secret}`);
    }
    route = '/api/send';
  }
  return rawApi(method, route, body);
}
function rawApi(method, route, body, authorization = 'Bearer test-token') {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    Object.assign(req, { url: route, method, headers: { authorization, 'content-type': 'application/json' } });
    const res = { writeHead(status) { this.status = status; }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }); } };
    handler(req, res).catch(reject);
    queueMicrotask(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}

// SSE over a mock response: collects parsed events until closed.
function stream(route) {
  const req = new EventEmitter();
  Object.assign(req, { url: route, method: 'GET', headers: { authorization: 'Bearer test-token' } });
  const events = [], raw = [];
  const res = new EventEmitter();
  Object.assign(res, { destroyed: false, writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(text) {
      raw.push(text);
      for (const block of text.split('\n\n')) {
        const name = block.match(/^event: (.*)$/m)?.[1], data = block.match(/^data: (.*)$/m)?.[1];
        if (name && data) events.push({ name, data: JSON.parse(data) });
      }
      return true;
    },
    end() { this.ended = true; } });
  handler(req, res);
  return { res, events, raw, close: () => req.emit('close') };
}

function get(route) {
  return new Promise((resolve, reject) => {
    const req = { url: route, method: 'GET', headers: { authorization: 'Bearer test-token' } };
    const res = { writeHead(status) { this.status = status; }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }); } };
    handler(req, res).catch(reject);
  });
}

function rawGet(route) {
  return new Promise((resolve, reject) => {
    const { Writable } = require('node:stream');
    let body = '', status, headers;
    const res = new Writable({ write(chunk, _e, cb) { body += chunk; cb(); } });
    res.writeHead = (code, h) => { status = code; headers = h; };
    const end = res.end.bind(res);
    res.end = (text) => { if (text) body += text; end(); };
    res.on('finish', () => resolve({ status, headers, body }));
    handler({ url: route, method: 'GET', headers: {} }, res).catch?.(reject);
  });
}

async function main() {
  if (socketMode) await fake.listen(socketPath);
  else fs.writeFileSync(socketPath, 'socket placeholder');
  // Startup must watch persisted bindings without a relay send to that key.
  let seedId;
  const appFixture = value => { if (value.id === 'seed') seedId = value.result.thread.id; };
  fake.handle({ id: 'seed', method: 'thread/start', params: {} }, appFixture, () => {});
  const savedAt = new Date().toISOString();
  fs.mkdirSync(path.join(temp, 'data'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'data/sessions.json'), JSON.stringify({ seeded: { codex_session_id: seedId, messages: 0, created_at: savedAt, updated_at: savedAt } }));
  loadRelay();
  for (let i = 0; i < 100 && !client.subscribed.has(seedId); i++) await pause(5);
  assert.ok(client.subscribed.has(seedId), 'persisted thread subscribed on startup');
  fake.handle({ id: 'seed-turn', method: 'turn/start', params: { threadId: seedId, input: [{ type: 'text', text: 'from App at startup' }] } }, appFixture, () => {});
  const seeded = (await get('/api/sessions/seeded/history')).body;
  assert.equal(seeded.history[0].source, 'app');
  assert.equal(seeded.history[1].text, 'reply:from App at startup');
  const first = await post('one', 'hello');
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.body.reply, 'reply:hello');
  assert.equal(first.body.transport, 'app-server');
  const threadId = first.body.codex_session_id;
  assert.ok(!fake.requests.some(r => r.method === 'thread/start' && r.params.serviceName), 'relay never starts a Codex thread');
  assert.equal(client.connected, true);
  await assert.rejects(client.request('test/hang', {}, 10), /request timed out/);
  assert.equal(client.pending.size, 0);
  const second = await post('one', 'again');
  assert.equal(second.body.codex_session_id, threadId);
  assert.deepEqual(fake.threads.get(threadId), ['hello', 'again']);
  assert.equal(fake.requests.filter(r => r.method === 'initialize').length, 1);
  assert.equal(fake.requests.filter(r => r.method === 'thread/resume' && r.params.threadId === threadId).length, 1, 'linking subscribes once; sends reuse it');
  // A second connection owns a loaded thread; the relay must still resume it.
  const OtherClient = appServerClass();
  const app = new OtherClient(socketPath);
  await app.connect();
  const externalId = (await app.request('thread/start', {})).thread.id;
  app.subscribed.add(externalId);
  assert.ok(fake.loaded.has(externalId));
  assert.equal((await post('external', 'relay into App', externalId)).body.reply, 'reply:relay into App');
  assert.ok(fake.requests.some(r => r.method === 'thread/resume' && r.params.threadId === externalId));
  let externalHistory = (await get('/api/sessions/external/history')).body;
  assert.equal(externalHistory.source, 'thread');
  assert.equal(externalHistory.history[0].source, 'console', 'bound through /api/send');
  const reads = () => fake.requests.filter(r => r.method === 'thread/read').length;
  const cachedReads = reads();
  await get('/api/sessions/external/history');
  assert.equal(reads(), cachedReads, 'history cache reused until revision changes');
  const appTurn = app.runTurn(externalId, '__app_slow__', 500);
  await pause(10);
  externalHistory = (await get('/api/sessions/external/history')).body;
  assert.equal(externalHistory.running, true);
  assert.equal(externalHistory.history.at(-1).source, 'app');
  assert.equal(externalHistory.history.at(-1).role, 'user');
  assert.equal((await get('/api/sessions')).body.sessions.find(s => s.key === 'external').status, 'running');
  await appTurn;
  externalHistory = (await get('/api/sessions/external/history')).body;
  assert.equal(externalHistory.running, false);
  assert.equal(externalHistory.history.at(-1).text, 'reply:__app_slow__');
  assert.equal(externalHistory.history.at(-2).source, 'app');
  assert.equal((await get('/api/sessions')).body.sessions.find(s => s.key === 'external').messages, 2);
  assert.equal((await get('/sessions')).body.sessions.external.messages, 2);
  assert.equal((await get('/api/sessions/external/history?limit=1')).body.history.length, 1);
  assert.ok(externalHistory.revision > 0);
  fake.failRead = true;
  client.threadState(externalId).revision++;
  assert.equal((await get('/api/sessions/external/history')).body.source, 'local');
  fake.failRead = false;
  app.close();
  const parallel = await Promise.all(['parallel-a', 'parallel-b'].map(key => post(key, key)));
  assert.ok(parallel.every(r => r.status === 200 && r.body.reply === `reply:${r.body.session}`));
  assert.notEqual(parallel[0].body.codex_session_id, parallel[1].body.codex_session_id);
  const ordered = await Promise.all(['first', 'second'].map(text => post('ordered', text)));
  assert.deepEqual(fake.threads.get(ordered[0].body.codex_session_id), ['first', 'second']);
  const init = fake.requests.find(r => r.method === 'initialize');
  assert.equal(init.params.clientInfo.name, 'linebot-relay');
  assert.equal(init.params.capabilities.experimentalApi, true);
  assert.equal(init.params.capabilities.requestAttestation, false);
  assert.ok(!fake.requests.some(r => r.method === 'thread/start' && r.params.serviceName), 'relay never starts a Codex thread');
  const threadStartsBefore = fake.requests.filter(r => r.method === 'thread/start').length;
  const unlinked = await post('never-linked', 'hi', undefined, { __noLink: true });
  assert.equal(unlinked.status, 404); assert.match(unlinked.body.error, /不会新建会话/);
  assert.equal(fake.requests.filter(r => r.method === 'thread/start').length, threadStartsBefore);
  assert.ok(fake.requests.every(r => !('jsonrpc' in r)));
  client.subscribed.delete(threadId);
  fake.loaded.delete(threadId);
  assert.equal((await post('one', 'resume')).status, 200);
  assert.equal(JSON.stringify(fake.requests.find(r => r.method === 'thread/resume' && r.params.threadId === threadId).params), JSON.stringify({ threadId, excludeTurns: true }));
  assert.equal((await post('bound', 'bound', threadId)).body.codex_session_id, threadId);
  assert.equal((await post('one', '__steer__')).body.reply, 'reply:__steer__');
  assert.equal((await post('one', '__no_final__')).body.reply, 'last commentary');
  // Approval / question cards: the turn waits until the console answers each prompt.
  assert.equal((await rawApi('POST', '/api/users', { username: 'helper', password: 'helper-pass-1', role: 'user', sessions: ['one'] })).status, 201);
  assert.equal((await rawApi('POST', '/api/users', { username: 'stranger', password: 'stranger-pass-1', role: 'user', sessions: [] })).status, 201);
  const helperAuth = `Bearer ${(await rawApi('POST', '/api/auth/login', { username: 'helper', password: 'helper-pass-1' })).body.token}`;
  const strangerAuth = `Bearer ${(await rawApi('POST', '/api/auth/login', { username: 'stranger', password: 'stranger-pass-1' })).body.token}`;
  const promptStream = stream('/api/sessions/one/stream');
  let askDone = false;
  const asking = post('one', '__approval__').finally(() => { askDone = true; });
  let cards = [];
  for (let i = 0; i < 200 && cards.length < 5; i++) { await pause(5); cards = (await get('/api/sessions/one/history')).body.prompts || []; }
  assert.equal(cards.length, 5, 'supported requests become cards; the unknown one does not');
  assert.deepEqual(cards.map(c => c.kind).sort(), ['command', 'command', 'file', 'file', 'input']);
  assert.ok(!JSON.stringify(cards).includes('Codex'), 'cards never name the backend');
  const card = (kind, test = () => true) => cards.find(c => c.kind === kind && test(c));
  const v2Command = card('command', c => c.command === 'rm -rf build'), legacyCommand = card('command', c => c.command === 'git push');
  assert.ok(v2Command && legacyCommand);
  assert.equal(v2Command.cwd, '/tmp/work');
  assert.deepEqual(v2Command.decisions, ['accept', 'acceptForSession', 'decline', 'cancel']);
  const patchCard = card('file', c => c.files.length === 2), fileCard = card('file', c => c !== patchCard);
  assert.deepEqual(patchCard.files.map(f => f.path), ['src/a.js', 'src/b.js']);
  const ask = card('input');
  assert.equal(ask.questions[0].id, 'color'); assert.equal(ask.questions[0].options[1].label, 'blue'); assert.equal(ask.questions[0].isOther, true);
  assert.ok(promptStream.events.filter(e => e.name === 'prompt').length >= 5, 'cards are pushed on the stream');
  await pause(120);
  assert.equal(askDone, false, 'a turn waiting on a person does not time out');
  const answer = (c, body, auth = helperAuth) => rawApi('POST', `/api/sessions/one/prompts/${c.id}`, body, auth);
  assert.equal((await answer(v2Command, { decision: 'accept' }, strangerAuth)).status, 404, 'ungranted users cannot answer');
  assert.equal((await answer(fileCard, { decision: 'maybe' })).status, 400);
  assert.equal((await rawApi('POST', '/api/sessions/one/prompts/nope', { decision: 'accept' })).status, 404);
  assert.equal((await answer(v2Command, { decision: 'accept' })).status, 200, 'a granted user can answer');
  assert.equal((await answer(v2Command, { decision: 'accept' })).status, 404, 'answered once only');
  assert.equal((await answer(legacyCommand, { decision: 'acceptForSession' })).status, 200);
  assert.equal((await answer(patchCard, { decision: 'decline' })).status, 200);
  assert.equal((await answer(fileCard, { decision: 'decline' }, 'Bearer test-token')).status, 200);
  assert.equal((await get('/api/sessions/one/history')).body.prompts.length, 1);
  assert.equal((await answer(ask, { answers: { color: 'blue', ignored: 'x' } })).status, 200);
  assert.equal((await asking).body.reply, 'reply:__approval__');
  const replyTo = id => fake.replies.find(r => r.id === id)?.result;
  assert.deepEqual(replyTo('server-item/commandExecution/requestApproval'), { decision: 'accept' });
  assert.deepEqual(replyTo('server-execCommandApproval'), { decision: 'approved_for_session' });
  assert.deepEqual(replyTo('server-applyPatchApproval'), { decision: { denied: { rejection: 'The user declined this request.' } } });
  assert.deepEqual(replyTo('server-item/fileChange/requestApproval'), { decision: 'decline' });
  assert.deepEqual(replyTo('server-item/tool/requestUserInput'), { answers: { color: { answers: ['blue'] } } });
  const unknownReply = fake.replies.find(r => r.id === 'server-unknown/request');
  assert.equal(unknownReply.error.code, -32601, 'unknown server requests are failed at once');
  assert.equal((await get('/api/sessions/one/history')).body.prompts.length, 0);
  await pause(80);
  assert.equal(promptStream.events.filter(e => e.name === 'prompt_resolved').length, 5);
  promptStream.close();
  // History pages: newest first page, then strictly older pages via before=<oldest time>.
  const fullHistory = (await get('/api/sessions/one/history?limit=550')).body;
  assert.equal(fullHistory.has_more, false);
  assert.ok(fullHistory.history.length > 6);
  assert.equal((await get('/api/sessions/one/history')).body.history.length, Math.min(50, fullHistory.history.length), 'default page is 50');
  let pageRoute = '/api/sessions/one/history?limit=3', walked = [], guard = 0;
  for (;;) {
    const page = (await get(pageRoute)).body;
    assert.ok(page.history.length >= 1);
    walked = [...page.history, ...walked];
    if (!page.has_more) break;
    assert.ok(++guard < 100);
    pageRoute = `/api/sessions/one/history?limit=3&before=${encodeURIComponent(page.history[0].time)}`;
  }
  assert.deepEqual(walked.map(e => [e.role, e.time, e.text]), fullHistory.history.map(e => [e.role, e.time, e.text]), 'pages join into the full history');
  assert.equal((await get('/api/sessions/one/history?before=nope')).status, 400);
  for (const [message, error] of [['__failed__', 'recorded failure'], ['__interrupted__', 'Codex turn interrupted']]) {
    const result = await post('one', message);
    assert.equal(result.status, 500);
    assert.equal(result.body.error, error);
  }
  for (const message of ['__timeout__', '__late__']) {
    const result = await post('one', message);
    assert.equal(result.status, 504);
    assert.equal(result.body.error, '响应超时');
    await pause(message === '__late__' ? 100 : 10);
  }
  assert.equal(fake.requests.filter(r => r.method === 'turn/interrupt').length, 2);
  assert.equal((await post('one', '__completed_late__')).status, 504);
  await pause(100);
  assert.equal(fake.requests.filter(r => r.method === 'turn/interrupt').length, 2, 'completed turns must never be interrupted');
  // Thread conversion preserves final phases, timestamps, images, and relay errors.
  const convert = vm.runInContext('threadHistory', relayContext);
  const image = Buffer.from([137,80,78,71,13,10,26,10]);
  const upload = Buffer.concat([
    Buffer.from('--app-upload\r\nContent-Disposition: form-data; name="session"\r\n\r\nimages\r\n--app-upload\r\nContent-Disposition: form-data; name="file"; filename="tiny.png"\r\nContent-Type: application/octet-stream\r\n\r\n'),image,
    Buffer.from('\r\n--app-upload\r\nContent-Disposition: form-data; name="files"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\ninline text\r\n--app-upload--\r\n'),
  ]);
  const uploaded = await post(undefined, undefined, undefined, upload);
  assert.equal(uploaded.status,200,JSON.stringify(uploaded));
  const input = fake.requests.find(r=>r.method==='turn/start'&&r.params.threadId===uploaded.body.codex_session_id).params.input;
  assert.equal(input.length,2); assert.equal(input[1].type,'localImage');
  assert.ok(input[1].path.startsWith(path.join(temp,'uploads/images/')));
  assert.equal(fs.readFileSync(input[1].path).toString('hex'),image.toString('hex'));
  assert.ok(input[0].text.includes('[附件 · linebot-relay]'));
  assert.ok(input[0].text.includes('--- notes.txt ---\ninline text'));
  // Per-session model: listed via model/list (hidden filtered, paginated) and passed on turn/start.
  const listed = await api('GET', '/api/models');
  assert.equal(listed.status, 200, JSON.stringify(listed));
  assert.deepEqual(listed.body.models.map(m => m.id), ['m-a', 'm-b']);
  assert.equal(listed.body.models[0].isDefault, true);
  const usage = await api('GET', '/api/usage');
  assert.equal(usage.status, 200, JSON.stringify(usage));
  assert.equal(usage.body.usage.plan, 'pro');
  assert.equal(usage.body.usage.limit_name, 'Pro');
  assert.equal(usage.body.usage.week.label, '本周');
  assert.equal(usage.body.usage.week.used_percent, 44);
  assert.equal(usage.body.usage.primary.used_percent, 12);
  assert.ok(fake.requests.some(r => r.method === 'account/rateLimits/read'));
  assert.equal((await api('PATCH', '/api/sessions/images', { model: '' })).status, 400);
  const setModel = await api('PATCH', '/api/sessions/images', { model: 'm-b' });
  assert.equal(setModel.status, 200); assert.equal(setModel.body.session.model, 'm-b');
  assert.equal((await post('images', 'with model')).status, 200);
  assert.equal(fake.requests.filter(r => r.method === 'turn/start' && r.params.threadId === uploaded.body.codex_session_id).at(-1).params.model, 'm-b');
  assert.deepEqual(listed.body.models[1].supportedReasoningEfforts.map(e => e.id), ['low', 'high']);
  assert.equal(listed.body.models[1].serviceTiers[0].id, 'fast');
  assert.equal((await api('PATCH', '/api/sessions/images', { effort: 'xhigh' })).status, 400);
  assert.equal((await api('PATCH', '/api/sessions/images', { service_tier: 'slow' })).status, 400);
  const tuned = await api('PATCH', '/api/sessions/images', { effort: 'high', service_tier: 'fast' });
  assert.equal(tuned.status, 200); assert.equal(tuned.body.session.effort, 'high'); assert.equal(tuned.body.session.service_tier, 'fast');
  assert.equal((await post('images', 'tuned')).status, 200);
  { const p = fake.requests.filter(r => r.method === 'turn/start' && r.params.threadId === uploaded.body.codex_session_id).at(-1).params; assert.equal(p.model, 'm-b'); assert.equal(p.effort, 'high'); assert.equal(p.serviceTier, 'fast'); }
  // Access modes: default (unset) = ask; each mode maps onto approvalPolicy / approvalsReviewer / sandboxPolicy.
  { const p = fake.requests.filter(r => r.method === 'turn/start' && r.params.threadId === uploaded.body.codex_session_id).at(-1).params; assert.equal(p.approvalPolicy, 'on-request'); assert.equal(p.approvalsReviewer, 'user'); assert.deepEqual(p.sandboxPolicy, { type: 'workspaceWrite', networkAccess: false }); }
  assert.equal((await api('PATCH', '/api/sessions/images', { approval_mode: 'yolo' })).status, 400);
  for (const [mode, policy, reviewer, sandbox] of [['assist', 'on-request', 'auto_review', { type: 'workspaceWrite', networkAccess: false }], ['full', 'never', 'user', { type: 'dangerFullAccess' }], ['ask', 'on-request', 'user', { type: 'workspaceWrite', networkAccess: false }]]) {
    const r = await api('PATCH', '/api/sessions/images', { approval_mode: mode });
    assert.equal(r.status, 200); assert.equal(r.body.session.approval_mode, mode === 'ask' ? undefined : mode);
    assert.equal((await post('images', 'mode ' + mode)).status, 200);
    const p = fake.requests.filter(q => q.method === 'turn/start' && q.params.threadId === uploaded.body.codex_session_id).at(-1).params;
    assert.equal(p.approvalPolicy, policy); assert.equal(p.approvalsReviewer, reviewer); assert.deepEqual(p.sandboxPolicy, sandbox);
  }
  assert.equal((await api('PATCH', '/api/sessions/images', { approval_mode: null })).body.session.approval_mode, undefined);
  { const c = await api('PATCH', '/api/sessions/images', { effort: null, service_tier: null }); assert.equal(c.body.session.effort, undefined); assert.equal(c.body.session.service_tier, undefined); }
  assert.equal((await api('PATCH', '/api/sessions/images', { model: null })).body.session.model, undefined);
  assert.equal((await post('images', 'no model')).status, 200);
  { const p = fake.requests.filter(r => r.method === 'turn/start' && r.params.threadId === uploaded.body.codex_session_id).at(-1).params; assert.equal(p.model, undefined); assert.equal(p.effort, undefined); assert.equal(p.serviceTier, null); }
  const uploadHistory = (await get('/api/sessions/images/history')).body;
  assert.equal(uploadHistory.source,'thread');
  assert.equal(uploadHistory.history[0].text,'请查看附件。');
  assert.equal(uploadHistory.history[0].source,'webhook');
  assert.equal(uploadHistory.history[0].attachments.length,2,'localImage deduplicated with marker');
  assert.equal(uploadHistory.history[0].attachments[0].size,image.length,'local metadata preserves exact size');
  const base64Turn = await post('base64-input', 'check', undefined, {files:[{name:'image.png',content_base64:image.toString('base64')}]});
  assert.equal(base64Turn.status,200);
  assert.ok(fake.requests.some(r=>r.method==='turn/start'&&r.params.threadId===base64Turn.body.codex_session_id&&r.params.input[1].type==='localImage'));
  const remote = convert({id:'external',turns:[{startedAt:1700000000,status:'completed',items:[{type:'userMessage',content:[{type:'image',url:'https://example.com/image.png'},{type:'localImage',path:'/tmp/picture.png'}]}]}]},[]);
  assert.equal(remote[0].attachments[0].url,'https://example.com/image.png');
  assert.equal(remote[0].attachments[1].path,'/tmp/picture.png');
  const baseTime = 1700000000;
  const iso = offset => new Date((baseTime + offset) * 1000).toISOString();
  const converted = JSON.parse(JSON.stringify(convert({ id: threadId, turns: [
    { startedAt: baseTime, completedAt: baseTime + 1, durationMs: 1000, status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'look' }, { type: 'image' }, { type: 'text', text: 'here' }] },
      { type: 'agentMessage', phase: 'commentary', text: 'hidden' },
      { type: 'agentMessage', phase: 'final_answer', text: 'final one' },
      { type: 'agentMessage', phase: 'final_answer', text: 'final two' },
    ] },
    { startedAt: baseTime + 2, completedAt: baseTime + 3, status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'outside matching window' }] },
      { type: 'agentMessage', text: 'earlier' }, { type: 'agentMessage', text: 'last' },
    ] },
    { startedAt: baseTime + 4, completedAt: baseTime + 5, status: 'failed', error: { message: 'turn failure' }, items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'failure' }] },
    ] },
    { startedAt: baseTime + 6, status: 'failed', items: [] },
    { startedAt: baseTime + 7, status: 'inProgress', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'incomplete' }] },
  ] }, [
    { role: 'user', text: 'look[image]here', source: 'console', time: iso(-180) },
    { role: 'user', text: 'outside matching window', source: 'webhook', time: iso(-179) },
    { role: 'user', text: 'failure', source: 'webhook', time: iso(4), request_id: 'failure-request' },
    { role: 'error', text: 'turn failure', time: iso(5), request_id: 'failure-request' },
    { role: 'error', text: 'relay-side error', time: iso(8) },
  ])));
  assert.equal(converted[0].source, 'console');
  assert.equal(converted[0].time, iso(0));
  assert.deepEqual(converted.filter(e => e.role === 'assistant').map(e => e.text), ['final one', 'final two', 'last']);
  assert.equal(converted[1].duration_ms, 1000);
  assert.equal(converted[1].time, iso(1));
  assert.equal(converted[1].codex_session_id, threadId);
  assert.equal(converted.find(e => e.text === 'outside matching window').source, 'app');
  assert.deepEqual(converted.filter(e => e.role === 'error').map(e => e.text), ['turn failure', '处理失败', 'relay-side error']);
  const cachedThread = client.threadState(externalId);
  await get('/api/sessions');
  const beforeFreshRead = reads();
  await get('/api/sessions');
  assert.equal(reads(), beforeFreshRead, 'list reuses fresh history cache');
  cachedThread.cache.time -= 11000;
  cachedThread.lastReadTime -= 11000;
  await get('/api/sessions');
  assert.equal(reads(), beforeFreshRead + 1, 'list refreshes after ten seconds');
  cachedThread.cache.time -= 31000;
  await get('/api/sessions/external/history');
  assert.equal(reads(), beforeFreshRead + 2, 'history refreshes after thirty seconds');
  fake.hangRead = true;
  cachedThread.revision++;
  const beforeSlowRead = reads();
  const slowStarted = Date.now();
  const slowListings = await Promise.all([get('/api/sessions'), get('/api/sessions')]);
  assert.ok(slowListings.every(r => r.status === 200));
  assert.ok(Date.now() - slowStarted < 3500, 'slow thread read cannot hold up session listings');
  assert.equal(reads(), beforeSlowRead + 1, 'concurrent list requests share one read per thread');
  await pause(10);
  await get('/api/sessions');
  assert.equal(reads(), beforeSlowRead + 1, 'failed listing reads are throttled for ten seconds');
  fake.hangRead = false;
  const pendingDisconnect = assert.rejects(client.request('test/hang', {}), /app-server disconnected/);
  assert.equal((await post('one', '__disconnect__')).status, 500);
  await pendingDisconnect;
  assert.equal(spawnCount, 0, 'no exec fallback after turn submission');
  assert.equal(client.connected, false);
  assert.equal(client.subscribed.size, 0);
  await pause(50);
  assert.equal((await post('one', 'reconnected')).body.reply, 'reply:reconnected');
  assert.equal(fake.requests.filter(r => r.method === 'initialize').length, 3);
  for (let i = 0; i < 100 && !client.subscribed.has(externalId); i++) await pause(5);
  assert.ok(client.subscribed.has(externalId), 'reconnect restores other bound subscriptions');
  assert.ok(client.subscribed.has(seedId));
  const log = fs.readFileSync(path.join(temp, 'logs/relay.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.filter(r => r.event === 'appserver_request').length, 6);
  assert.ok(log.some(r => r.transport === 'app-server' && r.status === 200));
  assert.equal(client.pending.size, 0);
  assert.equal(client.waiters.size, 0);

  // A rejected initialize handshake also falls back before turn submission.
  client.close();
  fake.rejectInitialize = true;
  assert.equal((await post('one', 'handshake-failure')).body.error, 'EXEC_FALLBACK');
  assert.equal(spawnCount, 1);
  fake.rejectInitialize = false;
  await pause(50);
  assert.equal((await post('one', 'after-handshake-failure')).body.reply, 'reply:after-handshake-failure');

  // ----- Fix 1: sessions only link existing Codex threads -----
  const ghost = '01a1a610-dead-7000-8000-000000000000';
  const turnStarts = () => fake.requests.filter(r => r.method === 'turn/start').length;
  const startsBefore = turnStarts();
  const missing = await post('ghost', 'hi', ghost);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, '没有这个会话 ID');
  assert.equal((await post('ghost', 'hi', 'not-a-uuid-at-all')).status, 400);
  assert.equal(turnStarts(), startsBefore);
  assert.equal((await get('/api/sessions')).body.sessions.some(s => s.key === 'ghost'), false);
  assert.equal(fs.existsSync(path.join(temp, 'data/history/ghost.jsonl')), false);
  // Re-binding an existing key to a missing thread keeps the old binding.
  const oneBinding = (await get('/api/sessions')).body.sessions.find(s => s.key === 'one').codex_session_id;
  assert.equal((await post('one', 'x', ghost)).status, 404);
  assert.equal((await get('/api/sessions')).body.sessions.find(s => s.key === 'one').codex_session_id, oneBinding);
  // Admin bind without sending.
  assert.equal((await api('PUT', '/api/sessions/ghost', { codex_session_id: ghost })).status, 404);
  assert.equal((await api('PUT', '/api/sessions/ghost', { codex_session_id: 'abc' })).status, 400);
  assert.equal((await get('/api/sessions')).body.sessions.some(s => s.key === 'ghost'), false);
  const bound = await api('PUT', '/api/sessions/linked', { codex_session_id: seedId });
  assert.equal(bound.status, 201);
  assert.equal(bound.body.session.codex_session_id, seedId);
  assert.equal((await api('PUT', '/api/sessions/linked', { codex_session_id: seedId })).status, 200);
  assert.ok((await get('/api/sessions/linked/history')).body.history.some(e => e.text === 'from App at startup'));
  assert.equal(turnStarts(), startsBefore);
  // Rollout file fallback when the app-server does not know the thread.
  const archived = '01a1a610-beef-7000-8000-000000000001';
  fs.mkdirSync(path.join(temp, 'codex-home/archived_sessions'), { recursive: true });
  fs.writeFileSync(path.join(temp, `codex-home/archived_sessions/rollout-2026-01-01T00-00-00-${archived}.jsonl`), '');
  assert.equal((await api('PUT', '/api/sessions/from-rollout', { codex_session_id: archived })).status, 201);
  assert.equal((await api('DELETE', '/api/sessions/from-rollout')).status, 200);
  // Thread picker.
  const picker = await get('/api/codex/threads?q=');
  assert.equal(picker.status, 200);
  const seedRow = picker.body.threads.find(t => t.id === seedId);
  assert.deepEqual(seedRow.linked.sort(), ['linked', 'seeded']);
  assert.equal(seedRow.cwd, '/tmp/fake-cwd');
  assert.match(seedRow.updated_at, /^20\d\d-/);
  assert.deepEqual(fake.lastList.sourceKinds, ['cli', 'vscode', 'exec', 'appServer']);
  assert.equal(fake.lastList.sortKey, 'updated_at');

  // ----- Fix 2: generated images become signed, servable URLs -----
  const pics = await post('pics', 'first');
  const picsId = pics.body.codex_session_id;
  const imageDir = path.join(temp, 'codex-home/generated_images', picsId);
  fs.mkdirSync(imageDir, { recursive: true });
  fake.imagePath = path.join(imageDir, 'cat.png');
  fs.writeFileSync(fake.imagePath, Buffer.from([137,80,78,71,13,10,26,10,1,2,3]));
  await post('pics', '__image__');
  const workFile = path.join(temp, 'work/pics/chart.png');
  fs.mkdirSync(path.dirname(workFile), { recursive: true });
  fs.writeFileSync(workFile, Buffer.from([137,80,78,71,13,10,26,10]));
  await post('pics', `see ![chart](${workFile}) and ![bad](/etc/passwd)`);
  const picHistory = (await get('/api/sessions/pics/history')).body.history;
  const generated = picHistory.find(e => e.role === 'assistant' && e.images?.length);
  assert.ok(generated, 'imageGeneration item surfaces as an image');
  assert.match(generated.images[0].url, /^\/api\/media\/cat\.png\?p=/);
  assert.equal(generated.images[0].path, undefined);
  assert.equal(JSON.stringify(picHistory).includes('iVBORw0KGgo='), false, 'base64 result is not inlined');
  const verify = url => vm.runInContext(`media.verify(new URLSearchParams(${JSON.stringify(url.split('?')[1])}))`, relayContext);
  assert.equal(verify(generated.images[0].url).file, fake.imagePath);
  assert.equal(verify(generated.images[0].url).key, 'pics');
  assert.equal(verify(generated.images[0].url.replace(/s=[^&]+/, 's=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')), null);
  const markdown = picHistory.filter(e => e.role === 'assistant').at(-1).text;
  assert.match(markdown, /!\[chart\]\(\/api\/media\/chart\.png\?p=/);
  assert.match(markdown, /!\[bad\]\(\/etc\/passwd\)/, 'paths outside the session roots stay unsigned');

  // ----- Fix 3: live streaming of App-started turns -----
  const live = stream('/api/sessions/linked/stream');
  assert.equal(live.res.status, 200);
  assert.equal(live.res.headers['X-Accel-Buffering'], 'no');
  assert.match(live.res.headers['Content-Type'], /text\/event-stream/);
  assert.equal(live.events[0].name, 'snapshot');
  assert.equal(live.events[0].data.running, false);
  fake.streamDelay = 150;
  fake.handle({ id: 'stream-turn', method: 'turn/start', params: { threadId: seedId, input: [{ type: 'text', text: '__stream__' }] } }, appFixture, () => {});
  await pause(100);
  const midText = live.events.filter(e => e.name === 'delta').map(e => e.data.delta).join('');
  assert.equal(midText, '**Hel');
  assert.ok(live.events.some(e => e.name === 'item' && e.data.item.kind === 'text'));
  const mid = (await get('/api/sessions/linked/history')).body;
  assert.equal(mid.running, true);
  assert.equal(mid.live.items.find(i => i.kind === 'text').text, '**Hel', 'history carries the live buffer for polling clients');
  const late = stream('/api/sessions/linked/stream');
  assert.equal(late.events[0].data.live.items.find(i => i.kind === 'text').text, '**Hel', 'late joiners get a snapshot');
  late.close();
  await pause(500);
  const names = live.events.map(e => e.name);
  assert.ok(names.includes('turn'));
  assert.equal(live.events.filter(e => e.name === 'delta' && e.data.kind === 'text').map(e => e.data.delta).join(''), '**Hello**');
  // Replaying events like the console does must not duplicate text (item snapshots are taken at emit time).
  const replay = new Map();
  for (const e of live.events) {
    if (e.name === 'item') replay.set(e.data.item.id, { ...(replay.get(e.data.item.id) || {}), ...e.data.item });
    if (e.name === 'delta') { const item = replay.get(e.data.id) || {}; item[e.data.field] = (item[e.data.field] || '') + e.data.delta; replay.set(e.data.id, item); }
  }
  assert.equal([...replay.values()].find(i => i.kind === 'text').text, '**Hello**');
  const command = live.events.filter(e => e.name === 'item' && e.data.item.kind === 'command').at(-1).data.item;
  assert.equal(command.title, 'ls -la');
  assert.equal(command.exitCode, 0);
  assert.equal(live.events.filter(e => e.name === 'turn').at(-1).data.status, 'completed');
  assert.ok(live.raw.some(text => text.startsWith(': ping')), 'heartbeat comment lines');
  assert.equal(client.threadState(seedId).live, null);
  live.close();
  assert.equal(client.liveListeners.size, 0);

  // ----- Queue (排队) / steer (引导) / interrupt / refresh-resume -----
  const waitFor = async (check, label, tries = 200) => { for (let i = 0; i < tries; i++) { if (await check()) return; await pause(10); } assert.fail(`timed out waiting: ${label}`); };
  let qThread;
  fake.handle({ id: 'queue-thread', method: 'thread/start', params: {} }, value => { if (value.result?.thread) qThread = value.result.thread.id; }, () => {});
  assert.equal((await api('PUT', '/api/sessions/qs', { codex_session_id: qThread })).status, 201);
  const qStream = stream('/api/sessions/qs/stream');
  const held = api('POST', '/webhook/queue', { session: 'qs', message: '__hold__one' });
  await waitFor(() => client.busy(qThread), 'held turn running');
  const queuedTwo = await api('POST', '/api/send', { session: 'qs', message: 'queued-two', async: '1' });
  assert.equal(queuedTwo.status, 202, JSON.stringify(queuedTwo));
  assert.equal(queuedTwo.body.mode, 'queue');
  assert.equal(queuedTwo.body.status, 'queued');
  assert.equal(queuedTwo.body.position, 1);
  const queuedThree = await api('POST', '/webhook', { session: 'qs', message: 'queued-three', callback_url: 'http://127.0.0.1:9/never' });
  assert.equal(queuedThree.status, 202);
  let queueView = (await get('/api/sessions/qs/queue')).body;
  assert.deepEqual(queueView.queue.map(e => [e.text, e.status]), [['__hold__one', 'running'], ['queued-two', 'queued'], ['queued-three', 'queued']]);
  assert.equal(queueView.running, true);
  assert.equal((await api('DELETE', `/api/sessions/qs/queue/${queuedThree.body.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/sessions/qs/queue/${queuedThree.body.id}`)).status, 404, 'already removed');
  queueView = (await get('/api/sessions/qs/queue')).body;
  assert.deepEqual(queueView.queue.map(e => e.text), ['__hold__one', 'queued-two']);
  assert.ok(qStream.events.some(e => e.name === 'queue' && e.data.queue.length === 3), 'queue changes are pushed to the stream');
  // Refresh mid-turn: history and a new stream subscriber both carry the running state and the queue.
  const midHistory = (await get('/api/sessions/qs/history')).body;
  assert.equal(midHistory.running, true);
  assert.equal(midHistory.history.at(-1).text, '__hold__one');
  assert.equal(midHistory.queue.length, 2);
  const lateJoin = stream('/api/sessions/qs/stream');
  const snap = lateJoin.events.find(e => e.name === 'snapshot').data;
  assert.equal(snap.running, true);
  assert.deepEqual(snap.queue.map(e => e.status), ['running', 'queued']);
  lateJoin.close();
  // Steer into the running turn: turn/steer with expectedTurnId, no new turn.
  const qStartsBefore = fake.requests.filter(r => r.method === "turn/start" && r.params.threadId === qThread).length;
  const steered = api('POST', '/webhook/steer', { session: 'qs', message: 'steer-in' });
  await waitFor(() => fake.steered?.some(e => e.text === 'steer-in'), 'turn/steer sent');
  const steerRequest = fake.requests.find(r => r.method === 'turn/steer');
  assert.equal(steerRequest.params.threadId, qThread);
  assert.equal(steerRequest.params.expectedTurnId, fake.turns.get(qThread)[0].id);
  assert.equal(fake.requests.filter(r => r.method === 'turn/start' && r.params.threadId === qThread).length, qStartsBefore);
  await waitFor(async () => (await get('/api/sessions/qs/queue')).body.queue.some(e => e.status === 'steered' && e.text === 'steer-in'), 'steered entry listed');
  fake.held.get(qThread)();
  assert.equal((await held).body.reply, 'reply:__hold__one');
  const steerResult = (await steered).body;
  assert.equal(steerResult.mode, 'steer');
  assert.equal(steerResult.steered, true);
  assert.equal(steerResult.reply, 'reply:__hold__one');
  await waitFor(() => fake.threads.get(qThread).includes('queued-two') && !client.busy(qThread), 'queued message sent after the turn');
  await waitFor(async () => (await get('/api/sessions/qs/queue')).body.queue.length === 0, 'queue drained');
  assert.deepEqual(fake.threads.get(qThread), ['__hold__one', 'queued-two'], 'removed message is never sent');
  // Steer with nothing running: sent right away as a new turn.
  const idleSteer = await api('POST', '/webhook', { session: 'qs', message: 'steer-idle', mode: 'steer' });
  assert.equal(idleSteer.body.reply, 'reply:steer-idle');
  assert.equal(idleSteer.body.steer, 'no_active_turn');
  assert.equal((await api('POST', '/webhook', { session: 'qs', message: 'x', mode: 'bogus' })).status, 400);
  const idleAsync = await api('POST', '/api/send', { session: 'qs', message: 'idle-async', async: '1' });
  assert.deepEqual([idleAsync.status, idleAsync.body.status, idleAsync.body.position], [202, 'running', 0], 'idle session starts right away');
  await waitFor(() => fake.threads.get(qThread).includes('idle-async') && !client.busy(qThread), 'idle async send done');
  await waitFor(async () => (await get('/api/sessions/qs/queue')).body.queue.length === 0, 'queue drained again');
  // A queued message waits for a turn started elsewhere (the Codex App) too.
  fake.handle({ id: 'app-hold', method: 'turn/start', params: { threadId: qThread, input: [{ type: 'text', text: '__hold__app' }] } }, () => {}, () => {});
  await waitFor(() => client.busy(qThread), 'App turn running');
  const afterApp = api('POST', '/webhook/queue', { session: 'qs', message: 'after-app' });
  await pause(80);
  assert.ok(!fake.threads.get(qThread).includes('after-app'), 'queued behind the App turn');
  // A rejected steer falls back to the head of the queue.
  fake.rejectSteer = true;
  const rejected = await api('POST', '/api/send', { session: 'qs', message: 'steer-rejected', mode: 'steer', async: '1' });
  fake.rejectSteer = false;
  assert.equal(rejected.status, 202);
  assert.equal(rejected.body.steer_fallback, 'steer_rejected');
  assert.equal(rejected.body.position, 1);
  // Stop: interrupt the running turn.
  const stopped = await api('POST', '/api/sessions/qs/interrupt');
  assert.equal(stopped.status, 200, JSON.stringify(stopped));
  assert.equal(fake.turns.get(qThread).find(t => t.items[0].content[0].text === '__hold__app').status, 'interrupted');
  assert.equal((await afterApp).body.reply, 'reply:after-app');
  assert.deepEqual(fake.threads.get(qThread).slice(-3), ['__hold__app', 'steer-rejected', 'after-app']);
  await waitFor(() => !client.busy(qThread), 'idle');
  assert.equal((await api('POST', '/api/sessions/qs/interrupt')).status, 409, 'nothing to stop');
  assert.equal((await api('POST', '/api/sessions/never-linked/interrupt')).status, 404, 'unknown session');
  const stoppedHistory = (await get('/api/sessions/qs/history')).body.history;
  assert.ok(stoppedHistory.some(e => e.role === 'error' && e.text === '回合已停止' && e.interrupted), 'stopped turns are marked');
  // Repeated text: each thread message matches its own relay entry (no duplicate orphan bubbles).
  const repeated = convert({ id: 'rep', turns: [
    { startedAt: 1700000000, completedAt: 1700000001, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'again' }] }, { type: 'agentMessage', text: 'one' }] },
    { startedAt: 1700000030, completedAt: 1700000031, status: 'interrupted', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'again' }] }] },
  ] }, [
    { role: 'user', text: 'again', source: 'webhook', time: new Date(1700000000000).toISOString(), request_id: 'r1' },
    { role: 'user', text: 'again', source: 'console', time: new Date(1700000030000).toISOString(), request_id: 'r2' },
    { role: 'error', text: 'Codex turn interrupted', time: new Date(1700000031000).toISOString(), request_id: 'r2' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(repeated)).map(e => [e.role, e.text, e.source]), [['user', 'again', 'webhook'], ['assistant', 'one', undefined], ['user', 'again', 'console'], ['error', '回合已停止', undefined]]);
  qStream.close();
  assert.equal(vm.runInContext('queueListeners.size', relayContext), 0);
  // Uploaded non-image files get a signed download URL.
  const fileEntry = (await get('/api/sessions/images/history')).body.history[0].attachments.find(f => f.name === 'notes.txt');
  assert.match(fileEntry.url, /^\/api\/media\/[^?]+\?.*&t=f&/);
  const download = await rawGet(fileEntry.url);
  assert.equal(download.status, 200);
  assert.equal(download.body, 'inline text');
  assert.match(download.headers['Content-Disposition'], /^inline;.*notes\.txt/);
  assert.equal((await rawGet(fileEntry.url.replace('&t=f', ''))).status, 404, 'download signature cannot serve as an image signature');

  // Failure before any turn is sent may use exec, including backoff calls.
  client.close();
  broken = true;
  await fake.close();
  if (!fs.existsSync(socketPath)) fs.writeFileSync(socketPath, 'stale socket');
  const before = fake.requests.filter(r => r.method === 'turn/start').length;
  assert.equal((await post('one', 'connection-failure')).body.error, 'EXEC_FALLBACK');
  assert.equal((await post('one', 'backoff')).body.error, 'EXEC_FALLBACK');
  assert.equal(spawnCount, 3);
  assert.equal(fake.requests.filter(r => r.method === 'turn/start').length, before);
  fs.unlinkSync(socketPath);
  assert.equal((await get('/api/sessions/external/history')).body.source, 'local');
  assert.equal((await post('one', 'missing-socket')).body.error, 'EXEC_FALLBACK');
  assert.equal(spawnCount, 4);
  console.log(`App-server relay tests passed (${socketMode ? 'unix WebSocket' : 'simulated WebSocket'})`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (relayContext) vm.runInContext('watcherStopped = true; clearTimeout(watcherTimer)', relayContext);
  client?.close();
  for (const client of clients) client.close();
  await fake.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
