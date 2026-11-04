'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { URL } = require('node:url');
const { AppServer } = require('./lib/appserver');
const { readRequest, prepareAttachments, parseUserContent, serveFile } = require('./lib/attachments');
const { Users } = require('./lib/users');
const { Media, rewriteMarkdown, itemImages, localPath } = require('./lib/media');

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
  codexHome: path.resolve(process.env.CODEX_HOME || '/root/.codex'),
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
const media = new Media(process.env.WEBHOOK_TOKEN);
const users = new Users(path.resolve(process.env.USERS_DB || path.join(config.data, 'users.db')));
// Optional first-admin seed; ignored once any admin exists.
async function seedAdmin() {
  const username = process.env.ADMIN_USERNAME, password = process.env.ADMIN_PASSWORD;
  if (!username || !password || users.hasAdmin()) return;
  try { await users.create({ username, password, role: 'admin' }); console.log(`Seeded admin user ${username}`); }
  catch (error) { console.error('Admin seed failed:', error.message); }
}
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
      const before = history.length;
      for (const item of finals.length ? finals : agents.slice(-1)) {
        history.push({ role: 'assistant', text: item.text || '', time, duration_ms: turn.durationMs ?? undefined, codex_session_id: thread.id });
      }
      // Generated / viewed images live in their own items, not in the reply text.
      const images = items.flatMap(itemImages);
      if (images.length) {
        if (history.length > before) history.at(-1).images = images;
        else history.push({ role: 'assistant', text: '', time, duration_ms: turn.durationMs ?? undefined, codex_session_id: thread.id, images });
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
// ----- images: signed URLs for files Codex generated or referenced -----
function mediaRoots(key, thread) {
  const id = thread?.id || sessions[key]?.codex_session_id;
  return [path.join(config.work, safeKey(key)), path.join(config.uploads, safeKey(key)), path.join(config.codexHome, 'attachments'),
    ...(id ? [path.join(config.codexHome, 'generated_images', id)] : []),
    ...(thread ? [thread.cwd, ...(thread.environments || []).flatMap(env => [env?.cwd, ...(Array.isArray(env?.runtimeWorkspaceRoots) ? env.runtimeWorkspaceRoots : [])])] : [])]
    .filter(root => typeof root === 'string' && root);
}
function principalUid(principal) { return principal.user?.id || 0; }
function cachedThread(key) {
  const id = sessions[key]?.codex_session_id;
  return id && appserver ? appserver.threads.get(id)?.cache?.thread || (id ? { id } : null) : (id ? { id } : null);
}
function insideDir(root, target) { const relative = path.relative(root, target); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
function decorateEntry(entry, key, principal, roots) {
  const uid = principalUid(principal);
  const toUrl = raw => media.url(raw, roots, key, uid);
  let next = entry;
  if (entry.role === 'assistant' && entry.text) {
    const { text, used } = rewriteMarkdown(entry.text, toUrl);
    if (text !== entry.text) next = { ...next, text };
    if (entry.images) next = { ...next, images: entry.images.filter(image => !image.path || !used.includes(path.normalize(image.path))) };
  }
  if (next.images) {
    const images = next.images.map(image => {
      const url = image.url || (image.path ? toUrl(image.path) : null);
      return url ? { name: image.name || 'image', kind: 'image', url, source: image.source, ...(image.prompt ? { prompt: image.prompt } : {}) } : null;
    }).filter(Boolean);
    next = { ...next };
    if (images.length) next.images = images; else delete next.images;
  }
  // Attachments outside UPLOAD_DIR (e.g. pasted into the Codex App) cannot use /api/files.
  if (next.attachments?.some(file => file.kind === 'image' && file.path && !insideDir(config.uploads, path.resolve(file.path)))) {
    next = { ...next, attachments: next.attachments.map(file => {
      if (file.kind !== 'image' || !file.path || insideDir(config.uploads, path.resolve(file.path))) return file;
      const url = toUrl(file.path);
      return url ? { ...file, path: undefined, url } : file;
    }) };
  }
  return next;
}
function publicLive(liveTurn, key, principal, thread) {
  if (!liveTurn) return null;
  const roots = mediaRoots(key, thread), uid = principalUid(principal);
  return { turnId: liveTurn.turnId, startedAt: new Date(liveTurn.startedAt).toISOString(), items: liveTurn.items.map(item => publicLiveItem(item, key, uid, roots)) };
}
function publicLiveItem(item, key, uid, roots) {
  if (item.kind !== 'image' || !item.path) return item;
  const { path: file, ...rest } = item;
  const url = media.url(file, roots, key, uid);
  return url ? { ...rest, url } : rest;
}
async function sessionHistory(key, limit, principal) {
  const local = readLines(path.join(historyDir, `${safeKey(key)}.jsonl`)).map(JSON.parse);
  const id = sessions[key]?.codex_session_id;
  if (appserver?.connected && id) {
    try {
      const cache = await appserver.readThread(id);
      const thread = { ...cache.thread, id };
      const active = cache.thread.turns.find(turn => turn.status === 'inProgress');
      const running = !!active || appserver.threadState(id).status === 'active';
      const liveTurn = running ? (active ? appserver.seedLive(id, active) : appserver.threadState(id).live) : null;
      const roots = mediaRoots(key, thread);
      return { key, session: key, history: threadHistory(thread, local).slice(-limit).map(entry => decorateEntry(entry, key, principal, roots)), source: 'thread', revision: cache.revision, running,
        ...(liveTurn ? { live: publicLive(liveTurn, key, principal, thread) } : {}) };
    } catch { /* Preserve local history if the App is unavailable. */ }
  }
  const roots = mediaRoots(key, null);
  return { key, session: key, history: local.slice(-limit).map(entry => decorateEntry(entry, key, principal, roots)), source: 'local', running: !!live.get(key)?.running };
}

// ----- Codex thread lookup: sessions link existing threads -----
const THREAD_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function validThreadId(id) { return typeof id === 'string' && THREAD_ID.test(id); }
function rolloutExists(id) {
  const suffix = `-${id.toLowerCase()}.jsonl`;
  for (const dir of ['sessions', 'archived_sessions']) {
    let names;
    try { names = fs.readdirSync(path.join(config.codexHome, dir), { recursive: true }); } catch { continue; }
    if (names.some(name => String(name).toLowerCase().endsWith(suffix))) return true;
  }
  return false;
}
// Resolves when Codex knows the thread; otherwise throws 404 without creating anything.
async function verifyThread(id) {
  if (!validThreadId(id)) throw failure('Codex 会话 ID 格式不正确（应为 UUID，例如 01a1a610-8626-7623-aba8-66d060441079）', 400);
  if (appserver && fs.existsSync(appserverSocket)) {
    try {
      await appserver.connect();
      const result = await appserver.request('thread/read', { threadId: id, includeTurns: false }, 8000);
      if (result?.thread?.id) return result.thread;
    } catch (error) {
      if (!/not loaded|not found|no rollout|invalid thread|unknown thread|does not exist/i.test(error.message) && !error.appserverConnection && !/timed out/i.test(error.message)) throw failure(`无法验证 Codex 会话 ID：${error.message}`, 502);
    }
  }
  if (rolloutExists(id)) return { id };
  throw failure('Codex 里没有这个会话 ID', 404);
}
async function listCodexThreads(url) {
  if (!appserver || !fs.existsSync(appserverSocket)) throw failure('Codex app-server 未连接，无法列出会话；可以手动输入会话 ID', 503);
  try { await appserver.connect(); } catch { throw failure('Codex app-server 未连接，无法列出会话；可以手动输入会话 ID', 503); }
  const params = { limit: limitOf(url, 40, 100), sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] };
  const q = (url.searchParams.get('q') || '').trim().slice(0, 200), cursor = url.searchParams.get('cursor');
  if (q) params.searchTerm = q;
  if (cursor) params.cursor = cursor.slice(0, 1024);
  if (url.searchParams.get('archived') === '1') params.archived = true;
  const result = await appserver.request('thread/list', params, 15000);
  const linked = new Map();
  for (const [key, entry] of Object.entries(sessions)) if (entry.codex_session_id) linked.set(entry.codex_session_id, [...(linked.get(entry.codex_session_id) || []), key]);
  const clip = (value, size) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, size) : '';
  return {
    threads: (result?.data || []).filter(thread => thread && validThreadId(thread.id) && !thread.parentThreadId && !thread.ephemeral).map(thread => ({
      id: thread.id, title: clip(thread.name, 120) || clip(thread.preview, 120) || '（无标题）', preview: clip(thread.preview, 240),
      updated_at: unixTime(thread.updatedAt) || null, created_at: unixTime(thread.createdAt) || null, cwd: typeof thread.cwd === 'string' ? thread.cwd : null,
      status: thread.status?.type || null, source: typeof thread.source === 'string' ? thread.source : null, linked: linked.get(thread.id) || [],
    })),
    next_cursor: result?.nextCursor || null,
  };
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
    // The relay never starts Codex threads; every session must point at an existing one.
    if (!threadId) throw failure('该会话未关联 Codex 会话，控制台不能新建 Codex 会话', 403);
    await appserver.subscribe(threadId);
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
  if (!sessionId) return Promise.reject(failure('该会话未关联 Codex 会话，控制台不能新建 Codex 会话', 403));
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

// ----- authentication & per-session authorization -----
// WEBHOOK_TOKEN is the super-admin key (webhook integrations, bootstrap); users log in for an rs_ token.
function authenticate(req) {
  const header = req.headers.authorization || '';
  if (crypto.timingSafeEqual(crypto.createHash('sha256').update(header).digest(), authHash)) return { kind: 'token', admin: true, user: null };
  const match = /^Bearer (rs_[A-Za-z0-9_-]{20,96})$/.exec(header);
  const found = match && users.authenticate(match[1]);
  return found ? { kind: 'user', admin: found.user.role === 'admin', user: found.user, tokenHash: found.tokenHash } : null;
}
// A session exists once it has a Codex binding, a turn running/queued, or local history. Grants alone do not create it.
function sessionExists(key) { return !!sessions[key] || live.has(key) || fs.existsSync(path.join(historyDir, `${safeKey(key)}.jsonl`)); }
function visibleKeys(principal) { return principal.admin ? null : new Set(users.grants(principal.user.id)); }
// Only admins (and WEBHOOK_TOKEN) create sessions. For normal users a key that is ungranted or does not
// exist yet is reported as missing (404), so they can neither create sessions nor probe for them.
function userCanUse(principal, key) { return principal.admin || (users.isGranted(principal.user.id, key) && sessionExists(key)); }
function authorizeSend(principal, body) {
  if (principal.admin) return;
  if (!userCanUse(principal, body.session)) throw failure('会话不存在', 404);
  if (body.codex_session_id !== undefined) throw failure('仅管理员可以绑定 Codex ID', 403);
}
function fileVisible(principal, rawPath) {
  if (principal.admin) return true;
  try {
    const relative = path.relative(fs.realpathSync(config.uploads), fs.realpathSync(rawPath));
    const top = relative.split(path.sep)[0];
    return !!top && top !== '..' && !path.isAbsolute(relative) && users.grants(principal.user.id).some(key => safeKey(key) === top);
  } catch { return false; }
}
function readJson(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { done = true; reject(failure('Payload too large', 413)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return; done = true;
      try { const text = Buffer.concat(chunks).toString('utf8'); resolve(text ? JSON.parse(text) : {}); }
      catch { reject(failure('Invalid JSON', 400)); }
    });
    req.on('error', error => { if (!done) { done = true; reject(error); } });
  });
}
function principalInfo(principal) {
  return { ok: true, auth: principal.kind, role: principal.admin ? 'admin' : 'user',
    user: principal.user ? { id: principal.user.id, username: principal.user.username, role: principal.user.role, last_login_at: principal.user.last_login_at } : null,
    needs_setup: !users.hasAdmin() };
}
async function handleUsers(req, res, route, principal) {
  if (!principal.admin) throw failure('Forbidden', 403);
  if (route === '/api/users') {
    if (req.method === 'GET') { send(res, 200, { users: users.list() }); return; }
    if (req.method === 'POST') {
      const input = await readJson(req);
      send(res, 201, { user: await users.create({ username: input.username, password: input.password, role: input.role || 'user', disabled: !!input.disabled, sessions: input.sessions || [] }) }); return;
    }
  }
  const match = route.match(/^\/api\/users\/(\d{1,12})(\/sessions|\/password)?$/);
  if (!match) throw failure('Not found', 404);
  const id = Number(match[1]), self = principal.user?.id === id;
  if (!match[2]) {
    if (req.method === 'GET') { const user = users.get(id); if (!user) throw failure('User not found', 404); send(res, 200, { user }); return; }
    if (req.method === 'PATCH') {
      const input = await readJson(req);
      if (self && ((input.role !== undefined && input.role !== 'admin') || input.disabled === true)) throw failure('不能降级或停用自己', 409);
      const user = users.update(id, { username: input.username, role: input.role, disabled: input.disabled });
      if (Array.isArray(input.sessions)) user.sessions = users.setGrants(id, input.sessions);
      send(res, 200, { user }); return;
    }
    if (req.method === 'DELETE') { if (self) throw failure('不能删除自己', 409); users.remove(id); send(res, 200, { ok: true }); return; }
  }
  if (match[2] === '/sessions' && req.method === 'PUT') { const input = await readJson(req, 1024 * 1024); send(res, 200, { sessions: users.setGrants(id, input.sessions) }); return; }
  if (match[2] === '/password' && req.method === 'POST') { const input = await readJson(req); await users.setPassword(id, input.password, self ? principal.tokenHash : null); send(res, 200, { ok: true }); return; }
  throw failure('Not found', 404);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function validate(body) {
  if (!body || typeof body !== 'object' || typeof body.session !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.session) || (body.message !== undefined && typeof body.message !== 'string') || (!body.message?.trim() && !body.files?.length && !body.file_urls?.length && !body._fileCount)) throw failure('Invalid session or message', 400);
  if (body.codex_session_id !== undefined && !validThreadId(body.codex_session_id)) throw failure('Invalid codex_session_id: Codex 会话 ID 应为 UUID', 400);
  if (body.callback_url !== undefined) {
    let url;
    try { url = new URL(body.callback_url); } catch { throw failure('Invalid callback_url', 400); }
    if (typeof body.callback_url !== 'string' || !['http:', 'https:'].includes(url.protocol)) throw failure('Invalid callback_url', 400);
  }
}

