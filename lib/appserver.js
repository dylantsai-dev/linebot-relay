'use strict';

const { UnixWebSocket } = require('./ws-unix');

class AppServer {
  constructor(socketPath, { log = () => {}, requestTimeout = 30000, backoff = 2000, onConnect = () => {}, promptGrace = 30 * 60000 } = {}) {
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
    // Live (in-progress) turn per thread, built from streaming notifications.
    this.liveListeners = new Set();
    // Server -> client requests (approvals, questions) waiting for a console answer, by public id.
    this.prompts = new Map();
    this.promptListeners = new Set();
    this.promptSeq = 0;
    // While a prompt waits for a person, a turn's timeout is extended by up to this much.
    this.promptGrace = promptGrace;
  }

  onPrompt(listener) { this.promptListeners.add(listener); return () => this.promptListeners.delete(listener); }
  emitPrompt(threadId, event) { for (const listener of [...this.promptListeners]) { try { listener(threadId, event); } catch { /* listener errors stay local */ } } }
  promptsFor(threadId) { return [...this.prompts.values()].filter(prompt => prompt.threadId === threadId).map(prompt => prompt.view); }
  hasPrompts(threadId) { for (const prompt of this.prompts.values()) if (prompt.threadId === threadId) return true; return false; }
  promptById(id) { return this.prompts.get(id) || null; }
  dropPrompt(prompt, reason) {
    if (this.prompts.get(prompt.view.id) !== prompt) return;
    this.prompts.delete(prompt.view.id);
    this.emitPrompt(prompt.threadId, { type: 'prompt_resolved', id: prompt.view.id, reason });
  }
  // JSON-RPC replies to a server request, on the connection that asked.
  respond(id, result, ws = this.ws) { return this.reply(ws, { id, result }); }
  respondError(id, error, ws = this.ws) { return this.reply(ws, { id, error: { code: error?.code ?? -32000, message: String(error?.message || 'Request declined') } }); }
  reply(ws, message) {
    if (!ws?.open) throw this.connectionError('socket not open');
    ws.send(JSON.stringify(message));
    return true;
  }
  serverRequest(message) {
    const { id, method } = message;
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    this.log({ event: 'appserver_request', method });
    const threadId = typeof params.threadId === 'string' ? params.threadId : typeof params.conversationId === 'string' ? params.conversationId : null;
    const view = threadId ? promptView(method, params, this.threads.get(threadId)?.live) : null;
    if (!view) {
      // Nothing in the console can answer it: fail it at once so the turn is never stuck waiting.
      this.log({ event: 'appserver_request_unsupported', method });
      try { this.respondError(id, { code: -32601, message: `Unsupported by this client: ${method}` }); } catch { /* socket gone */ }
      return;
    }
    view.id = `p${++this.promptSeq}${Math.random().toString(36).slice(2, 8)}`;
    view.created_at = new Date().toISOString();
    const prompt = { view, rawId: id, method, params, threadId, turnId: typeof params.turnId === 'string' ? params.turnId : null, ws: this.ws };
    this.prompts.set(view.id, prompt);
    this.emitPrompt(threadId, { type: 'prompt', prompt: view });
  }
  // Answer a pending prompt. answer: { decision } for approvals, { answers: { qid: string|string[] } } for questions.
  answerPrompt(id, answer = {}) {
    const prompt = this.prompts.get(id);
    if (!prompt) throw Object.assign(new Error('该请求已处理或已失效'), { status: 404 });
    const result = promptResult(prompt, answer);
    if (prompt.ws !== this.ws || !this.ws?.open) { this.dropPrompt(prompt, 'disconnected'); throw Object.assign(new Error('后台连接已断开，该请求已失效'), { status: 409 }); }
    this.respond(prompt.rawId, result, prompt.ws);
    this.dropPrompt(prompt, 'answered');
    // Questions have no cancel in the protocol; 停止回合 there interrupts the turn after answering.
    if (answer.decision === 'cancel' && ['input', 'permissions'].includes(prompt.view.kind) && prompt.turnId) this.request('turn/interrupt', { threadId: prompt.threadId, turnId: prompt.turnId }).catch(() => {});
    return { id, kind: prompt.view.kind, decision: answer.decision || null };
  }

