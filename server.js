'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { URL } = require('node:url');
const { AppServer } = require('./lib/appserver');
const { readRequest, prepareAttachments, parseUserContent, serveFile } = require('./lib/attachments');

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

if (!process.env.WEBHOOK_TOKEN) {
  console.error('WEBHOOK_TOKEN is required');
  process.exit(1);
}

const config = {
  port: positiveInteger('PORT', 8790),
  host: process.env.HOST || '127.0.0.1',
  bin: process.env.CODEX_BIN || '/root/.local/bin/codex',
  data: path.resolve(process.env.DATA_DIR || '/opt/linebot-relay/data'),
  work: path.resolve(process.env.WORK_DIR || '/opt/linebot-relay/work'),
  logs: path.resolve(process.env.LOG_DIR || '/opt/linebot-relay/logs'),
  uploads: path.resolve(process.env.UPLOAD_DIR || '/opt/linebot-relay/uploads'),
  maxBytes: positiveInteger('MAX_FILE_BYTES', 20 * 1024 * 1024),
  maxFiles: positiveInteger('MAX_FILES', 5),
  concurrency: positiveInteger('MAX_CONCURRENCY', 2),
  timeout: positiveInteger('CODEX_TIMEOUT_MS', 600000),
};
for (const dir of [config.data, config.work, config.logs]) fs.mkdirSync(dir, { recursive: true });
const sessionsFile = path.join(config.data, 'sessions.json');
const sessions = Object.create(null);
try {
  Object.assign(sessions, JSON.parse(fs.readFileSync(sessionsFile, 'utf8')));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const authHash = crypto.createHash('sha256').update(`Bearer ${process.env.WEBHOOK_TOKEN}`).digest();
const queues = new Map();
const historyDir = path.join(config.data, 'history');
fs.mkdirSync(historyDir, { recursive: true });
const requestsFile = path.join(config.data, 'requests.jsonl');
const live = new Map();
const bootTime = Date.now();
function safeKey(key) { return key === '.' || key === '..' ? `%${Buffer.from(key).toString('hex')}` : key.replace(/:/g, '_'); }
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const recentRequests = readLines(requestsFile).slice(-500).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
let requestLines = readLines(requestsFile).length;
const statsFile = path.join(config.data, 'stats.json');
let dayTotals = { day: taipeiDay(Date.now()), calls: 0, failures: 0, duration_ms: 0 };
try { const saved = JSON.parse(fs.readFileSync(statsFile, 'utf8')); if (saved.day === dayTotals.day) dayTotals = saved; }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  for (const line of readLines(requestsFile)) {
    const entry = JSON.parse(line);
    if (taipeiDay(entry.time) === dayTotals.day) { dayTotals.calls++; dayTotals.failures += entry.ok ? 0 : 1; dayTotals.duration_ms += entry.duration_ms; }
  }
}
function redact(value) {
  if (typeof value === 'string') return value.split(process.env.WEBHOOK_TOKEN).join('[redacted]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}
function appendHistory(key, entry) {
  entry = redact(entry);
  const file = path.join(historyDir, `${safeKey(key)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  const lines = readLines(file);
  if (lines.length > 550) fs.writeFileSync(file, lines.slice(-500).join('\n') + '\n');
}
function recordRequest(entry) {
  const secret = process.env.WEBHOOK_TOKEN;
  for (const field of ['session', 'error']) if (typeof entry[field] === 'string') entry[field] = entry[field].split(secret).join('[redacted]').slice(0, field === 'error' ? 200 : 128);
  if (dayTotals.day !== taipeiDay(entry.time)) dayTotals = { day: taipeiDay(entry.time), calls: 0, failures: 0, duration_ms: 0 };
  dayTotals.calls++;
  dayTotals.failures += entry.ok ? 0 : 1;
  dayTotals.duration_ms += entry.duration_ms;
  recentRequests.push(entry);
  if (recentRequests.length > 500) recentRequests.shift();
  try {
    fs.writeFileSync(`${statsFile}.tmp`, JSON.stringify(dayTotals), { mode: 0o600 });
    fs.renameSync(`${statsFile}.tmp`, statsFile);
    fs.appendFileSync(requestsFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    if (++requestLines > 2200) {
      const lines = readLines(requestsFile).slice(-2000);
      fs.writeFileSync(requestsFile, lines.join('\n') + '\n');
      requestLines = lines.length;
    }
  } catch (error) { console.error('Request logging failed:', error.code || 'unknown'); }
}
function validKey(key) { return typeof key === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(key); }
function limitOf(url, fallback, maximum) {
  const raw = url.searchParams.get('limit');
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw failure('Invalid limit', 400);
  return Math.min(Number(raw), maximum);
}
function taipeiDay(time) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time)); }
let active = 0;
const waiting = [];

async function acquire() {
  if (active < config.concurrency) { active++; return; }
  await new Promise(resolve => waiting.push(resolve));
}
function release() {
  if (waiting.length) waiting.shift()();
  else active--;
}
function persist() {
  const temporary = `${sessionsFile}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(sessions, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, sessionsFile);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function log(entry) {
  entry = redact(entry);
  // Only explicitly selected fields reach the log; never request headers or tokens.
  try {
    const file = path.join(config.logs, 'relay.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) {
      for (let i = 3; i >= 1; i--) {
        const source = i === 1 ? file : `${file}.${i - 1}`;
        if (fs.existsSync(source)) fs.renameSync(source, `${file}.${i}`);
      }
    }
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
  } catch (error) { console.error('Logging failed:', error.code || 'unknown'); }
  console.log(`${entry.request_id} ${entry.session || '-'} ${entry.status} ${entry.duration}ms`);
}
function failure(message, status = 500) { return Object.assign(new Error(message), { status }); }

const appserverSocket = process.env.CODEX_APP_SERVER_SOCK === 'off' ? null
  : path.resolve(process.env.CODEX_APP_SERVER_SOCK || '/root/.codex/app-server-control/app-server-control.sock');
const appserver = appserverSocket ? new AppServer(appserverSocket, { log, onConnect: watchThreads }) : null;

// Watch existing App threads even when no relay messages are being sent.
function watchThreads() {
  for (const id of new Set(Object.values(sessions).map(s => s.codex_session_id).filter(Boolean))) {
    void appserver.subscribe(id).catch(() => {});
  }
}
let watcherStopped = false;
function watcherTick() {
  if (watcherStopped) return;
  if (appserver && fs.existsSync(appserverSocket)) {
    void appserver.connect().then(watchThreads).catch(() => {});
  }
  watcherTimer = setTimeout(watcherTick, 2000);
  watcherTimer.unref?.();
}
let watcherTimer;
watcherTick();

function unixTime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return undefined;
  const date = new Date(Number(seconds) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
function threadHistory(thread, local) {
  const history = [], matchedErrors = new Set(), matchedUsers = new Set();
  for (const turn of thread.turns) {
    const started = unixTime(turn.startedAt), time = unixTime(turn.completedAt ?? turn.startedAt);
    const items = turn.items || [];
    for (const item of items.filter(item => item.type === 'userMessage')) {
      const { text, fullText, attachments } = parseUserContent(item);
      const match = local.find(entry => entry.role === 'user' && (entry.text === text || entry.text === fullText || entry.text.trim() === text) &&
        ['webhook', 'console'].includes(entry.source) && Math.abs(Date.parse(entry.time) - Date.parse(started)) <= 180000);
      if (match) matchedUsers.add(match);
      history.push({ role: 'user', text, time: started, source: match?.source || 'app', ...(attachments.length ? { attachments: attachments.map(file => ({ ...file, ...(match?.attachments?.find(localFile => localFile.path === file.path) || {}) })) } : match?.attachments?.length ? { attachments: match.attachments } : {}) });
      // The thread is authoritative for a turn that reached it; drop relay-side timeouts/disconnect errors for it.
      if (match?.request_id) {
        for (const entry of local) if (entry.role === 'error' && entry.request_id === match.request_id) matchedErrors.add(entry);
      }
    }
    if (turn.status !== 'inProgress') {
      const agents = items.filter(item => item.type === 'agentMessage');
      const finals = agents.filter(item => item.phase === 'final_answer');
      for (const item of finals.length ? finals : agents.slice(-1)) {
        history.push({ role: 'assistant', text: item.text || '', time, duration_ms: turn.durationMs ?? undefined, codex_session_id: thread.id });
      }
    }
    if (turn.status === 'failed') {
      const text = turn.error?.message || 'Codex turn failed';
      history.push({ role: 'error', text, time });
      for (const entry of local) if (entry.role === 'error' && entry.text === text && Math.abs(Date.parse(entry.time) - Date.parse(time)) <= 180000) matchedErrors.add(entry);
    }
  }
  const orphanErrors = local.filter(entry => entry.role === 'error' && !matchedErrors.has(entry));
  // Keep the user message of a relay-side failure that never reached the thread.
  const failedIds = new Set(orphanErrors.map(entry => entry.request_id).filter(Boolean));
  history.push(...local.filter(entry => entry.role === 'user' && !matchedUsers.has(entry) && failedIds.has(entry.request_id)), ...orphanErrors);
  return history.sort((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0));
}
async function sessionHistory(key, limit) {
  const local = readLines(path.join(historyDir, `${safeKey(key)}.jsonl`)).map(JSON.parse);
  const id = sessions[key]?.codex_session_id;
  if (appserver?.connected && id) {
    try {
      const cache = await appserver.readThread(id);
      const running = cache.thread.turns.some(turn => turn.status === 'inProgress') || appserver.threadState(id).status === 'active';
      return { key, session: key, history: threadHistory({ ...cache.thread, id }, local).slice(-limit), source: 'thread', revision: cache.revision, running };
    } catch { /* Preserve local history if the App is unavailable. */ }
  }
  return { key, session: key, history: local.slice(-limit), source: 'local', running: !!live.get(key)?.running };
}
async function sessionListing() {
  const ids = [...new Set(Object.values(sessions).map(s => s.codex_session_id).filter(Boolean))];
  if (appserver?.connected && ids.length) {
    let timer;
    try {
      await Promise.race([
        Promise.allSettled(ids.map(id => appserver.readThread(id, 10000))),
        new Promise(resolve => { timer = setTimeout(resolve, 2800); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  const keys = new Set([...Object.keys(sessions), ...live.keys()]);
  return [...keys].map(key => {
    const state = live.get(key), stored = sessions[key];
    const watched = appserver?.connected && stored?.codex_session_id ? appserver.threadState(stored.codex_session_id) : null;
    const thread = watched?.cache?.thread;
    const turns = thread?.turns || [];
    const last = turns.at(-1);
    return { key, codex_session_id: null, messages: 0, created_at: state?.created_at, updated_at: state?.updated_at, ...stored,
      ...(thread ? { messages: turns.filter(t => t.status === 'completed').length,
        updated_at: unixTime(last?.completedAt ?? last?.startedAt ?? thread.updatedAt) || stored?.updated_at } : {}),
      status: state?.running || watched?.status === 'active' || turns.some(t => t.status === 'inProgress') ? 'running' : state?.queued ? 'queued' : 'idle', queued: state?.queued || 0 };
  }).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

async function runCodex(key, message, sessionId, input) {
  if (!appserver || !fs.existsSync(appserverSocket)) return runCodexExec(key, message, sessionId);
  let submitted = false;
  try {
    await appserver.connect();
    let threadId = sessionId;
    if (threadId) {
      await appserver.subscribe(threadId);
    } else {
      const workdir = path.join(config.work, safeKey(key));
      fs.mkdirSync(workdir, { recursive: true });
      const params = { cwd: workdir, sandbox: 'workspace-write', approvalPolicy: 'never', serviceName: 'linebot-relay' };
      if (process.env.CODEX_MODEL) params.model = process.env.CODEX_MODEL;
      const result = await appserver.request('thread/start', params);
      threadId = result?.thread?.id;
      if (typeof threadId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(threadId)) throw failure('Codex did not return a valid session id');
      appserver.subscribed.add(threadId);
      const now = new Date().toISOString();
      sessions[key] = { codex_session_id: threadId, created_at: now, updated_at: now, messages: 0 };
      persist();
    }
    // Once sent, a lost response cannot prove the turn was not accepted.
    submitted = true;
    const reply = await appserver.runTurn(threadId, input || message, config.timeout);
    return { session: key, codex_session_id: threadId, reply, transport: 'app-server' };
  } catch (error) {
    if (!submitted && error.appserverConnection) return runCodexExec(key, message, sessionId);
    error.transport = 'app-server';
    throw error;
  }
}

function runCodexExec(key, message, sessionId) {
  return new Promise((resolve, reject) => {
    const workdir = path.join(config.work, safeKey(key));
    fs.mkdirSync(workdir, { recursive: true });
    const output = path.join(config.data, `reply-${crypto.randomUUID()}.tmp`);
    const args = sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"']
      : ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-C', workdir];
    if (process.env.CODEX_MODEL) args.push('-m', process.env.CODEX_MODEL);
    args.push('-o', output);
    if (sessionId) args.push(sessionId);
    args.push('-');
    let child;
    try { child = spawn(config.bin, args, { cwd: workdir, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let buffer = '', stderr = '', reply = '', id = sessionId, eventError, spawnError;
    let timedOut = false, activeWriter = false;
    function parse(line) {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== 'object') return;
      if (/^(thread\.started|session[._](started|configured))$/.test(event.type)) {
        id = event.thread_id || event.session_id || event.conversation_id || event.msg?.session_id || id;
      }
      if (event.type === 'item.completed' && ['agent_message', 'assistant_message'].includes(event.item?.type) && typeof event.item.text === 'string') reply = event.item.text;
      if (event.msg?.type === 'agent_message' && typeof event.msg.message === 'string') reply = event.msg.message;
      if (event.type === 'turn.failed') eventError = event.error?.message || 'Codex turn failed';
      if (event.type === 'error') eventError = event.message || event.error?.message || 'Codex error';
      if (/already has an active writer/i.test(eventError || '')) activeWriter = true;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.on('data', chunk => {
      const combined = stderr + chunk.toString();
      if (/already has an active writer/i.test(combined)) activeWriter = true;
      stderr = combined.slice(-2048);
    });
    child.on('error', error => { spawnError = error; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') spawnError = error; });
    child.stdin.end(message);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
    }, config.timeout);
    child.on('close', code => {
      clearTimeout(timer);
      if (buffer) parse(buffer);
      try {
        if (timedOut) throw failure('Codex timed out', 504);
        if (spawnError) throw spawnError;
        if (activeWriter) throw failure('该 Codex 会话正被 Codex App 占用（active writer），且无法连接 app-server，暂时无法投递；请确认 app-server 正在运行', 409);
        if (eventError) throw failure(eventError);
        if (code !== 0) throw failure(stderr || `Codex exited with code ${code}`);
        try {
          const contents = fs.readFileSync(output, 'utf8');
          if (contents.trim()) reply = contents;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) throw failure('Codex did not return a valid session id');
        resolve({ session: key, codex_session_id: id, reply });
      } catch (error) { error.transport = 'exec'; reject(error); }
      finally { try { fs.unlinkSync(output); } catch {} }
    });
  });
}

function enqueue(body, source, requestId) {
  const now = new Date().toISOString();
  const state = live.get(body.session) || { running: false, queued: 0, created_at: now, updated_at: now };
  state.queued++;
  state.updated_at = now;
  live.set(body.session, state);
  const previous = queues.get(body.session) || Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    await acquire();
    state.queued--;
    state.running = true;
    const started = Date.now();
    try {
      appendHistory(body.session, { role: 'user', text: body.message, ...(body.attachments.length ? { attachments: body.attachments } : {}), time: new Date().toISOString(), source, request_id: requestId });
      if (body.codex_session_id) {
        const now = new Date().toISOString();
        sessions[body.session] = { codex_session_id: body.codex_session_id, created_at: sessions[body.session]?.created_at || now, updated_at: now, messages: sessions[body.session]?.messages || 0 };
        persist();
        if (appserver) void appserver.subscribe(body.codex_session_id).catch(() => {});
      }
      const result = await runCodex(body.session, body.input ? body.input.filter(part => part.type === 'text').map(part => part.text).join('\n') : body.message, sessions[body.session]?.codex_session_id, body.input);
      const now = new Date().toISOString();
      sessions[body.session] = { codex_session_id: result.codex_session_id, created_at: sessions[body.session]?.created_at || now, updated_at: now, messages: (sessions[body.session]?.messages || 0) + 1 };
      persist();
      appendHistory(body.session, { role: 'assistant', text: result.reply, time: now, duration_ms: Date.now() - started, codex_session_id: result.codex_session_id, request_id: requestId });
      return result;
    } catch (error) {
      appendHistory(body.session, { role: 'error', text: error.message, time: new Date().toISOString(), duration_ms: Date.now() - started, codex_session_id: sessions[body.session]?.codex_session_id || null, request_id: requestId });
      throw error;
    } finally {
      state.running = false;
      if (!state.queued) live.delete(body.session);
      release();
    }
  });
  queues.set(body.session, job);
  job.finally(() => { if (queues.get(body.session) === job) queues.delete(body.session); }).catch(() => {});
  return job;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function validate(body) {
  if (!body || typeof body !== 'object' || typeof body.session !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.session) || (body.message !== undefined && typeof body.message !== 'string') || (!body.message?.trim() && !body.files?.length && !body.file_urls?.length && !body._fileCount)) throw failure('Invalid session or message', 400);
  if (body.codex_session_id !== undefined && (typeof body.codex_session_id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(body.codex_session_id))) throw failure('Invalid codex_session_id', 400);
  if (body.callback_url !== undefined) {
    let url;
    try { url = new URL(body.callback_url); } catch { throw failure('Invalid callback_url', 400); }
    if (typeof body.callback_url !== 'string' || !['http:', 'https:'].includes(url.protocol)) throw failure('Invalid callback_url', 400);
  }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now(), requestId = crypto.randomUUID();
  let body, route;
  let requestRecorded = false;
  const record = (status, extra = {}) => {
    log({ request_id: requestId, session: body?.session, status, duration: Date.now() - started, ...extra });
    if (['/webhook', '/api/send'].includes(route) && !requestRecorded && status !== 202) {
      requestRecorded = true;
      recordRequest({ time: new Date().toISOString(), request_id: requestId, session: typeof body?.session === 'string' ? body.session.slice(0, 128) : null, source: route === '/api/send' ? 'console' : 'webhook', method: req.method, path: route, status, ok: status >= 200 && status < 300, duration_ms: Date.now() - started, error: typeof extra.error === 'string' ? extra.error.slice(0, 200) : null });
    }
  };
  try {
    const url = new URL(req.url, 'http://localhost');
    // Preserve dot keys: URL.pathname normalizes literal and encoded dot segments.
    const rawPath = req.url.split('?')[0];
    route = rawPath.startsWith('/api/sessions/') ? rawPath : url.pathname;
    if (req.method === 'GET' && ['/console', '/console/'].includes(route)) {
      const html = fs.readFileSync(path.join(__dirname, 'console.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self'; frame-ancestors 'none'" });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && route === '/health') { send(res, 200, { ok: true }); record(200); return; }
    if (!(req.method === 'GET' && route === '/sessions') && !(req.method === 'POST' && route === '/webhook') && !route.startsWith('/api/')) { send(res, 404, { error: 'Not found' }); record(404); return; }
    const supplied = crypto.createHash('sha256').update(req.headers.authorization || '').digest();
    if (!crypto.timingSafeEqual(supplied, authHash)) { send(res, 401, { error: 'Unauthorized' }); record(401); return; }
    if (route === '/sessions') {
      const listing = await sessionListing();
      send(res, 200, { sessions: Object.fromEntries(listing.filter(s => sessions[s.key]).map(({ key, status, queued, ...entry }) => [key, entry])) }); record(200); return;
    }
    if (route.startsWith('/api/') && route !== '/api/send') {
      if (req.method === 'GET' && route === '/api/files') { serveFile(req, res, url.searchParams.get('path'), config.uploads); return; }
      if (req.method === 'GET' && route === '/api/whoami') { send(res, 200, { ok: true }); return; }
      if (req.method === 'GET' && route === '/api/sessions') {
        const listing = await sessionListing();
        send(res, 200, { sessions: listing }); return;
      }
      if (req.method === 'GET' && route === '/api/requests') { send(res, 200, { requests: recentRequests.slice(-limitOf(url, 100, 500)).reverse() }); return; }
      if (req.method === 'GET' && route === '/api/stats') {
        const today = dayTotals.day === taipeiDay(Date.now()) ? dayTotals : { calls: 0, failures: 0, duration_ms: 0 };
        send(res, 200, { today: { calls: today.calls, failures: today.failures, avg_duration_ms: today.calls ? Math.round(today.duration_ms / today.calls) : 0 }, total_sessions: Object.keys(sessions).length, running: [...live.values()].filter(state => state.running).length, queued: [...live.values()].reduce((sum, state) => sum + state.queued, 0), uptime_s: Math.floor((Date.now() - bootTime) / 1000) }); return;
      }
      const match = route.match(/^\/api\/sessions\/([^/]+)(\/history)?$/);
      if (match) {
        let key;
        try {
          key = decodeURIComponent(match[1]);
          // Also accept double-encoded dot keys from browser clients.
          if (/^(%2e){1,2}$/i.test(key)) key = decodeURIComponent(key);
        } catch { throw failure('Invalid session', 400); }
        if (!validKey(key)) throw failure('Invalid session', 400);
        const file = path.join(historyDir, `${safeKey(key)}.jsonl`);
        if (req.method === 'GET' && match[2]) { send(res, 200, await sessionHistory(key, limitOf(url, 200, 550))); return; }
        if (req.method === 'DELETE' && !match[2]) {
          if (live.has(key)) throw failure('Session is running or queued', 409);
          if (!sessions[key] && !fs.existsSync(file)) throw failure('Session not found', 404);
          delete sessions[key]; persist();
          try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          send(res, 200, { ok: true }); return;
        }
      }
      send(res, 404, { error: 'Not found' }); return;
    }
    if (req.method !== 'POST') { send(res, 404, { error: 'Not found' }); record(404); return; }
    const parsed = await readRequest(req, config);
    body = parsed.body;
    if (body && typeof body === 'object') body._fileCount = parsed.files.length;
    validate(body);
    if (!body.message?.trim()) body.message = '请查看附件。';
    const prepared = await prepareAttachments(body, parsed.files, config, safeKey);
    body.attachments = prepared.attachments;
    body.input = prepared.input;
    const job = enqueue(body, route === '/api/send' ? 'console' : 'webhook', requestId);
    if (route === '/webhook' && body.callback_url !== undefined) {
      send(res, 202, { accepted: true, session: body.session });
      record(202);
      void (async () => {
        let payload;
        try {
          payload = await job;
          record(200, { message: body.message.slice(0, 200), reply: payload.reply.slice(0, 200), transport: payload.transport || 'exec' });
        } catch (error) {
          payload = { session: body.session, error: error.message };
          record(error.status || 500, { error: error.message, ...(error.transport ? { transport: error.transport } : {}) });
        }
        try {
          const response = await fetch(body.callback_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000), redirect: 'error' });
          await response.body?.cancel();
          if (!response.ok) throw failure(`Callback HTTP ${response.status}`);
        } catch (error) { record('callback_failed', { error: error.message }); }
      })();
    } else {
      const result = await job;
      send(res, 200, result);
      record(200, { message: body.message.slice(0, 200), reply: result.reply.slice(0, 200), transport: result.transport || 'exec' });
    }
  } catch (error) {
    if (!res.headersSent && !res.destroyed) send(res, error.status || 500, { error: error.message, ...(typeof body?.session === 'string' ? { session: body.session } : {}) });
    record(error.status || 500, { error: error.message, ...(error.transport ? { transport: error.transport } : {}) });
  }
});
server.requestTimeout = 0;
server.listen(config.port, config.host, () => console.log(`linebot-relay listening on ${config.host}:${config.port}`));

function shutdown() {
  watcherStopped = true;
  clearTimeout(watcherTimer);
  appserver?.close();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.once?.('SIGTERM', shutdown);
process.once?.('SIGINT', shutdown);