// Console UI: the Vue build in web/dist (SPA, served under /console/) when present,
// otherwise the legacy single-file console.html. /console/legacy always serves the legacy page.
const consoleDist = path.resolve(process.env.CONSOLE_DIST || path.join(__dirname, 'web', 'dist'));
const consoleCsp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
const staticTypes = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8' };
function consoleHtml(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': consoleCsp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  res.end(fs.readFileSync(file, 'utf8'));
}
function serveConsole(req, res, route) {
  const legacy = path.join(__dirname, 'console.html');
  const index = path.join(consoleDist, 'index.html');
  const useDist = process.env.CONSOLE_UI !== 'legacy' && fs.existsSync(index);
  if (['/console/legacy', '/console/legacy/'].includes(route) || (!useDist && ['/console', '/console/'].includes(route))) { consoleHtml(res, legacy); return; }
  if (!useDist) { send(res, 404, { error: 'Not found' }); return; }
  let relative;
  try { relative = decodeURIComponent(route.slice('/console/'.length)); } catch { send(res, 400, { error: 'Bad path' }); return; }
  const target = path.resolve(consoleDist, relative);
  const inside = relative && !relative.includes('\0') && target.startsWith(consoleDist + path.sep);
  let stat = null;
  if (inside) { try { stat = fs.statSync(target); } catch { /* fall through */ } }
  if (stat?.isFile() && path.basename(target) !== 'index.html') {
    const hashed = relative.startsWith('assets/');
    res.writeHead(200, { 'Content-Type': staticTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
    return;
  }
  // Missing build assets are real 404s; any other path is a client-side route.
  if (relative.startsWith('assets/') || /\.[a-z0-9]{1,8}$/i.test(relative)) { send(res, 404, { error: 'Not found' }); return; }
  consoleHtml(res, index);
}

function serveMedia(req, res, url) {
  const signed = media.verify(url.searchParams);
  const deny = () => send(res, 404, { error: 'Image not found' });
  if (!signed || !validKey(signed.key)) { deny(); return; }
  // Re-check the grant at fetch time: a revoked grant or disabled user loses access immediately.
  if (signed.uid) {
    const user = users.get(signed.uid);
    if (!user || user.disabled || (user.role !== 'admin' && !(users.isGranted(user.id, signed.key) && sessionExists(signed.key)))) { deny(); return; }
  }
  media.serve(req, res, signed.file);
}

// ----- live streaming (SSE over fetch; the Authorization header works with fetch streaming) -----
const STREAM_HEARTBEAT_MS = positiveInteger('STREAM_HEARTBEAT_MS', 15000);
const streams = new Set();
function streamSession(req, res, key, principal) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
  res.socket?.setNoDelay?.(true);
  const uid = principalUid(principal);
  let queue = [], flushTimer = null, closed = false;
  const write = text => { if (!closed && !res.destroyed) res.write(text); };
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const flush = () => {
    flushTimer = null;
    if (!queue.length) return;
    // Coalesce consecutive deltas for the same item/field into one event.
    const merged = [];
    for (const item of queue) {
      const last = merged.at(-1);
      if (last && last.name === 'delta' && item.name === 'delta' && last.data.id === item.data.id && last.data.field === item.data.field) last.data = { ...last.data, delta: last.data.delta + item.data.delta };
      else merged.push(item);
    }
    queue = [];
    write(merged.map(item => event(item.name, item.data)).join(''));
  };
  const push = (name, data) => { queue.push({ name, data }); if (!flushTimer) flushTimer = setTimeout(flush, 60); };
  const snapshot = () => {
    const id = sessions[key]?.codex_session_id;
    const state = id && appserver ? appserver.threads.get(id) : null;
    const relay = live.get(key);
    write(event('snapshot', { key, codex_session_id: id || null, running: !!(relay?.running || state?.status === 'active' || state?.live), queued: relay?.queued || 0, live: publicLive(state?.live || null, key, principal, cachedThread(key)) }));
  };
  write('retry: 3000\n\n');
  snapshot();
  const off = appserver ? appserver.onLive((threadId, data) => {
    if (threadId !== sessions[key]?.codex_session_id) return;
    // Copy now: the live item keeps changing (deltas) before the batch is flushed.
    if (data.type === 'item') push('item', { item: { ...publicLiveItem(data.item, key, uid, mediaRoots(key, cachedThread(key))) } });
    else if (data.type === 'delta') push('delta', data);
    else if (data.type === 'turn') { push('turn', data); flush(); }
  }) : () => {};
  // Joined mid-turn (e.g. relay restarted): seed the live buffer from the thread snapshot.
  const id = sessions[key]?.codex_session_id;
  if (appserver?.connected && id && !appserver.threads.get(id)?.live && appserver.threads.get(id)?.status === 'active') {
    appserver.readThread(id).then(cache => { const turn = cache.thread.turns.find(t => t.status === 'inProgress'); if (turn && appserver.seedLive(id, turn)) snapshot(); }).catch(() => {});
  }
  const heartbeat = setInterval(() => {
    // A revoked login or lost grant ends the stream.
    if (principal.kind === 'user') {
      const fresh = users.authenticate((req.headers.authorization || '').slice(7));
      if (!fresh || !userCanUse({ admin: fresh.user.role === 'admin', user: fresh.user }, key)) { close(); res.end(); return; }
    }
    write(`: ping ${Date.now()}\n\n`);
  }, STREAM_HEARTBEAT_MS);
  heartbeat.unref?.();
  const entry = { close: () => { close(); try { res.end(); } catch {} } };
  streams.add(entry);
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat); clearTimeout(flushTimer); off(); streams.delete(entry);
  }
  req.on('close', close);
  res.on('close', close);
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
    if ((req.method === 'GET' || req.method === 'HEAD') && (route === '/console' || route.startsWith('/console/'))) { serveConsole(req, res, route); return; }
    if (req.method === 'GET' && route === '/health') { send(res, 200, { ok: true }); record(200); return; }
    if (!(req.method === 'GET' && route === '/sessions') && !(req.method === 'POST' && route === '/webhook') && !route.startsWith('/api/')) { send(res, 404, { error: 'Not found' }); record(404); return; }
    if (req.method === 'GET' && route === '/api/auth/status') { send(res, 200, { needs_setup: !users.hasAdmin() }); return; }
    if (req.method === 'POST' && route === '/api/auth/login') {
      const input = await readJson(req);
      send(res, 200, await users.login(input.username, input.password)); return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && route.startsWith('/api/media/')) { serveMedia(req, res, url); return; }
    const principal = authenticate(req);
    if (!principal) { send(res, 401, { error: 'Unauthorized' }); record(401); return; }
    const visible = visibleKeys(principal);
    if (route === '/sessions') {
      const listing = await sessionListing();
      send(res, 200, { sessions: Object.fromEntries(listing.filter(s => sessions[s.key] && (!visible || visible.has(s.key))).map(({ key, status, queued, ...entry }) => [key, entry])) }); record(200); return;
    }
    if (route.startsWith('/api/') && route !== '/api/send') {
      if (req.method === 'GET' && route === '/api/files') {
        if (!fileVisible(principal, url.searchParams.get('path'))) throw failure('File not found', 404);
        serveFile(req, res, url.searchParams.get('path'), config.uploads); return;
      }
      if (req.method === 'GET' && route === '/api/whoami') { send(res, 200, principalInfo(principal)); return; }
      if (req.method === 'POST' && route === '/api/auth/logout') { if (principal.tokenHash) users.revoke(principal.tokenHash); send(res, 200, { ok: true }); return; }
      if (req.method === 'POST' && route === '/api/auth/password') {
        if (!principal.user) throw failure('访问令牌登录无法修改密码', 400);
        const input = await readJson(req);
        if (!await users.checkOwnPassword(principal.user.id, input.current_password)) throw failure('当前密码不正确', 400);
        await users.setPassword(principal.user.id, input.new_password, principal.tokenHash);
        send(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && route === '/api/auth/setup') {
        if (principal.kind !== 'token') throw failure('Forbidden', 403);
        if (users.hasAdmin()) throw failure('管理员已存在', 409);
        const input = await readJson(req);
        const user = await users.create({ username: input.username, password: input.password, role: 'admin' });
        send(res, 201, { ...users.issue(user.id), user }); return;
      }
      // Full webhook token for building curl snippets; admins only.
      if (req.method === 'GET' && route === '/api/webhook-token') {
        if (!principal.admin) throw failure('Forbidden', 403);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ token: process.env.WEBHOOK_TOKEN })); return;
      }
      if (route === '/api/users' || route.startsWith('/api/users/')) { await handleUsers(req, res, route, principal); return; }
      if (req.method === 'GET' && route === '/api/codex/threads') {
        if (!principal.admin) throw failure('Forbidden', 403);
        send(res, 200, await listCodexThreads(url)); return;
      }
      if (req.method === 'GET' && route === '/api/sessions') {
        const listing = await sessionListing();
        send(res, 200, { sessions: visible ? listing.filter(s => visible.has(s.key)) : listing }); return;
      }
      if (req.method === 'GET' && route === '/api/requests') {
        const entries = visible ? recentRequests.filter(entry => visible.has(entry.session)) : recentRequests;
        send(res, 200, { requests: entries.slice(-limitOf(url, 100, 500)).reverse() }); return;
      }
      if (req.method === 'GET' && route === '/api/stats' && visible) {
        const day = taipeiDay(Date.now()), mine = recentRequests.filter(entry => visible.has(entry.session) && taipeiDay(entry.time) === day);
        const total = mine.reduce((sum, entry) => sum + (entry.duration_ms || 0), 0), states = [...live].filter(([key]) => visible.has(key)).map(([, state]) => state);
        send(res, 200, { today: { calls: mine.length, failures: mine.filter(entry => !entry.ok).length, avg_duration_ms: mine.length ? Math.round(total / mine.length) : 0 }, total_sessions: [...visible].filter(key => sessions[key]).length, running: states.filter(state => state.running).length, queued: states.reduce((sum, state) => sum + state.queued, 0), uptime_s: Math.floor((Date.now() - bootTime) / 1000), scope: 'granted' }); return;
      }
      if (req.method === 'GET' && route === '/api/stats') {
        const today = dayTotals.day === taipeiDay(Date.now()) ? dayTotals : { calls: 0, failures: 0, duration_ms: 0 };
        send(res, 200, { today: { calls: today.calls, failures: today.failures, avg_duration_ms: today.calls ? Math.round(today.duration_ms / today.calls) : 0 }, total_sessions: Object.keys(sessions).length, running: [...live.values()].filter(state => state.running).length, queued: [...live.values()].reduce((sum, state) => sum + state.queued, 0), uptime_s: Math.floor((Date.now() - bootTime) / 1000) }); return;
      }
      const match = route.match(/^\/api\/sessions\/([^/]+)(\/history|\/stream)?$/);
      if (match) {
        let key;
        try {
          key = decodeURIComponent(match[1]);
          // Also accept double-encoded dot keys from browser clients.
          if (/^(%2e){1,2}$/i.test(key)) key = decodeURIComponent(key);
        } catch { throw failure('Invalid session', 400); }
        if (!validKey(key)) throw failure('Invalid session', 400);
        const file = path.join(historyDir, `${safeKey(key)}.jsonl`);
        // Admin: link (or re-link) a key to an existing Codex thread without sending a message.
        if (req.method === 'PUT' && !match[2]) {
          if (!principal.admin) throw failure('仅管理员可以关联 Codex 会话', 403);
          const input = await readJson(req);
          if (!validThreadId(input.codex_session_id)) throw failure('Codex 会话 ID 格式不正确（应为 UUID，例如 01a1a610-8626-7623-aba8-66d060441079）', 400);
          if (live.has(key)) throw failure('Session is running or queued', 409);
          await verifyThread(input.codex_session_id);
          const now = new Date().toISOString(), existed = !!sessions[key];
          sessions[key] = { codex_session_id: input.codex_session_id, created_at: sessions[key]?.created_at || now, updated_at: now, messages: sessions[key]?.codex_session_id === input.codex_session_id ? sessions[key].messages || 0 : 0 };
          persist();
          if (appserver) void appserver.subscribe(input.codex_session_id).catch(() => {});
          send(res, existed ? 200 : 201, { session: { key, ...sessions[key] } }); return;
        }
        if (!userCanUse(principal, key)) throw failure('会话不存在', 404);
        if (req.method === 'GET' && match[2] === '/history') { send(res, 200, await sessionHistory(key, limitOf(url, 200, 550), principal)); return; }
        if (req.method === 'GET' && match[2] === '/stream') { streamSession(req, res, key, principal); return; }
        if (req.method === 'DELETE' && !match[2]) {
          if (!principal.admin) throw failure('仅管理员可以删除会话', 403);
          if (live.has(key)) throw failure('Session is running or queued', 409);
          if (!sessions[key] && !fs.existsSync(file)) throw failure('Session not found', 404);
          delete sessions[key]; persist(); users.forgetSession(key);
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
    authorizeSend(principal, body);
    // Linking must name a thread that exists in Codex; nothing is created otherwise.
    if (body.codex_session_id !== undefined && body.codex_session_id !== sessions[body.session]?.codex_session_id) await verifyThread(body.codex_session_id);
    // Never create a Codex thread: unknown/unlinked sessions are rejected before anything is queued.
    if (!(body.codex_session_id || sessions[body.session]?.codex_session_id)) throw failure('会话不存在或未关联 Codex 会话；控制台和 webhook 不会新建 Codex 会话，请让管理员关联已有会话', 404);
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
seedAdmin().finally(() => server.listen(config.port, config.host, () => console.log(`linebot-relay listening on ${config.host}:${config.port} (users: ${users.driver})`)));

function shutdown() {
  watcherStopped = true;
  clearTimeout(watcherTimer);
  for (const stream of [...streams]) stream.close();
  appserver?.close();
  server.close();
  users.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.once?.('SIGTERM', shutdown);
process.once?.('SIGINT', shutdown);