  onLive(listener) { this.liveListeners.add(listener); return () => this.liveListeners.delete(listener); }
  emitLive(threadId, event) { for (const listener of [...this.liveListeners]) { try { listener(threadId, event); } catch { /* listener errors stay local */ } } }
  liveTurn(threadId, turnId) {
    const state = this.threadState(threadId);
    if (!state.live || (turnId && state.live.turnId !== turnId)) state.live = { turnId: turnId || null, startedAt: Date.now(), items: [] };
    return state.live;
  }
  liveItem(live, id, init) {
    let item = live.items.find(entry => entry.id === id);
    if (!item) {
      item = { id, ...init };
      live.items.push(item);
      if (live.items.length > 300) live.items.splice(0, live.items.length - 300);
    }
    return item;
  }
  // Seed a live turn from a thread/read snapshot (the relay joined mid-turn).
  seedLive(threadId, turn) {
    const state = this.threadState(threadId);
    if (!turn || turn.status !== 'inProgress' || state.live?.turnId === turn.id) return state.live || null;
    const live = this.liveTurn(threadId, turn.id);
    for (const raw of turn.items || []) { const item = summarizeItem(raw); if (item) Object.assign(this.liveItem(live, item.id, item), item); }
    return live;
  }
  trackLive(method, params) {
    const threadId = params.threadId;
    const state = this.threadState(threadId);
    if (method === 'turn/started') {
      const live = this.liveTurn(threadId, params.turn?.id);
      this.emitLive(threadId, { type: 'turn', status: 'started', turnId: live.turnId });
      return;
    }
    if (method === 'turn/completed') {
      if (state.live && (!params.turn?.id || !state.live.turnId || state.live.turnId === params.turn.id)) state.live = null;
      this.emitLive(threadId, { type: 'turn', status: params.turn?.status || 'completed', turnId: params.turn?.id || null });
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const summary = summarizeItem(params.item);
      if (!summary) return;
      const live = this.liveTurn(threadId, params.turnId);
      const item = Object.assign(this.liveItem(live, summary.id, summary), summary, { done: method === 'item/completed' });
      this.emitLive(threadId, { type: 'item', item });
      return;
    }
    const deltaKinds = { 'item/agentMessage/delta': ['text', 'text'], 'item/reasoning/summaryTextDelta': ['reasoning', 'text'], 'item/reasoning/textDelta': ['reasoning', 'text'],
      'item/plan/delta': ['plan', 'text'], 'item/commandExecution/outputDelta': ['command', 'output'], 'item/fileChange/outputDelta': ['file', 'output'] };
    const kind = deltaKinds[method];
    if (kind && typeof params.delta === 'string' && params.itemId) {
      const live = this.liveTurn(threadId, params.turnId);
      const item = this.liveItem(live, params.itemId, { kind: kind[0], text: '', done: false });
      const field = kind[1];
      item[field] = ((item[field] || '') + params.delta);
      const cap = field === 'output' ? 4000 : 400000;
      if (item[field].length > cap) item[field] = item[field].slice(-cap);
      this.emitLive(threadId, { type: 'delta', id: params.itemId, field, delta: params.delta, kind: item.kind });
    }
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
    if (message.method && message.id !== undefined) { this.serverRequest(message); return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (message.error) pending?.reject(new Error(message.error.message || '后台服务请求失败'));
      else pending?.resolve(message.result);
      return;
    }
    const { method, params } = message;
    if (params?.threadId) {
      const state = this.threadState(params.threadId);
      // Streaming deltas do not change what thread/read returns for history; skip cache churn.
      if (!/delta$/i.test(method || '')) state.revision++;
      if (method === 'thread/status/changed') state.status = params.status?.type || params.status;
      if (method === 'turn/started' && params.turn?.id) {
        this.inProgress.set(params.turn.id, params.threadId);
        state.status = 'active';
      }
      if (method === 'serverRequest/resolved') {
        // Answered elsewhere (e.g. the desktop App) or withdrawn by the server.
        for (const prompt of [...this.prompts.values()]) if (prompt.threadId === params.threadId && prompt.rawId === params.requestId) this.dropPrompt(prompt, 'resolved');
      }
      if (method === 'turn/completed') {
        for (const prompt of [...this.prompts.values()]) if (prompt.threadId === params.threadId && (!prompt.turnId || !params.turn?.id || prompt.turnId === params.turn.id)) this.dropPrompt(prompt, 'turn_ended');
        this.inProgress.delete(params.turn?.id);
        this.completedTurns.add(params.turn?.id);
        state.status = 'idle';
      }
      this.trackLive(method, params);
    }
    for (const waiter of [...this.waiters]) waiter.notify(message);
  }

