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
    UPLOAD_DIR: path.join(temp, 'uploads'), DATA_DIR: path.join(temp, 'data'), WORK_DIR: path.join(temp, 'work'), LOG_DIR: path.join(temp, 'logs'),
  };
  const context = vm.createContext({
    __dirname: path.resolve(__dirname, '..'), Buffer, setTimeout, clearTimeout, AbortSignal,
    console: { log() {}, error: console.error },
    process: { env },
    require: name => {
      if (name === './lib/appserver') return { AppServer: TestClient };
      if (name === 'node:http') return { createServer: callback => { handler = callback; return { listen() {} }; } };
      if (name === 'node:child_process') return { spawn() { spawnCount++; throw new Error('EXEC_FALLBACK'); } };
      if (name === './lib/attachments') return require('../lib/attachments');
      return require(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), context);
  relayContext = context;
}

function post(session, message, codex_session_id, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    Object.assign(req, { url: '/webhook', method: 'POST', headers: { authorization: 'Bearer test-token', ...(Buffer.isBuffer(extra) ? {'content-type':'multipart/form-data; boundary=app-upload'} : {}) } });
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

function get(route) {
  return new Promise((resolve, reject) => {
    const req = { url: route, method: 'GET', headers: { authorization: 'Bearer test-token' } };
    const res = { writeHead(status) { this.status = status; }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }); } };
    handler(req, res).catch(reject);
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
  assert.ok(fs.statSync(path.join(temp, 'work/one')).isDirectory());
  assert.equal(client.connected, true);
  await assert.rejects(client.request('test/hang', {}, 10), /request timed out/);
  assert.equal(client.pending.size, 0);
  const second = await post('one', 'again');
  assert.equal(second.body.codex_session_id, threadId);
  assert.deepEqual(fake.threads.get(threadId), ['hello', 'again']);
  assert.equal(fake.requests.filter(r => r.method === 'initialize').length, 1);
  assert.equal(fake.requests.filter(r => r.method === 'thread/resume' && r.params.threadId === threadId).length, 0);
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
  assert.equal(externalHistory.history[0].source, 'webhook');
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
  const start = fake.requests.find(r => r.method === 'thread/start' && r.params.serviceName).params;
  assert.equal(start.model, 'test-model');
  assert.equal(start.sandbox, 'workspace-write');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.serviceName, 'linebot-relay');
  assert.ok(fake.requests.every(r => !('jsonrpc' in r)));
  client.subscribed.delete(threadId);
  fake.loaded.delete(threadId);
  assert.equal((await post('one', 'resume')).status, 200);
  assert.equal(JSON.stringify(fake.requests.find(r => r.method === 'thread/resume' && r.params.threadId === threadId).params), JSON.stringify({ threadId, excludeTurns: true }));
  assert.equal((await post('bound', 'bound', threadId)).body.codex_session_id, threadId);
  assert.equal((await post('one', '__steer__')).body.reply, 'reply:__steer__');
  assert.equal((await post('one', '__no_final__')).body.reply, 'last commentary');
  assert.equal((await post('one', '__approval__')).body.reply, 'reply:__approval__');
  assert.ok(fake.requests.every(r => !String(r.id).startsWith('server-')), 'all server requests remain unanswered');
  for (const [message, error] of [['__failed__', 'recorded failure'], ['__interrupted__', 'Codex turn interrupted']]) {
    const result = await post('one', message);
    assert.equal(result.status, 500);
    assert.equal(result.body.error, error);
  }
  for (const message of ['__timeout__', '__late__']) {
    const result = await post('one', message);
    assert.equal(result.status, 504);
    assert.equal(result.body.error, 'Codex timed out');
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
  assert.deepEqual(converted.filter(e => e.role === 'error').map(e => e.text), ['turn failure', 'Codex turn failed', 'relay-side error']);
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
  assert.equal((await post('handshake-failure', 'test')).body.error, 'EXEC_FALLBACK');
  assert.equal(spawnCount, 1);
  fake.rejectInitialize = false;
  await pause(50);
  assert.equal((await post('one', 'after-handshake-failure')).body.reply, 'reply:after-handshake-failure');

  // Failure before any turn is sent may use exec, including backoff calls.
  client.close();
  broken = true;
  await fake.close();
  if (!fs.existsSync(socketPath)) fs.writeFileSync(socketPath, 'stale socket');
  const before = fake.requests.filter(r => r.method === 'turn/start').length;
  assert.equal((await post('connection-failure', 'test')).body.error, 'EXEC_FALLBACK');
  assert.equal((await post('backoff', 'test')).body.error, 'EXEC_FALLBACK');
  assert.equal(spawnCount, 3);
  assert.equal(fake.requests.filter(r => r.method === 'turn/start').length, before);
  fs.unlinkSync(socketPath);
  assert.equal((await get('/api/sessions/external/history')).body.source, 'local');
  assert.equal((await post('missing-socket', 'test')).body.error, 'EXEC_FALLBACK');
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
