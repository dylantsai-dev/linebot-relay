'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

// The protocol fixture is shared by the real socket and socket-free tests.
class FakeAppServer {
  constructor() {
    this.threads = new Map();
    this.loaded = new Set();
    this.turns = new Map();
    this.connections = new Map();
    this.requests = [];
    this.clients = new Set();
    this.timers = new Set();
  }

  handle(message, send, disconnect) {
    this.requests.push(message);
    if (!this.connections.has(send)) this.connections.set(send, new Set());
    const subscriptions = this.connections.get(send);
    const { id, method, params } = message;
    const respond = result => send({ id, result });
    const notify = (method, params) => {
      for (const [client, subscribed] of this.connections) {
        if (subscribed.has(params.threadId)) client({ method, params });
      }
    };
    switch (method) {
      case 'initialize':
        if (this.rejectInitialize) send({ id, error: { code: -32600, message: 'initialize rejected' } });
        else respond({ serverInfo: { name: 'fake-appserver' } });
        break;
      case 'initialized':
      case 'test/hang': break;
      case 'thread/start': {
        const threadId = crypto.randomUUID();
        this.threads.set(threadId, []);
        this.turns.set(threadId, []);
        subscriptions.add(threadId);
        this.loaded.add(threadId);
        respond({ thread: { id: threadId } });
        break;
      }
      case 'thread/loaded/list': respond({ data: [...this.loaded] }); break;
      case 'thread/read':
        if (!this.threads.has(params.threadId)) send({ id, error: { code: -32600, message: `thread not loaded: ${params.threadId}` } });
        else if (this.failRead) send({ id, error: { message: 'read unavailable' } });
        else if (this.hangRead) break;
        else respond({ thread: { id: params.threadId, updatedAt: Date.now() / 1000, ...(params.includeTurns ? { turns: this.turns.get(params.threadId) || [] } : {}) } });
        break;
      case 'thread/resume':
        subscriptions.add(params.threadId);
        if (!this.turns.has(params.threadId)) this.turns.set(params.threadId, []);
        this.loaded.add(params.threadId);
        if (!this.threads.has(params.threadId)) this.threads.set(params.threadId, []);
        respond({ thread: { id: params.threadId } });
        break;
      case 'turn/start': {
        const { threadId } = params;
        const text = params.input[0].text;
        const turnId = text === '__steer__' ? 'existing-active-turn' : crypto.randomUUID();
        const turn = { id: turnId, status: 'inProgress', startedAt: Date.now() / 1000, items: [{ type: 'userMessage', content: params.input }] };
        const history = this.threads.get(threadId);
        if (!history) { send({ id, error: { code: -32600, message: 'unknown thread' } }); break; }
        history.push(text);
        this.turns.get(threadId).push(turn);
        notify('thread/status/changed', { threadId, status: { type: 'active' } });
        // Test notifications arriving before the response, in the same packet.
        notify('turn/started', { threadId, turn });
        if (text === '__disconnect__') { disconnect(); break; }
        const complete = () => {
          turn.status = text === '__failed__' ? 'failed' : text === '__interrupted__' ? 'interrupted' : 'completed';
          turn.completedAt = Date.now() / 1000;
          turn.durationMs = Math.round((turn.completedAt - turn.startedAt) * 1000);
          if (text === '__failed__') turn.error = { message: 'recorded failure' };
          if (text === '__image__' && this.imagePath) {
            const image = { type: 'imageGeneration', id: `img-${turnId}`, status: 'completed', revisedPrompt: 'a cat', result: 'iVBORw0KGgo=', savedPath: this.imagePath };
            turn.items.push(image);
            notify('item/started', { threadId, turnId, item: { ...image, status: 'inProgress', savedPath: undefined, result: '' } });
            notify('item/completed', { threadId, turnId, item: image });
          }
          turn.items.push({ type: 'agentMessage', phase: 'commentary', text: 'working' });
          if (text !== '__no_final__') turn.items.push({ type: 'agentMessage', phase: 'final_answer', text: `reply:${text}` });
          turn.items.push({ type: 'agentMessage', phase: 'commentary', text: 'last commentary' });
          notify('item/completed', { threadId: 'unrelated-thread', turnId, item: { type: 'agentMessage', text: 'wrong thread' } });
          notify('item/completed', { threadId, turnId: 'unrelated-turn', item: { type: 'agentMessage', text: 'wrong turn' } });
          notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', phase: 'commentary', text: 'working' } });
          if (text !== '__no_final__') notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: `reply:${text}` } });
          notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', phase: 'commentary', text: 'last commentary' } });
          if (text === '__failed__') notify('error', { threadId, turnId, error: { message: 'recorded failure' } });
          notify('turn/completed', { threadId, turn });
          notify('thread/status/changed', { threadId, status: { type: 'idle' } });
        };
        if (text === '__approval__') {
          for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'applyPatchApproval', 'execCommandApproval', 'item/tool/requestUserInput', 'unknown/request']) {
            send({ id: `server-${method}`, method, params: { threadId, turnId } });
          }
        }
        if (text === '__stream__') {
          // Streaming: item/started, deltas, a command with output, then completion.
          const msg = { type: 'agentMessage', id: `msg-${turnId}`, text: '', phase: 'final_answer' };
          notify('item/started', { threadId, turnId, item: msg });
          notify('item/agentMessage/delta', { threadId, turnId, itemId: msg.id, delta: '**Hel' });
          const step = (delay, fn) => { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, delay); this.timers.add(timer); };
          step(this.streamDelay || 120, () => {
            notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: `cmd-${turnId}`, command: "/bin/bash -lc 'ls -la'", cwd: '/tmp', status: 'inProgress', aggregatedOutput: null, exitCode: null } });
            notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: `cmd-${turnId}`, delta: 'total 0\n' });
            notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: `cmd-${turnId}`, command: "/bin/bash -lc 'ls -la'", cwd: '/tmp', status: 'completed', aggregatedOutput: 'total 0\n', exitCode: 0 } });
            notify('item/agentMessage/delta', { threadId, turnId, itemId: msg.id, delta: 'lo**' });
            step(this.streamDelay || 120, complete);
          });
        } else if (text === '__app_slow__') {
          const timer = setTimeout(() => { this.timers.delete(timer); complete(); }, 40);
          this.timers.add(timer);
        } else if (text !== '__timeout__' && text !== '__late__' && text !== '__stream__') complete();
        if (text === '__late__' || text === '__completed_late__') {
          const timer = setTimeout(() => { this.timers.delete(timer); respond({ turn }); }, 150);
          this.timers.add(timer);
        } else respond({ turn });
        break;
      }
      case 'turn/interrupt': respond({}); break;
      case 'thread/archive': this.loaded.delete(params.threadId); respond({}); break;
      case 'thread/list':
        this.lastList = params;
        respond({ data: [...this.threads.keys()].filter(id => !params?.searchTerm || (this.names?.get(id) || '').includes(params.searchTerm)).map(id => ({ id, name: this.names?.get(id) || null, preview: `preview ${id.slice(0, 4)}`, updatedAt: 1793810711, createdAt: 1793800000, cwd: '/tmp/fake-cwd', status: { type: 'idle' }, source: 'vscode', parentThreadId: null, ephemeral: false })), nextCursor: null });
        break;
      default: send({ id, error: { code: -32601, message: 'unsupported fixture request' } });
    }
  }

  async listen(socketPath) {
    this.server = net.createServer(socket => {
      this.clients.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => { this.clients.delete(socket); this.connections.delete(send); });
      let buffer = Buffer.alloc(0), upgraded = false;
      const frame = (opcode, payload) => {
        let header;
        if (payload.length < 126) { header = Buffer.from([0x80 | opcode, payload.length]); }
        else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
        else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
        socket.write(Buffer.concat([header, payload]));
      };
      const send = message => { if (!socket.destroyed) frame(1, Buffer.from(JSON.stringify(message))); };
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const head = buffer.subarray(0, end).toString();
          const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(head)?.[1];
          if (!key || !head.startsWith('GET / HTTP/1.1')) { socket.destroy(); return; }
          const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          buffer = buffer.subarray(end + 4);
          upgraded = true;
        }
        for (;;) {
          if (buffer.length < 2) return;
          const opcode = buffer[0] & 15;
          if (!(buffer[1] & 128)) { socket.destroy(); return; }
          let length = buffer[1] & 127, offset = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          if (buffer.length < offset + 4 + length) return;
          const mask = buffer.subarray(offset, offset + 4);
          offset += 4;
          const payload = Buffer.from(buffer.subarray(offset, offset + length));
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
          buffer = buffer.subarray(offset + length);
          if (opcode === 8) { frame(8, payload); socket.end(); return; }
          if (opcode === 9) { frame(10, payload); continue; }
          if (opcode !== 1) continue;
          try { this.handle(JSON.parse(payload.toString()), send, () => socket.destroy()); }
          catch (error) { socket.destroy(error); }
        }
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(socketPath, resolve); });
  }

  async close() {
    for (const timer of this.timers) clearTimeout(timer);
    for (const socket of this.clients) socket.destroy();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
  }
}

module.exports = { FakeAppServer };
if (require.main === module) {
  const fake = new FakeAppServer();
  fake.listen(process.argv[2]).then(() => console.log('ready'), error => { console.error(error.message); process.exitCode = 1; });
  process.once('SIGTERM', () => { void fake.close(); });
}