  resetConnection() {
    for (const prompt of [...this.prompts.values()]) this.dropPrompt(prompt, 'disconnected');
    this.subscribed.clear();
    this.subscribing.clear();
    this.inProgress.clear();
    this.completedTurns.clear();
    for (const [threadId, state] of this.threads) {
      state.revision++;
      state.status = 'idle';
      state.cache = null;
      state.reading = null;
      if (state.live) { state.live = null; this.emitLive(threadId, { type: 'turn', status: 'disconnected', turnId: null }); }
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

  async listModels({ includeHidden = false } = {}) {
    const models = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const result = await this.request('model/list', { ...(cursor ? { cursor } : {}), ...(includeHidden ? { includeHidden: true } : {}) });
      for (const m of result?.data || []) if (includeHidden || !m.hidden) models.push(m);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return models;
  }

  async getRateLimits(params = {}) {
    return this.request('account/rateLimits/read', params);
  }


  async runTurn(threadId, text, timeout, { model, effort, serviceTier } = {}) {
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
        timer.clear();
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
      const timer = this.turnTimer(threadId, timeout, () => {
        finish(Object.assign(new Error('响应超时'), { status: 504 }));
        interrupt();
      });
      this.waiters.add(waiter);
      this.request('turn/start', { threadId, input: Array.isArray(text) ? text : [{ type: 'text', text, text_elements: [] }], ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(serviceTier ? { serviceTier } : {}) }, timeout).then(result => {
        turnId = result?.turn?.id;
        if (!turnId) { finish(new Error('后台服务没有返回轮次 ID')); return; }
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

  // A turn timeout that waits (up to promptGrace longer) while a person still has to answer a prompt.
  turnTimer(threadId, timeout, onTimeout) {
    const deadline = Date.now() + timeout + this.promptGrace;
    let handle;
    const arm = delay => { handle = setTimeout(() => {
      if (this.hasPrompts(threadId) && Date.now() < deadline) arm(Math.min(timeout, Math.max(10, deadline - Date.now())));
      else onTimeout();
    }, delay); };
    arm(timeout);
    return { clear: () => clearTimeout(handle) };
  }

  // The id of the turn currently running on a thread (relay-, App- or CLI-started), if known.
  activeTurnId(threadId) {
    let found = null;
    for (const [turnId, owner] of this.inProgress) if (owner === threadId) found = turnId;
    const state = this.threads.get(threadId);
    return found || (state?.status === 'active' && state.live?.turnId) || null;
  }
  busy(threadId) {
    if (!this.connected) return false;
    const state = this.threads.get(threadId);
    return state?.status === 'active' || [...this.inProgress.values()].includes(threadId);
  }
  // Ask the app-server whether the thread really has an in-progress turn (fixes a missed completion).
  async refreshActive(threadId) {
    const cache = await this.readThread(threadId, 0);
    const turn = cache.thread.turns.find(t => t.status === 'inProgress');
    const state = this.threadState(threadId);
    if (turn) { this.inProgress.set(turn.id, threadId); state.status = 'active'; this.seedLive(threadId, turn); return turn.id; }
    for (const [turnId, owner] of [...this.inProgress]) if (owner === threadId) this.inProgress.delete(turnId);
    if (state.status === 'active') state.status = 'idle';
    return null;
  }
  // Inject input into the running turn (app-server turn/steer). Resolves to the turn id it joined.
  async steerTurn(threadId, turnId, input) {
    await this.subscribe(threadId);
    const result = await this.request('turn/steer', { threadId, expectedTurnId: turnId, input });
    return result?.turnId || turnId;
  }
  interruptTurn(threadId, turnId) { return this.request('turn/interrupt', { threadId, turnId }); }
  // Wait for a turn that is already running (e.g. one we steered into) and return its final reply.
  waitTurn(threadId, turnId, timeout) {
    return new Promise((resolve, reject) => {
      let reply = '', finalAnswer = false, done = false;
      const finish = (error, value) => { if (done) return; done = true; timer.clear(); this.waiters.delete(waiter); if (error) reject(error); else resolve(value); };
      const waiter = {
        reject: error => finish(error),
        notify: ({ method, params }) => {
          if (params?.threadId !== threadId) return;
          if (method === 'item/completed' && params.turnId === turnId && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
            if (params.item.phase === 'final_answer' || !finalAnswer) reply = params.item.text;
            if (params.item.phase === 'final_answer') finalAnswer = true;
          }
          if (method === 'turn/completed' && params.turn?.id === turnId) {
            const { status, error } = params.turn;
            if (status === 'completed') finish(null, reply);
            else finish(new Error(error?.message || `Codex turn ${status}`));
          }
        },
      };
      const timer = this.turnTimer(threadId, timeout, () => finish(Object.assign(new Error('响应超时'), { status: 504 })));
      this.waiters.add(waiter);
      if (this.completedTurns.has(turnId)) finish(null, reply);
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

// Compact, display-only view of a thread item: no base64 payloads, bounded output.
function shellCommand(command) {
  const text = Array.isArray(command) ? command.join(' ') : String(command || '');
  const match = /^\/bin\/(?:ba|z)?sh -lc '([\s\S]*)'$/.exec(text);
  return (match ? match[1].replace(/'\\''/g, "'") : text).slice(0, 600);
}
function summarizeItem(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string') return null;
  const status = item.status && typeof item.status === 'object' ? item.status.type : item.status;
  switch (item.type) {
    case 'userMessage': case 'hookPrompt': return null;
    case 'agentMessage': return { id: item.id, kind: 'text', text: item.text || '', phase: item.phase || null };
    case 'reasoning': return { id: item.id, kind: 'reasoning', text: [...(item.summary || [])].join('\n') };
    case 'plan': return { id: item.id, kind: 'plan', text: item.text || '' };
    case 'commandExecution': return { id: item.id, kind: 'command', title: shellCommand(item.command), status, exitCode: item.exitCode ?? null, ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput.slice(-4000) } : {}) };
    case 'mcpToolCall': return { id: item.id, kind: 'tool', title: `${item.server}.${item.tool}`, status };
    case 'dynamicToolCall': return { id: item.id, kind: 'tool', title: `${item.namespace ? `${item.namespace}.` : ''}${item.tool}`, status };
    case 'collabAgentToolCall': return { id: item.id, kind: 'tool', title: `agent.${item.tool}`, status };
    case 'webSearch': return { id: item.id, kind: 'search', title: item.query || item.action?.query || '网页搜索', status };
    case 'fileChange': return { id: item.id, kind: 'file', title: (item.changes || []).map(change => change.path).filter(Boolean).slice(0, 6).join(', ') || '修改文件', status };
    case 'imageGeneration': return { id: item.id, kind: 'image', title: '生成图片', status, ...(typeof item.savedPath === 'string' ? { path: item.savedPath } : {}) };
    case 'imageView': return { id: item.id, kind: 'image', title: '查看图片', status: 'completed', path: item.path };
    case 'contextCompaction': return { id: item.id, kind: 'tool', title: '压缩上下文', status };
    default: return { id: item.id, kind: 'tool', title: String(item.type || 'item'), status };
  }
}

// ----- server requests -> console prompts (public shape; never names the backend) -----
const DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'];
const clipText = (value, size) => typeof value === 'string' ? value.slice(0, size) : null;
function promptView(method, params, live) {
  const reason = clipText(params.reason, 2000);
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval': {
      const command = params.command == null ? null : shellCommand(params.command);
      return { kind: 'command', title: '运行命令', reason, command: command || null, cwd: clipText(params.cwd, 500), decisions: DECISIONS };
    }
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval': {
      let files = [];
      if (params.fileChanges && typeof params.fileChanges === 'object') files = Object.entries(params.fileChanges).map(([file, change]) => ({ path: file, change: change?.type || 'update' }));
      else if (params.itemId && live) {
        const item = live.items.find(entry => entry.id === params.itemId);
        if (item?.title && item.title !== '修改文件') files = item.title.split(', ').map(file => ({ path: file, change: 'update' }));
      }
      return { kind: 'file', title: '修改文件', reason, files: files.slice(0, 40), grant_root: clipText(params.grantRoot, 500), decisions: DECISIONS };
    }
    case 'item/tool/requestUserInput': {
      const questions = (Array.isArray(params.questions) ? params.questions : []).filter(q => q && typeof q.id === 'string').slice(0, 20).map(q => ({
        id: q.id, header: clipText(q.header, 200) || '', question: clipText(q.question, 2000) || '',
        options: (Array.isArray(q.options) ? q.options : []).filter(o => o && typeof o.label === 'string').slice(0, 20).map(o => ({ label: o.label.slice(0, 300), description: clipText(o.description, 600) || '' })),
        isOther: !!q.isOther, isSecret: !!q.isSecret,
      }));
      if (!questions.length) return null;
      return { kind: 'input', title: '需要你的回答', reason: null, questions };
    }
    case 'item/permissions/requestApproval': {
      const fsPerm = params.permissions?.fileSystem, net = params.permissions?.network;
      const parts = [];
      const paths = list => (Array.isArray(list) ? list : []).map(String).slice(0, 8);
      if (paths(fsPerm?.write).length) parts.push(`写入：${paths(fsPerm.write).join('、')}`);
      if (paths(fsPerm?.read).length) parts.push(`读取：${paths(fsPerm.read).join('、')}`);
      if (Array.isArray(fsPerm?.entries) && fsPerm.entries.length) parts.push(`文件访问 ${fsPerm.entries.length} 项`);
      if (net?.enabled) parts.push('网络访问');
      return { kind: 'permissions', title: '申请更多权限', reason, summary: parts.join(' · ') || '额外权限', cwd: clipText(params.cwd, 500), decisions: DECISIONS };
    }
    default: return null;
  }
}
function badAnswer(message) { return Object.assign(new Error(message), { status: 400 }); }
function promptResult(prompt, answer) {
  const { method, params, view } = prompt;
  if (view.kind === 'input') {
    if (answer.decision === 'cancel') return { answers: Object.fromEntries(view.questions.map(q => [q.id, { answers: [] }])) };
    if (!answer.answers || typeof answer.answers !== 'object' || Array.isArray(answer.answers)) throw badAnswer('请提供回答');
    const answers = {};
    for (const q of view.questions) {
      const raw = answer.answers[q.id];
      const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).filter(v => typeof v === 'string').map(v => v.slice(0, 4000)).filter(v => v.trim()).slice(0, 20);
      answers[q.id] = { answers: list };
    }
    return { answers };
  }
  const decision = answer.decision;
  if (!DECISIONS.includes(decision)) throw badAnswer('decision 应为 accept、acceptForSession、decline 或 cancel');
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    const legacy = { accept: 'approved', acceptForSession: 'approved_for_session', decline: { denied: { rejection: 'The user declined this request.' } }, cancel: 'abort' };
    return { decision: legacy[decision] };
  }
  if (view.kind === 'permissions') {
    if (decision === 'accept' || decision === 'acceptForSession') return { permissions: params.permissions || {}, scope: decision === 'acceptForSession' ? 'session' : 'turn' };
    return { permissions: {} };
  }
  return { decision };
}

module.exports = { AppServer, summarizeItem };
