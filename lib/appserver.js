'use strict';

const { UnixWebSocket } = require('./ws-unix');

class AppServer {
  constructor(socketPath, { log = () => {}, requestTimeout = 30000, backoff = 2000, onConnect = () => {} } = {}) {
    this.socketPath = socketPath;
    this.onConnect = onConnect;
    this.subscribed = new Set();
    this.subscribing = new Map();
    this.threads = new Map();
    this.inProgress = new Map();
    this.completedTurns = new Set();
    this.log = log;
    this.requestTimeout = requestTimeout;
    this.backoff = backoff;
    this.pending = new Map();
    this.waiters = new Set();
    this.nextId = 1;
    this.retryAt = 0;
    this.connected = false;
  }

  async connect() {
    if (this.connecting) return this.connecting;
    if (this.connected) return;
    if (Date.now() < this.retryAt) throw this.connectionError('reconnect backoff');
    const attempt = this.open();
    this.connecting = attempt;
    try { await attempt; }
    finally { if (this.connecting === attempt) this.connecting = null; }
  }

  connectionError(message) {
    return Object.assign(new Error(`Codex app-server disconnected: ${message}`), { appserverConnection: true });
  }

  async open() {
    let ws;
    try {
      ws = new UnixWebSocket(this.socketPath);
      this.ws = ws;
      await new Promise((resolve, reject) => {
        const disconnect = cause => {
          const error = this.connectionError(cause?.message || 'socket closed');
          if (this.ws === ws) {
            this.ws = null;
            this.connected = false;
            this.resetConnection();
            this.retryAt = Date.now() + this.backoff;
            for (const pending of this.pending.values()) pending.reject(error);
            for (const waiter of [...this.waiters]) waiter.reject(error);
          }
          reject(error);
          ws.close();
        };
        ws.on('message', text => { if (this.ws === ws) this.message(text); });
        ws.on('open', resolve);
        ws.on('error', disconnect);
        ws.on('close', () => disconnect());
      });
      await this.request('initialize', {
        clientInfo: { name: 'linebot-relay', title: 'LINE bot relay', version: '1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      ws.send(JSON.stringify({ method: 'initialized' }));
      this.connected = true;
      this.onConnect();
    } catch (cause) {
      if (this.ws === ws) this.close();
      this.retryAt = Date.now() + this.backoff;
      throw this.connectionError(cause.message);
    }
  }

  request(method, params, timeout = this.requestTimeout) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const finish = (fn, value) => {
        clearTimeout(timer);
        this.pending.delete(id);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error(`Codex app-server request timed out: ${method}`)), timeout);
      this.pending.set(id, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      try {
        if (!this.ws?.open) throw this.connectionError('socket not open');
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) { finish(reject, error); }
    });
  }

  message(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.method && message.id !== undefined) {
      // The App owns every server request, including approvals and user input.
      this.log({ event: 'appserver_request', method: message.method });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (message.error) pending?.reject(new Error(message.error.message || 'Codex app-server request failed'));
      else pending?.resolve(message.result);
      return;
    }
    const { method, params } = message;
    if (params?.threadId) {
      const state = this.threadState(params.threadId);
      state.revision++;
      if (method === 'thread/status/changed') state.status = params.status?.type || params.status;
      if (method === 'turn/started' && params.turn?.id) {
        this.inProgress.set(params.turn.id, params.threadId);
        state.status = 'active';
      }
      if (method === 'turn/completed') {
        this.inProgress.delete(params.turn?.id);
        this.completedTurns.add(params.turn?.id);
        state.status = 'idle';
      }
    }
    for (const waiter of [...this.waiters]) waiter.notify(message);
  }

  resetConnection() {
    this.subscribed.clear();
    this.subscribing.clear();
    this.inProgress.clear();
    this.completedTurns.clear();
    for (const state of this.threads.values()) {
      state.revision++;
      state.status = 'idle';
      state.cache = null;
      state.reading = null;
    }
  }

  threadState(threadId) {
    if (!this.threads.has(threadId)) this.threads.set(threadId, { revision: 0, status: 'idle', cache: null });
    return this.threads.get(threadId);
  }

  async subscribe(threadId) {
    await this.connect();
    if (this.subscribed.has(threadId)) return;
    if (this.subscribing.has(threadId)) return this.subscribing.get(threadId);
    const ws = this.ws;
    const pending = this.request('thread/resume', { threadId, excludeTurns: true }).then(() => {
      if (this.ws === ws && this.connected) this.subscribed.add(threadId);
    });
    this.subscribing.set(threadId, pending);
    try { await pending; }
    finally { if (this.subscribing.get(threadId) === pending) this.subscribing.delete(threadId); }
  }

  async readThread(threadId, maxAge = 30000) {
    await this.subscribe(threadId);
    const state = this.threadState(threadId);
    if (state.cache && state.cache.revision === state.revision && Date.now() - state.cache.time < maxAge) return state.cache;
    if (state.reading) return state.reading;
    // Listing refreshes also throttle failed reads; history may retry on demand.
    if (maxAge === 10000 && state.lastReadRevision === state.revision && Date.now() - state.lastReadTime < 10000) {
      if (state.cache) return state.cache;
      throw new Error('Thread read temporarily unavailable');
    }
    state.lastReadTime = Date.now();
    state.lastReadRevision = state.revision;
    const revision = state.revision, ws = this.ws;
    const reading = this.request('thread/read', { threadId, includeTurns: true }, 2800).then(result => {
      if (!result?.thread || !Array.isArray(result.thread.turns)) throw new Error('Invalid thread/read response');
      const cache = { thread: result.thread, revision, time: Date.now() };
      if (this.ws === ws) state.cache = cache;
      return cache;
    });
    state.reading = reading;
    try { return await reading; }
    finally { if (state.reading === reading) state.reading = null; }
  }

  async runTurn(threadId, text, timeout) {
    await this.subscribe(threadId);
    // Subscribe before sending: completion can share a packet with the response.
    return new Promise((resolve, reject) => {
      let turnId, startedTurnId, reply = '', finalAnswer = false, turnError, done = false, interrupted = false;
      const interrupt = () => {
        const id = turnId || startedTurnId;
        if (id && this.inProgress.get(id) === threadId && !interrupted) {
          interrupted = true;
          this.request('turn/interrupt', { threadId, turnId: id }).catch(() => {});
        }
      };
      const early = [];
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        if (error) reject(error); else resolve(value);
      };
      const waiter = {
        reject: error => finish(error),
        notify: ({ method, params }) => {
          if (done || params?.threadId !== threadId) return;
          if (method === 'turn/started') startedTurnId = params.turn?.id;
          if (!turnId) { early.push({ method, params }); return; }
          if (method === 'error' && (!params.turnId || params.turnId === turnId)) turnError = params.error?.message || params.message;
          if (method === 'item/completed' && params.turnId === turnId && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
            if (params.item.phase === 'final_answer' || !finalAnswer) reply = params.item.text;
            if (params.item.phase === 'final_answer') finalAnswer = true;
          }
          if (method === 'turn/completed' && params.turn?.id === turnId) {
            const { status, error } = params.turn;
            if (status === 'completed') finish(null, reply);
            else finish(new Error(error?.message || turnError || `Codex turn ${status}`));
          }
        },
      };
      const timer = setTimeout(() => {
        finish(Object.assign(new Error('Codex timed out'), { status: 504 }));
        interrupt();
      }, timeout);
      this.waiters.add(waiter);
      this.request('turn/start', { threadId, input: Array.isArray(text) ? text : [{ type: 'text', text, text_elements: [] }] }, timeout).then(result => {
        turnId = result?.turn?.id;
        if (!turnId) { finish(new Error('Codex app-server did not return a turn id')); return; }
        if (['completed', 'failed', 'interrupted'].includes(result.turn.status)) {
          this.inProgress.delete(turnId);
          this.completedTurns.add(turnId);
        }
        if (result.turn.status === 'inProgress' && !this.completedTurns.has(turnId)) this.inProgress.set(turnId, threadId);
        if (done) { interrupt(); return; }
        for (const event of early) waiter.notify(event);
        early.length = 0;
      }, error => finish(error));
    });
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.resetConnection();
    const error = this.connectionError('connection closed');
    for (const pending of this.pending.values()) pending.reject(error);
    for (const waiter of [...this.waiters]) waiter.reject(error);
    ws?.close();
  }
}

module.exports = { AppServer };
