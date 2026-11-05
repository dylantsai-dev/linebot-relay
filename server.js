'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { URL } = require('node:url');
const { AppServer, summarizeItem } = require('./lib/appserver');
const APPROVAL_MODES = ['ask', 'assist', 'full']; // session.approval_mode; mapped to turn/start params in lib/appserver.js
const { readRequest, prepareAttachments, parseUserContent, serveFile } = require('./lib/attachments');
const { Users } = require('./lib/users');
const { Settings } = require('./lib/settings');
const feishu = require('./lib/feishu');
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
  maxBytes: positiveInteger('MAX_FILE_BYTES', 50 * 1024 * 1024),
  maxFiles: positiveInteger('MAX_FILES', 10),
  maxTotal: positiveInteger('MAX_TOTAL_BYTES', 100 * 1024 * 1024),
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
const settings = new Settings(path.resolve(process.env.SETTINGS_FILE || path.join(config.data, 'settings.json')));
const feishuStateSecret = crypto.createHash('sha256').update(`feishu-state:${process.env.WEBHOOK_TOKEN}`).digest();
const FEISHU_COOKIE = 'feishu_oauth';
const DEFAULT_FEISHU_REDIRECT = 'https://linebot.dylantsai.com/api/auth/feishu/callback';
// Optional first-admin seed; ignored once any admin exists.
async function seedAdmin() {
  const username = process.env.ADMIN_USERNAME, password = process.env.ADMIN_PASSWORD;
  if (!username || !password || users.hasAdmin()) return;
  try { await users.create({ username, password, role: 'admin' }); console.log(`Seeded admin user ${username}`); }
  catch (error) { console.error('Admin seed failed:', error.message); }
}
const historyDir = path.join(config.data, 'history');
// Session avatars live in a local folder next to the other data; sessions.json keeps only the file name.
const avatarDir = path.join(config.data, 'avatars');
fs.mkdirSync(avatarDir, { recursive: true });
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
const STEP_KINDS = new Set(['text', 'command', 'tool', 'search', 'file']);
function turnSteps(items, answers) {
  const steps = [];
  for (const raw of items) {
    if (raw.type === 'userMessage' || answers.has(raw)) continue;
    const step = summarizeItem(raw);
    if (!step || !STEP_KINDS.has(step.kind) || (step.kind === 'text' && !step.text.trim())) continue;
    delete step.phase;
    if (step.text && step.text.length > 4000) step.text = `${step.text.slice(0, 4000)}…`;
    if (step.output) step.output = step.output.slice(-1500);
    steps.push(step);
  }
  return steps.length > 80 ? steps.slice(-80) : steps;
}
function threadHistory(thread, local) {
  const history = [], matchedErrors = new Set(), matchedUsers = new Set();
  for (const turn of thread.turns) {
    const started = unixTime(turn.startedAt), time = unixTime(turn.completedAt ?? turn.startedAt);
    const items = turn.items || [];
    for (const item of items.filter(item => item.type === 'userMessage')) {
      const { text, fullText, attachments } = parseUserContent(item);
      // The closest not-yet-matched relay entry: the same text may be sent again within minutes.
      const distance = entry => Math.abs(Date.parse(entry.time) - Date.parse(started));
      // A steered message joins a turn that is already running: it lands inside [startedAt, completedAt], not near startedAt.
      const turnEnd = turn.completedAt ? Date.parse(unixTime(turn.completedAt)) : Date.now();
      const inTurn = entry => entry.mode === 'steer' && Date.parse(entry.time) >= Date.parse(started) - 5000 && Date.parse(entry.time) <= turnEnd + 5000;
      const match = local.filter(entry => entry.role === 'user' && !matchedUsers.has(entry) && (entry.text === text || entry.text === fullText || entry.text.trim() === text) &&
        ['webhook', 'console'].includes(entry.source) && (distance(entry) <= 180000 || inTurn(entry))).sort((a, b) => distance(a) - distance(b))[0];
      if (match) matchedUsers.add(match);
      // Steered messages keep the time they were steered in, so the console can match them to the relay's steered entry.
      const userTime = match?.mode === 'steer' && match.time ? match.time : started;
      history.push({ role: 'user', text, time: userTime, ...(match?.mode === 'steer' ? { mode: 'steer' } : {}), source: match?.source || 'app', ...(attachments.length ? { attachments: attachments.map(file => ({ ...file, ...(match?.attachments?.find(localFile => localFile.path === file.path) || {}) })) } : match?.attachments?.length ? { attachments: match.attachments } : {}) });
      // The thread is authoritative for a turn that reached it; drop relay-side timeouts/disconnect errors for it.
      if (match?.request_id) {
        for (const entry of local) if (entry.role === 'error' && entry.request_id === match.request_id) matchedErrors.add(entry);
      }
    }
    if (turn.status !== 'inProgress') {
      const agents = items.filter(item => item.type === 'agentMessage');
      const finals = agents.filter(item => item.phase === 'final_answer');
      const before = history.length;
      const answers = finals.length ? finals : agents.slice(-1);
      for (const item of answers) {
        history.push({ role: 'assistant', text: item.text || '', time, duration_ms: turn.durationMs ?? undefined, codex_session_id: thread.id });
      }
      // The turn's process as Codex App shows it: commentary, commands, edits, searches, tool calls.
      const steps = turnSteps(items, new Set(answers));
      if (steps.length && history.length > before) history[before].steps = steps;
      // Generated / viewed images live in their own items, not in the reply text.
      const images = items.flatMap(itemImages);
      if (images.length) {
        if (history.length > before) history.at(-1).images = images;
        else history.push({ role: 'assistant', text: '', time, duration_ms: turn.durationMs ?? undefined, codex_session_id: thread.id, images });
      }
    }
    if (turn.status === 'interrupted') history.push({ role: 'error', text: '回合已停止', time, interrupted: true });
    if (turn.status === 'failed') {
      const text = turn.error?.message || '处理失败';
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
    const { text, used } = rewriteMarkdown(entry.text, toUrl, raw => media.linkUrl(raw, roots, key, uid));
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
  // Uploaded files of any type get a signed, grant-checked download URL.
  if (next.attachments?.some(file => file.path && !file.url)) {
    const root = path.join(config.uploads, safeKey(key));
    next = { ...next, attachments: next.attachments.map(file => {
      if (!file.path || file.url) return file;
      const url = insideDir(root, path.resolve(file.path)) ? media.fileUrl(file.path, root, key, uid) : null;
      return url ? { ...file, url } : file;
    }) };
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
// Pending approvals / questions of the session's thread, as console cards.
const hideBrandText = text => typeof text === 'string' ? text.replace(/\bCodex\b/gi, '三代目') : text;
function publicPrompt(view) {
  const next = { ...view, reason: hideBrandText(view.reason) };
  if (next.questions) next.questions = next.questions.map(q => ({ ...q, header: hideBrandText(q.header), question: hideBrandText(q.question), options: q.options.map(o => ({ ...o, description: hideBrandText(o.description) })) }));
  return next;
}
function sessionPrompts(key) {
  const id = sessions[key]?.codex_session_id;
  return appserver && id ? appserver.promptsFor(id).map(publicPrompt) : [];
}
// One page of history: the newest `limit` entries, or those strictly older than `before`.
// A page never splits entries that share a timestamp, so `before=<oldest time>` cannot skip any.
function historyPage(all, limit, before) {
  const at = entry => { const t = Date.parse(entry.time); return Number.isFinite(t) ? t : -Infinity; };
  const list = before === null ? all : all.filter(entry => at(entry) < before);
  let start = Math.max(0, list.length - limit);
  while (start > 0 && at(list[start - 1]) === at(list[start]) && at(list[start]) !== -Infinity) start--;
  return { entries: list.slice(start), has_more: start > 0 };
}
function beforeOf(url) {
  const raw = url.searchParams.get('before');
  if (raw === null || raw === '') return null;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) throw failure('Invalid before', 400);
  return time;
}
async function sessionHistory(key, limit, principal, before = null) {
  const local = readLines(path.join(historyDir, `${safeKey(key)}.jsonl`)).map(JSON.parse);
  const id = sessions[key]?.codex_session_id;
  if (appserver?.connected && id) {
    try {
      const cache = await appserver.readThread(id);
      try {
        const thread = { ...cache.thread, id };
        const active = appserver.runningTurn(cache.thread);
        const running = !!active || appserver.threadState(id).status === 'active';
        const liveTurn = running ? (active ? appserver.seedLive(id, active) : appserver.threadState(id).live) : null;
        const roots = mediaRoots(key, thread);
        const page = historyPage(threadHistory(thread, local), limit, before);
        return { key, session: key, history: page.entries.map(entry => decorateEntry(entry, key, principal, roots)), has_more: page.has_more, source: 'thread', revision: cache.revision, running: running || !!live.get(key)?.running, queue: publicQueue(key), prompts: sessionPrompts(key),
          ...(liveTurn ? { live: publicLive(liveTurn, key, principal, thread) } : {}) };
      } finally {
        // Do not keep multi‑MB turn lists resident between polls.
        appserver.compactThreadCache(id);
      }
    } catch { /* Preserve local history if the App is unavailable. */ }
  }
  const roots = mediaRoots(key, null);
  const page = historyPage(local.sort((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0)), limit, before);
  return { key, session: key, history: page.entries.map(entry => decorateEntry(entry, key, principal, roots)), has_more: page.has_more, source: 'local', running: !!live.get(key)?.running, queue: publicQueue(key), prompts: sessionPrompts(key) };
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
  if (!validThreadId(id)) throw failure('会话 ID 格式不正确（应为 UUID，例如 01a1a610-8626-7623-aba8-66d060441079）', 400);
  if (appserver && fs.existsSync(appserverSocket)) {
    try {
      await appserver.connect();
      const result = await appserver.request('thread/read', { threadId: id, includeTurns: false }, 8000);
      if (result?.thread?.id) return result.thread;
    } catch (error) {
      if (!/not loaded|not found|no rollout|invalid thread|unknown thread|does not exist/i.test(error.message) && !error.appserverConnection && !/timed out/i.test(error.message)) throw failure(`无法验证会话 ID：${error.message}`, 502);
    }
  }
  if (rolloutExists(id)) return { id };
  throw failure('没有这个会话 ID', 404);
}
async function listCodexThreads(url) {
  if (!appserver || !fs.existsSync(appserverSocket)) throw failure('后台服务未连接，无法列出会话；可以手动输入会话 ID', 503);
  try { await appserver.connect(); } catch { throw failure('后台服务未连接，无法列出会话；可以手动输入会话 ID', 503); }
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
  // Listing only needs status / timestamps: never pull or keep full turn payloads (multi‑MB sessions).
  if (appserver?.connected && ids.length) {
    let timer;
    try {
      await Promise.race([
        Promise.allSettled(ids.map(id => appserver.readThread(id, 10000, { includeTurns: false }))),
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
    const messages = thread
      ? (Number.isFinite(thread._completedTurns) ? thread._completedTurns : turns.filter(t => t.status === 'completed').length)
      : undefined;
    return { key, codex_session_id: null, messages: 0, created_at: state?.created_at, updated_at: state?.updated_at, ...stored,
      ...(thread ? { ...(messages !== undefined ? { messages } : {}),
        updated_at: unixTime(last?.completedAt ?? last?.startedAt ?? thread.updatedAt) || stored?.updated_at } : {}),
      status: state?.running || watched?.status === 'active' || !!appserver?.runningTurn(thread) ? 'running' : state?.queued ? 'queued' : 'idle', queued: state?.queued || 0 };
  }).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

let modelCache = null;
// The console never names the backend; drop it from upstream model labels.
const hideBrand = text => String(text).replace(/\s*\bCodex\b/gi, '').replace(/\s{2,}/g, ' ').trim();
async function modelList() {
  if (modelCache && Date.now() - modelCache.at < 60000) return modelCache.models;
  if (!appserver || !fs.existsSync(appserverSocket)) throw failure('模型服务未连接，暂时无法获取模型列表', 503);
  try {
    await appserver.connect();
    const models = (await appserver.listModels()).map(m => ({ id: m.id || m.model, displayName: hideBrand(m.displayName || m.id || m.model), description: hideBrand(m.description || ''), isDefault: !!m.isDefault,
      defaultReasoningEffort: m.defaultReasoningEffort || null,
      supportedReasoningEfforts: (m.supportedReasoningEfforts || []).map(e => typeof e === 'string' ? { id: e, description: '' } : { id: e.reasoningEffort, description: hideBrand(e.description || '') }).filter(e => e.id),
      serviceTiers: (m.serviceTiers || []).map(t => ({ id: t.id, name: hideBrand(t.name || t.id), description: hideBrand(t.description || '') })).filter(t => t.id),
      defaultServiceTier: m.defaultServiceTier || null }));
    modelCache = { at: Date.now(), models };
    return models;
  } catch (error) {
    throw failure('获取模型列表失败：' + (error.message || '模型服务不可用'), 503);
  }
}


let usageCache = null;
function windowLabel(mins) {
  if (mins == null) return '用量窗口';
  if (mins >= 10080 - 60) return '本周';
  if (mins >= 1440 && mins % 1440 === 0) return `${mins / 1440} 天`;
  if (mins >= 60 && mins % 60 === 0) return `${mins / 60} 小时`;
  return `${mins} 分钟`;
}
function mapWindow(win) {
  if (!win || typeof win.usedPercent !== 'number') return null;
  return {
    used_percent: Math.max(0, Math.min(100, Math.round(win.usedPercent))),
    resets_at: typeof win.resetsAt === 'number' ? new Date(win.resetsAt * 1000).toISOString() : null,
    window_mins: typeof win.windowDurationMins === 'number' ? win.windowDurationMins : null,
    label: windowLabel(typeof win.windowDurationMins === 'number' ? win.windowDurationMins : null),
  };
}
async function usageSnapshot() {
  if (usageCache && Date.now() - usageCache.at < 60000) return usageCache.data;
  if (!appserver || !fs.existsSync(appserverSocket)) throw failure('用量服务未连接，暂时无法获取用量', 503);
  try {
    await appserver.connect();
    const result = await appserver.getRateLimits({ excludeResetCreditDetails: true });
    const snap = result?.rateLimits || result || {};
    const primary = mapWindow(snap.primary);
    const secondary = mapWindow(snap.secondary);
    const week = [primary, secondary].filter(Boolean).find(w => (w.window_mins || 0) >= 10080 - 60)
      || [secondary, primary].find(Boolean)
      || null;
    const data = {
      plan: snap.planType || null,
      limit_name: hideBrand(snap.limitName || '') || null,
      week,
      primary,
      secondary,
      credits: snap.credits ? { has_credits: !!snap.credits.hasCredits, unlimited: !!snap.credits.unlimited, balance: snap.credits.balance ?? null } : null,
      fetched_at: new Date().toISOString(),
    };
    usageCache = { at: Date.now(), data };
    return data;
  } catch (error) {
    throw failure('获取用量失败：' + (error.message || '用量服务不可用'), 503);
  }
}

async function runCodex(key, message, sessionId, input) {
  if (!appserver || !fs.existsSync(appserverSocket)) return runCodexExec(key, message, sessionId);
  let submitted = false;
  try {
    await appserver.connect();
    let threadId = sessionId;
    // The relay never starts Codex threads; every session must point at an existing one.
    if (!threadId) throw failure('该会话未关联，控制台不能新建会话', 403);
    await appserver.subscribe(threadId);
    // Once sent, a lost response cannot prove the turn was not accepted.
    submitted = true;
    const reply = await appserver.runTurn(threadId, input || message, config.timeout, { model: sessions[key]?.model, effort: sessions[key]?.effort, serviceTier: sessions[key]?.service_tier, approvalMode: sessions[key]?.approval_mode });
    return { session: key, codex_session_id: threadId, reply, transport: 'app-server' };
  } catch (error) {
    if (!submitted && error.appserverConnection) return runCodexExec(key, message, sessionId);
    error.transport = 'app-server';
    throw error;
  }
}

function runCodexExec(key, message, sessionId) {
  if (!sessionId) return Promise.reject(failure('该会话未关联，控制台不能新建会话', 403));
  return new Promise((resolve, reject) => {
    const workdir = path.join(config.work, safeKey(key));
    fs.mkdirSync(workdir, { recursive: true });
    const output = path.join(config.data, `reply-${crypto.randomUUID()}.tmp`);
    // CLI fallback is non-interactive: only 完全访问 lifts the sandbox; the other modes stay workspace-write.
    const sandbox = sessions[key]?.approval_mode === 'full' ? 'danger-full-access' : 'workspace-write';
    const args = sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`]
      : ['exec', '--json', '--skip-git-repo-check', '-s', sandbox, '-C', workdir];
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
      if (event.type === 'turn.failed') eventError = event.error?.message || '处理失败';
      if (event.type === 'error') eventError = event.message || event.error?.message || '处理出错';
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
        if (timedOut) throw failure('响应超时', 504);
        if (spawnError) throw spawnError;
        if (activeWriter) throw failure('该会话正被占用，且后台服务未连接，暂时无法投递；请确认 app-server 正在运行', 409);
        if (eventError) throw failure(eventError);
        if (code !== 0) throw failure(stderr || `后台进程退出（代码 ${code}）`);
        try {
          const contents = fs.readFileSync(output, 'utf8');
          if (contents.trim()) reply = contents;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) throw failure('后台没有返回有效的会话 ID');
        resolve({ session: key, codex_session_id: id, reply });
      } catch (error) { error.transport = 'exec'; reject(error); }
      finally { try { fs.unlinkSync(output); } catch {} }
    });
  });
}

// ----- per-session message queue: 排队 (queue) and 引导 (steer) -----
// Every session has an ordered queue. A queued message waits until the Codex thread is idle (no turn
// running, whoever started it) and is then sent as a new turn. A steer message is injected into the
// running turn with app-server turn/steer; with no running turn it jumps to the head of the queue.
const sessionQueues = new Map();
const queueListeners = new Set();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function sessionQueue(key) {
  if (!sessionQueues.has(key)) sessionQueues.set(key, { items: [], running: null, steered: [], worker: null });
  return sessionQueues.get(key);
}
function publicEntry(entry, status) {
  return { id: entry.id, text: entry.message.slice(0, 4000), mode: entry.mode, status, source: entry.source, user: entry.user || null, created_at: entry.created_at,
    ...(entry.started_at ? { started_at: entry.started_at } : {}), ...(entry.fallback ? { fallback: entry.fallback } : {}),
    attachments: (entry.attachments || []).map(file => ({ name: file.name, size: file.size, mime: file.mime, kind: file.kind })) };
}
function publicQueue(key) {
  const q = sessionQueues.get(key);
  if (!q) return [];
  return [...q.steered.map(entry => publicEntry(entry, 'steered')), ...(q.running ? [publicEntry(q.running, 'running')] : []), ...q.items.map(entry => publicEntry(entry, 'queued'))];
}
function syncLive(key) {
  const q = sessionQueues.get(key), now = new Date().toISOString();
  const busy = !!(q && (q.running || q.steered.length));
  if (!q || (!busy && !q.items.length)) {
    live.delete(key);
    if (q && !q.worker) sessionQueues.delete(key);
  } else {
    const state = live.get(key) || { created_at: now };
    Object.assign(state, { running: !!q.running || q.steered.length > 0, queued: q.items.length, updated_at: now });
    live.set(key, state);
  }
  const queue = publicQueue(key);
  for (const listener of [...queueListeners]) { try { listener(key, queue); } catch { /* listener errors stay local */ } }
}
function threadBusy(key) {
  const id = sessions[key]?.codex_session_id;
  return !!(appserver && id && appserver.busy(id));
}
// Wait for a thread to go idle. Periodically re-read it so a missed turn/completed cannot block forever.
async function waitIdle(key, q) {
  let checked = Date.now();
  while (q.items.length && threadBusy(key)) {
    await pause(250);
    if (Date.now() - checked > 8000) {
      checked = Date.now();
      try { await appserver.refreshActive(sessions[key].codex_session_id); } catch { /* keep waiting */ }
    }
  }
}
function drain(key) {
  const q = sessionQueue(key);
  if (q.worker) return;
  q.worker = (async () => {
    while (q.items.length) {
      await waitIdle(key, q);
      if (!q.items.length) break;
      await acquire();
      const entry = q.items.shift();
      if (!entry) { release(); continue; }
      q.running = entry;
      entry.started_at = new Date().toISOString();
      syncLive(key);
      try { entry.resolve(await runEntry(key, entry)); }
      catch (error) { entry.reject(error); }
      finally { q.running = null; release(); syncLive(key); }
    }
  })().finally(() => { q.worker = null; if (q.items.length) drain(key); else syncLive(key); });
}
async function runEntry(key, entry) {
  const started = Date.now();
  try {
    appendHistory(key, { role: 'user', text: entry.message, ...(entry.attachments.length ? { attachments: entry.attachments } : {}), time: new Date().toISOString(), source: entry.source, request_id: entry.request_id, ...(entry.mode === 'steer' ? { mode: 'steer' } : {}) });
    if (entry.codex_session_id) {
      const now = new Date().toISOString();
      sessions[key] = { ...sessions[key], codex_session_id: entry.codex_session_id, created_at: sessions[key]?.created_at || now, updated_at: now, messages: sessions[key]?.messages || 0 };
      persist();
      if (appserver) void appserver.subscribe(entry.codex_session_id).catch(() => {});
    }
    const result = await runCodex(key, entry.input ? entry.input.filter(part => part.type === 'text').map(part => part.text).join('\n') : entry.message, sessions[key]?.codex_session_id, entry.input);
    const now = new Date().toISOString();
    sessions[key] = { ...sessions[key], codex_session_id: result.codex_session_id, created_at: sessions[key]?.created_at || now, updated_at: now, messages: (sessions[key]?.messages || 0) + 1 };
    persist();
    appendHistory(key, { role: 'assistant', text: result.reply, time: now, duration_ms: Date.now() - started, codex_session_id: result.codex_session_id, request_id: entry.request_id });
    return { ...result, mode: entry.mode, ...(entry.fallback ? { steer: entry.fallback } : {}) };
  } catch (error) {
    appendHistory(key, { role: 'error', text: error.message, time: new Date().toISOString(), duration_ms: Date.now() - started, codex_session_id: sessions[key]?.codex_session_id || null, request_id: entry.request_id });
    throw error;
  }
}
// Steer: inject into the running turn when there is one; otherwise send next (head of the queue).
async function steer(key, entry, q) {
  const id = sessions[key]?.codex_session_id;
  let turnId = null;
  if (appserver && id && fs.existsSync(appserverSocket)) {
    try {
      await appserver.connect();
      turnId = appserver.activeTurnId(id) || (appserver.busy(id) ? await appserver.refreshActive(id) : null);
    } catch { turnId = null; }
  }
  if (!turnId) { entry.fallback = 'no_active_turn'; return false; }
  const input = entry.input || [{ type: 'text', text: entry.message, text_elements: [] }];
  try {
    turnId = await appserver.steerTurn(id, turnId, input);
  } catch (error) {
    entry.fallback = 'steer_rejected';
    entry.steer_error = String(error.message || error).slice(0, 200);
    return false;
  }
  const started = Date.now();
  entry.started_at = new Date().toISOString();
  entry.turn_id = turnId;
  appendHistory(key, { role: 'user', text: entry.message, ...(entry.attachments.length ? { attachments: entry.attachments } : {}), time: entry.started_at, source: entry.source, request_id: entry.request_id, mode: 'steer' });
  q.steered.push(entry);
  syncLive(key);
  appserver.waitTurn(id, turnId, config.timeout).then(reply => {
    const now = new Date().toISOString();
    if (sessions[key]) { sessions[key] = { ...sessions[key], updated_at: now, messages: (sessions[key].messages || 0) + 1 }; persist(); }
    appendHistory(key, { role: 'assistant', text: reply, time: now, duration_ms: Date.now() - started, codex_session_id: id, request_id: entry.request_id });
    entry.resolve({ session: key, codex_session_id: id, reply, transport: 'app-server', mode: 'steer', steered: true, turn_id: turnId });
  }, error => {
    appendHistory(key, { role: 'error', text: error.message, time: new Date().toISOString(), duration_ms: Date.now() - started, codex_session_id: id, request_id: entry.request_id });
    entry.reject(error);
  }).finally(() => { q.steered = q.steered.filter(item => item !== entry); syncLive(key); if (q.items.length) drain(key); });
  return true;
}
function enqueue(body, source, requestId, { mode = 'queue', user = null } = {}) {
  const q = sessionQueue(body.session);
  const entry = { id: crypto.randomUUID(), key: body.session, message: body.message, attachments: body.attachments || [], input: body.input, codex_session_id: body.codex_session_id,
    source, request_id: requestId, mode, user, created_at: new Date().toISOString() };
  const job = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
  job.catch(() => {});
  entry.job = job;
  const accepted = (async () => {
    if (mode === 'steer' && await steer(body.session, entry, q)) return entry;
    if (mode === 'steer') q.items.unshift(entry); else q.items.push(entry);
    syncLive(body.session);
    drain(body.session);
    return entry;
  })();
  return { entry, job, accepted };
}
// Remove a message that has not been sent yet.
function cancelQueued(key, id, principal) {
  const q = sessionQueues.get(key);
  const index = q ? q.items.findIndex(entry => entry.id === id) : -1;
  if (index < 0) throw failure('该消息已发送或不存在', 404);
  const entry = q.items[index];
  if (!principal.admin && entry.user !== principal.user?.username) throw failure('只能撤回自己排队的消息', 403);
  q.items.splice(index, 1);
  entry.reject(Object.assign(new Error('排队消息已撤回'), { status: 409, cancelled: true }));
  for (const file of entry.attachments || []) { try { fs.unlinkSync(file.path); } catch { /* already gone */ } }
  syncLive(key);
  return entry;
}
// Turn a queued message into a steer of the running turn (the queue row's 引导 button).
// When there is no running turn or Codex rejects the steer, it stays at the head of the queue.
async function steerQueued(key, id, principal) {
  const q = sessionQueues.get(key);
  const index = q ? q.items.findIndex(entry => entry.id === id) : -1;
  if (index < 0) throw failure('该消息已发送或不存在', 404);
  const entry = q.items[index];
  if (!principal.admin && entry.user !== principal.user?.username) throw failure('只能引导自己排队的消息', 403);
  q.items.splice(index, 1);
  entry.mode = 'steer';
  delete entry.fallback;
  if (await steer(key, entry, q)) return { id: entry.id, status: 'steered' };
  q.items.unshift(entry);
  syncLive(key);
  drain(key);
  return { id: entry.id, status: 'queued', steer_fallback: entry.fallback };
}
async function interruptSession(key) {
  const id = sessions[key]?.codex_session_id;
  if (!id) throw failure('会话不存在或未关联', 404);
  if (!appserver || !fs.existsSync(appserverSocket)) throw failure('后台服务未连接，无法停止', 503);
  await appserver.connect();
  const turnId = appserver.activeTurnId(id) || await appserver.refreshActive(id);
  if (!turnId) throw failure('当前没有正在运行的回合', 409);
  await appserver.interruptTurn(id, turnId);
  return turnId;
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
function visibleKeys(principal) { return principal.admin ? null : principal.kind === 'hook' ? new Set([principal.session]) : new Set(users.grants(principal.user.id)); }
// Only admins (and WEBHOOK_TOKEN) create sessions. For normal users a key that is ungranted or does not
// exist yet is reported as missing (404), so they can neither create sessions nor probe for them.
function userCanUse(principal, key) { return principal.admin || (users.isGranted(principal.user.id, key) && sessionExists(key)); }
function authorizeSend(principal, body) {
  if (principal.kind === 'hook') {
    if (body.session !== principal.session) throw failure('会话不存在', 404);
    if (body.codex_session_id !== undefined) throw failure('Webhook 不能绑定会话 ID', 403);
    return;
  }
  if (principal.admin) return;
  if (!userCanUse(principal, body.session)) throw failure('会话不存在', 404);
  if (body.codex_session_id !== undefined) throw failure('仅管理员可以绑定会话 ID', 403);
}
function fileVisible(principal, rawPath) {
  if (principal.admin) return true;
  try {
    const relative = path.relative(fs.realpathSync(config.uploads), fs.realpathSync(rawPath));
    const top = relative.split(path.sep)[0];
    return !!top && top !== '..' && !path.isAbsolute(relative) && users.grants(principal.user.id).some(key => safeKey(key) === top);
  } catch { return false; }
}
// Public view of a session: the avatar file name becomes a signed URL (an <img> cannot send a bearer token).
function publicSession(entry, principal) {
  const { avatar, hook, ...rest } = entry;
  const url = avatar ? media.url(path.join(avatarDir, avatar), [avatarDir], entry.key, principalUid(principal)) : null;
  return url ? { ...rest, avatar_url: url } : rest;
}
const AVATAR_TYPES = [['png', b => b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG'], ['jpg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['gif', b => b.subarray(0, 4).toString() === 'GIF8'], ['webp', b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP']];
function removeAvatar(key) {
  const name = sessions[key]?.avatar;
  if (name) try { fs.unlinkSync(path.join(avatarDir, path.basename(name))); } catch { /* already gone */ }
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false;
    req.on('data', chunk => { if (done) return; size += chunk.length; if (size > limit) { done = true; reject(failure('头像图片不能超过 2MB', 413)); return; } chunks.push(chunk); });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', error => { if (!done) { done = true; reject(error); } });
  });
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
  const u = principal.user;
  return { ok: true, auth: principal.kind, role: principal.admin ? 'admin' : 'user',
    user: u ? {
      id: u.id, username: u.username, role: u.role, last_login_at: u.last_login_at,
      avatar_url: u.avatar_url || '', display_name: u.display_name || '',
      auth_provider: u.auth_provider || 'password', has_password: !!u.has_password,
    } : null,
    needs_setup: !users.hasAdmin() };
}
function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function signFeishuPending(pending) {
  const body = Buffer.from(JSON.stringify(pending)).toString('base64url');
  const sig = crypto.createHmac('sha256', feishuStateSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyFeishuPending(raw) {
  const text = String(raw || '');
  const dot = text.lastIndexOf('.');
  if (dot < 1) return null;
  const body = text.slice(0, dot), sig = text.slice(dot + 1);
  const expect = crypto.createHmac('sha256', feishuStateSecret).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const pending = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!pending || typeof pending.state !== 'string' || typeof pending.ts !== 'number') return null;
    return pending;
  } catch { return null; }
}
function feishuRedirectUri(req) {
  const configured = settings.feishu().redirect_uri;
  if (configured) return configured;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return DEFAULT_FEISHU_REDIRECT;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  return `${proto}://${host}/api/auth/feishu/callback`;
}
function safeConsoleNext(nextUrl) {
  const fallback = '/console/';
  if (typeof nextUrl !== 'string' || !nextUrl.startsWith('/') || nextUrl.startsWith('//')) return fallback;
  if (nextUrl.startsWith('/api/') || nextUrl.startsWith('/auth/')) return fallback;
  return nextUrl.slice(0, 200) || fallback;
}
function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...extraHeaders });
  res.end();
}
function cookieSecureFlag(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https' || process.env.FEISHU_COOKIE_SECURE === '1' ? '; Secure' : '';
}
function clearFeishuCookie(req) {
  return `${FEISHU_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureFlag(req)}`;
}
function setFeishuCookie(req, value) {
  return `${FEISHU_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${feishu.STATE_TTL}${cookieSecureFlag(req)}`;
}
function feishuErrorRedirect(key) {
  return `/console/?feishu_error=${encodeURIComponent(key || 'token_failed')}`;
}
async function handleFeishuLogin(req, res, url) {
  if (!feishu.enabled(settings)) { redirect(res, feishuErrorRedirect('disabled')); return; }
  const nextUrl = safeConsoleNext(url.searchParams.get('next') || '/console/');
  const redirectUri = feishuRedirectUri(req);
  let authorize;
  try { authorize = feishu.buildAuthorize(settings, redirectUri, nextUrl); }
  catch (error) {
    if (error instanceof feishu.FeishuLoginError) { redirect(res, feishuErrorRedirect(error.key)); return; }
    throw error;
  }
  redirect(res, authorize.url, { 'Set-Cookie': setFeishuCookie(req, signFeishuPending(authorize.pending)) });
}
async function handleFeishuCallback(req, res, url) {
  const cookies = parseCookies(req.headers.cookie);
  const pending = verifyFeishuPending(cookies[FEISHU_COOKIE]);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const clear = { 'Set-Cookie': clearFeishuCookie(req) };
  const now = Math.floor(Date.now() / 1000);
  let stateOk = false;
  try {
    const a = Buffer.from(String(pending?.state || ''));
    const b = Buffer.from(state);
    stateOk = !!pending && a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b) && (now - pending.ts) <= feishu.STATE_TTL;
  } catch { stateOk = false; }
  if (!stateOk) { redirect(res, feishuErrorRedirect(pending ? 'expired' : 'state'), clear); return; }
  if (url.searchParams.get('error') || !code) { redirect(res, feishuErrorRedirect('cancelled'), clear); return; }
  try {
    const userToken = await feishu.exchangeCode(settings, code, pending.verifier || '', pending.redirect_uri || feishuRedirectUri(req));
    const profile = await feishu.fetchUser(userToken);
    const result = await users.loginOrCreateFeishu(profile);
    const next = safeConsoleNext(pending.next);
    const sep = next.includes('?') ? '&' : '?';
    redirect(res, `${next}${sep}auth_token=${encodeURIComponent(result.token)}`, clear);
    console.log(`feishu_login_ok name=${(profile.name || profile.en_name || '').slice(0, 40)} open_id=${feishu.mask(profile.open_id)}`);
  } catch (error) {
    if (error instanceof feishu.FeishuLoginError) {
      console.warn(`feishu_login_failed reason=${error.key}`);
      redirect(res, feishuErrorRedirect(error.key), clear); return;
    }
    if (error.status === 403) { redirect(res, feishuErrorRedirect('account_disabled'), clear); return; }
    console.warn(`feishu_login_failed reason=server status=${error.status || 500}`);
    redirect(res, feishuErrorRedirect('token_failed'), clear);
  }
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
  if (body.codex_session_id !== undefined && !validThreadId(body.codex_session_id)) throw failure('Invalid codex_session_id: 会话 ID 应为 UUID', 400);
  if (body.callback_url !== undefined) {
    let url;
    try { url = new URL(body.callback_url); } catch { throw failure('Invalid callback_url', 400); }
    if (typeof body.callback_url !== 'string' || !['http:', 'https:'].includes(url.protocol)) throw failure('Invalid callback_url', 400);
  }
}

// Console UI: the Vue build in web/dist (SPA, served under /console/) when present,
// otherwise the legacy single-file console.html. /console/legacy always serves the legacy page.
const consoleDist = path.resolve(process.env.CONSOLE_DIST || path.join(__dirname, 'web', 'dist'));
const consoleCsp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'";
const staticTypes = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8' };
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
    const headers = { 'Content-Type': staticTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (path.basename(target) === 'sw.js') headers['Service-Worker-Allowed'] = '/console/';
    res.writeHead(200, headers);
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
  media.serve(req, res, signed.file, signed.download);
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
  const push = (name, data) => {
    // A stuck client must not grow an unbounded outbound buffer.
    if (queue.length >= 250) {
      const kept = queue.filter(item => item.name !== 'delta').slice(-80);
      queue.length = 0;
      queue.push(...kept, { name, data });
    } else queue.push({ name, data });
    if (!flushTimer) flushTimer = setTimeout(flush, 60);
  };
  const snapshot = () => {
    const id = sessions[key]?.codex_session_id;
    const state = id && appserver ? appserver.threads.get(id) : null;
    const relay = live.get(key);
    write(event('snapshot', { key, codex_session_id: id || null, running: !!(relay?.running || state?.status === 'active' || state?.live), queued: relay?.queued || 0, queue: publicQueue(key), live: publicLive(state?.live || null, key, principal, cachedThread(key)), prompts: sessionPrompts(key) }));
  };
  write('retry: 3000\n\n');
  snapshot();
  const onQueue = (changed, queue) => { if (changed === key) { push('queue', { queue, running: !!live.get(key)?.running || threadBusy(key) }); flush(); } };
  queueListeners.add(onQueue);
  const off = appserver ? appserver.onLive((threadId, data) => {
    if (threadId !== sessions[key]?.codex_session_id) return;
    // Copy now: the live item keeps changing (deltas) before the batch is flushed.
    if (data.type === 'item') push('item', { item: { ...publicLiveItem(data.item, key, uid, mediaRoots(key, cachedThread(key))) }, turnId: data.turnId || null });
    else if (data.type === 'delta') push('delta', data);
    else if (data.type === 'turn') { push('turn', data); flush(); }
  }) : () => {};
  const offPrompt = appserver ? appserver.onPrompt((threadId, data) => {
    if (threadId !== sessions[key]?.codex_session_id) return;
    if (data.type === 'prompt') push('prompt', { prompt: publicPrompt(data.prompt) });
    else push('prompt_resolved', { id: data.id, reason: data.reason });
    flush();
  }) : () => {};
  // Joined mid-turn (e.g. relay restarted): seed the live buffer from the thread snapshot.
  const id = sessions[key]?.codex_session_id;
  if (appserver?.connected && id && !appserver.threads.get(id)?.live && appserver.threads.get(id)?.status === 'active') {
    appserver.readThread(id).then(cache => { const turn = appserver.runningTurn(cache.thread); if (turn && appserver.seedLive(id, turn)) snapshot(); }).catch(() => {});
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
    clearInterval(heartbeat); clearTimeout(flushTimer); off(); offPrompt(); queueListeners.delete(onQueue); streams.delete(entry);
  }
  req.on('close', close);
  res.on('close', close);
}

// /webhook takes mode from the body (default 排队); /webhook/queue and /webhook/steer fix it by path.
// The old shared endpoints (session in the body, WEBHOOK_TOKEN as the key) are retired; each session now
// has its own URL /hook/<id> and its own key, so a sender can reach only that one session.
const WEBHOOK_ROUTES = ['/webhook', '/webhook/queue', '/webhook/steer'];
const SEND_ROUTES = ['/hook', '/api/send'];
const HOOK_ROUTE = /^\/hook\/([0-9a-f]{24})$/;
function newHook(id) { return { id: id || crypto.randomBytes(12).toString('hex'), secret: `dbk_${crypto.randomBytes(24).toString('base64url')}`, created_at: new Date().toISOString() }; }
function hookKey(id) { return Object.keys(sessions).find(key => sessions[key].hook?.id === id) || null; }
function hookAuthorized(req, key) {
  const secret = sessions[key]?.hook?.secret;
  if (!secret) return false;
  const digest = value => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(req.headers.authorization || ''), digest(`Bearer ${secret}`));
}
function hookView(key) { const { id, secret, created_at } = sessions[key].hook; return { path: `/hook/${id}`, secret, created_at }; }
function sendMode(route, body) {
  if (route === '/webhook/queue') return 'queue';
  if (route === '/webhook/steer') return 'steer';
  const mode = body.mode === undefined || body.mode === '' ? 'queue' : body.mode;
  if (!['queue', 'steer'].includes(mode)) throw failure('Invalid mode: 应为 queue（排队）或 steer（引导）', 400);
  return mode;
}
const server = http.createServer(async (req, res) => {
  const started = Date.now(), requestId = crypto.randomUUID();
  let body, route;
  let requestRecorded = false;
  const record = (status, extra = {}) => {
    log({ request_id: requestId, session: body?.session, status, duration: Date.now() - started, ...extra });
    if (SEND_ROUTES.includes(route) && !requestRecorded && status !== 202) {
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
    if (req.method === 'POST' && WEBHOOK_ROUTES.includes(route)) { send(res, 410, { error: '旧的 /webhook 已停用，请使用会话自己的 Webhook 地址和密钥（在控制台会话页的 Webhook 里查看）' }); log({ request_id: requestId, status: 410, path: route }); return; }
    const hookMatch = req.method === 'POST' ? HOOK_ROUTE.exec(route) : null;
    let hookSessionKey = null;
    if (hookMatch) {
      route = '/hook';
      hookSessionKey = hookKey(hookMatch[1]);
      // Unknown id and wrong key answer the same, so ids cannot be probed.
      if (!hookSessionKey || !hookAuthorized(req, hookSessionKey)) { send(res, 401, { error: 'Unauthorized' }); record(401); return; }
      // Paused by an admin: reject without reading the body; the sender can retry after it resumes.
      if (sessions[hookSessionKey].paused) { body = { session: hookSessionKey }; send(res, 423, { error: '该会话已暂停接收', paused: true, session: hookSessionKey }); record(423, { error: '已暂停接收' }); return; }
    } else if (!(req.method === 'GET' && route === '/sessions') && !route.startsWith('/api/')) { send(res, 404, { error: 'Not found' }); record(404); return; }
    if (req.method === 'GET' && route === '/api/auth/status') { send(res, 200, { needs_setup: !users.hasAdmin() }); return; }
    if (req.method === 'GET' && route === '/api/auth/feishu/status') {
      send(res, 200, { enabled: feishu.enabled(settings) }); return;
    }
    if (req.method === 'GET' && route === '/api/auth/feishu/login') { await handleFeishuLogin(req, res, url); return; }
    if (req.method === 'GET' && route === '/api/auth/feishu/callback') { await handleFeishuCallback(req, res, url); return; }
    if (req.method === 'POST' && route === '/api/auth/login') {
      const input = await readJson(req);
      send(res, 200, await users.login(input.username, input.password)); return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && route.startsWith('/api/media/')) { serveMedia(req, res, url); return; }
    const principal = hookSessionKey ? { kind: 'hook', admin: false, user: null, session: hookSessionKey } : authenticate(req);
    if (!principal) { send(res, 401, { error: 'Unauthorized' }); record(401); return; }
    const visible = visibleKeys(principal);
    if (route === '/sessions') {
      const listing = await sessionListing();
      send(res, 200, { sessions: Object.fromEntries(listing.filter(s => sessions[s.key] && (!visible || visible.has(s.key))).map(({ key, status, queued, hook, avatar, ...entry }) => [key, entry])) }); record(200); return;
    }
    if (route.startsWith('/api/') && route !== '/api/send') {
      if (req.method === 'GET' && route === '/api/files') {
        if (!fileVisible(principal, url.searchParams.get('path'))) throw failure('File not found', 404);
        serveFile(req, res, url.searchParams.get('path'), config.uploads); return;
      }
      if (req.method === 'GET' && route === '/api/whoami') { send(res, 200, { ...principalInfo(principal), limits: { max_file_bytes: config.maxBytes, max_files: config.maxFiles, max_total_bytes: config.maxTotal } }); return; }
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
      if (route === '/api/settings/feishu') {
        if (!principal.admin) throw failure('Forbidden', 403);
        if (req.method === 'GET') { send(res, 200, settings.publicFeishu(DEFAULT_FEISHU_REDIRECT)); return; }
        if (req.method === 'PUT') {
          const input = await readJson(req);
          send(res, 200, settings.setFeishu({
            app_id: input.app_id, app_secret: input.app_secret, redirect_uri: input.redirect_uri, enabled: input.enabled,
          })); return;
        }
        throw failure('Method not allowed', 405);
      }
      if (route === '/api/users' || route.startsWith('/api/users/')) { await handleUsers(req, res, route, principal); return; }
      if (req.method === 'GET' && route === '/api/codex/threads') {
        if (!principal.admin) throw failure('Forbidden', 403);
        send(res, 200, await listCodexThreads(url)); return;
      }
      if (req.method === 'GET' && route === '/api/models') {
        if (!principal.admin) throw failure('仅管理员可以查看模型', 403);
        send(res, 200, { models: await modelList() }); return;
      }
      if (req.method === 'GET' && route === '/api/usage') {
        if (!principal.admin) throw failure('仅管理员可以查看用量', 403);
        send(res, 200, { usage: await usageSnapshot() }); return;
      }
      if (req.method === 'GET' && route === '/api/sessions') {
        const listing = await sessionListing();
        send(res, 200, { sessions: (visible ? listing.filter(s => visible.has(s.key)) : listing).map(s => publicSession(s, principal)) }); return;
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
      const match = route.match(/^\/api\/sessions\/([^/]+)(\/history|\/stream|\/interrupt|\/avatar|\/users|\/prompts\/[A-Za-z0-9_-]{1,64}|\/webhook(?:\/rotate)?|\/queue(?:\/[0-9a-f-]{36}(?:\/steer)?)?)?$/);
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
          if (!principal.admin) throw failure('仅管理员可以关联会话', 403);
          const input = await readJson(req);
          if (!validThreadId(input.codex_session_id)) throw failure('会话 ID 格式不正确（应为 UUID，例如 01a1a610-8626-7623-aba8-66d060441079）', 400);
          if (live.has(key)) throw failure('Session is running or queued', 409);
          await verifyThread(input.codex_session_id);
          const now = new Date().toISOString(), existed = !!sessions[key];
          const previous = sessions[key]?.codex_session_id;
          sessions[key] = { ...sessions[key], codex_session_id: input.codex_session_id, created_at: sessions[key]?.created_at || now, updated_at: now, messages: sessions[key]?.codex_session_id === input.codex_session_id ? sessions[key].messages || 0 : 0 };
          persist();
          if (appserver && previous && previous !== input.codex_session_id
            && !Object.values(sessions).some(entry => entry?.codex_session_id === previous)) appserver.forgetThread(previous);
          if (appserver) void appserver.subscribe(input.codex_session_id).catch(() => {});
          send(res, existed ? 200 : 201, { session: { key, ...sessions[key] } }); return;
        }
        // Admin: the session's own webhook (URL + key), created on first view; rotate replaces the key at once.
        if ((req.method === 'GET' && match[2] === '/webhook') || (req.method === 'POST' && match[2] === '/webhook/rotate')) {
          if (!principal.admin) throw failure('仅管理员可以查看会话的 Webhook', 403);
          if (!sessions[key]) throw failure('会话不存在', 404);
          if (!sessions[key].hook || req.method === 'POST') { sessions[key].hook = newHook(sessions[key].hook?.id); persist(); }
          send(res, 200, { webhook: hookView(key) }); return;
        }
        // Admin: who may use this session (multi-user share). Admins always see everything and are omitted.
        if ((req.method === 'GET' || req.method === 'PUT') && match[2] === '/users') {
          if (!principal.admin) throw failure('仅管理员可以分配会话', 403);
          if (!sessions[key]) throw failure('会话不存在', 404);
          if (req.method === 'GET') {
            const assigned = users.grantees(key);
            const candidates = users.list().filter(u => u.role !== 'admin');
            send(res, 200, { session: key, users: candidates, assigned: assigned.map(u => u.id) }); return;
          }
          const input = await readJson(req, 64 * 1024);
          const assigned = users.setSessionUsers(key, input.user_ids || input.users || []);
          send(res, 200, { session: key, assigned: assigned.map(u => u.id), users: assigned }); return;
        }
        // Admin: rename a session (display name only; the key and the Codex thread stay the same),
        // and/or pause it: a paused session rejects webhook messages; the console still works.
        if (req.method === 'PATCH' && !match[2]) {
          if (!principal.admin) throw failure('仅管理员可以修改会话', 403);
          if (!sessions[key]) throw failure('会话不存在', 404);
          const input = await readJson(req);
          if (input.name === undefined && input.paused === undefined && input.model === undefined && input.effort === undefined && input.service_tier === undefined && input.approval_mode === undefined) throw failure('没有要修改的内容', 400);
          if (input.name !== undefined && typeof input.name !== 'string') throw failure('名称格式不正确', 400);
          if (input.paused !== undefined && typeof input.paused !== 'boolean') throw failure('paused 应为 true 或 false', 400);
          if (input.approval_mode !== undefined && input.approval_mode !== null && !APPROVAL_MODES.includes(input.approval_mode)) throw failure('批准模式不正确', 400);
          if (input.name !== undefined) {
            const name = input.name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
            if (name.length > 60) throw failure('名称最多 60 个字符', 400);
            if (name && name !== key) sessions[key].name = name; else delete sessions[key].name;
          }
          if (input.model !== undefined && input.model !== null && (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 120)) throw failure('模型格式不正确', 400);
          if (input.model === null) delete sessions[key].model; else if (input.model !== undefined) sessions[key].model = input.model.trim();
          for (const [field, label] of [['effort', '思考深度'], ['service_tier', '速度']]) {
            const v = input[field];
            if (v === undefined) continue;
            if (v !== null && (typeof v !== 'string' || !v.trim() || v.length > 60)) throw failure(label + '格式不正确', 400);
          }
          // Soft check against the cached model list (when warm): unknown values are rejected.
          const chosen = sessions[key].model && modelCache?.models.find(m => m.id === sessions[key].model);
          if (chosen && typeof input.effort === 'string' && chosen.supportedReasoningEfforts.length && !chosen.supportedReasoningEfforts.some(e => e.id === input.effort.trim())) throw failure('该模型不支持这个思考深度', 400);
          if (chosen && typeof input.service_tier === 'string' && !chosen.serviceTiers.some(t => t.id === input.service_tier.trim())) throw failure('该模型不支持这个速度', 400);
          for (const field of ['effort', 'service_tier']) {
            if (input[field] === null) delete sessions[key][field]; else if (input[field] !== undefined) sessions[key][field] = input[field].trim();
          }
          if (input.approval_mode === null || input.approval_mode === 'ask') delete sessions[key].approval_mode; else if (input.approval_mode !== undefined) sessions[key].approval_mode = input.approval_mode;
          if (input.paused === true && !sessions[key].paused) { sessions[key].paused = true; sessions[key].paused_at = new Date().toISOString(); }
          if (input.paused === false) { delete sessions[key].paused; delete sessions[key].paused_at; }
          persist();
          send(res, 200, { session: publicSession({ key, ...sessions[key] }, principal) }); return;
        }
        // Admin: set or clear a session avatar (PNG/JPEG/GIF/WebP, stored under data/avatars).
        if ((req.method === 'PUT' || req.method === 'DELETE') && match[2] === '/avatar') {
          if (!principal.admin) throw failure('仅管理员可以设置会话头像', 403);
          if (!sessions[key]) throw failure('会话不存在', 404);
          if (req.method === 'DELETE') { removeAvatar(key); delete sessions[key].avatar; persist(); send(res, 200, { session: publicSession({ key, ...sessions[key] }, principal) }); return; }
          const body = await readRaw(req, 2 * 1024 * 1024);
          const type = AVATAR_TYPES.find(([, test]) => body.length > 12 && test(body));
          if (!type) throw failure('只支持 PNG、JPG、GIF 或 WebP 图片', 415);
          const name = `${safeKey(key)}-${crypto.randomBytes(6).toString('hex')}.${type[0]}`;
          fs.writeFileSync(path.join(avatarDir, name), body, { mode: 0o600 });
          removeAvatar(key);
          sessions[key].avatar = name; persist();
          send(res, 200, { session: publicSession({ key, ...sessions[key] }, principal) }); return;
        }
        if (!userCanUse(principal, key)) throw failure('会话不存在', 404);
        if (req.method === 'GET' && match[2] === '/history') { send(res, 200, await sessionHistory(key, limitOf(url, 50, 550), principal, beforeOf(url))); return; }
        // Answer an approval / question card: { decision } or { answers: { questionId: string | string[] } }.
        if (req.method === 'POST' && match[2]?.startsWith('/prompts/')) {
          const promptId = match[2].slice(9), threadId = sessions[key]?.codex_session_id;
          const prompt = appserver && threadId ? appserver.promptById(promptId) : null;
          if (!prompt || prompt.threadId !== threadId) throw failure('该请求已处理或已失效', 404);
          const input = await readJson(req);
          const result = appserver.answerPrompt(promptId, { decision: typeof input.decision === 'string' ? input.decision : undefined, answers: input.answers });
          log({ request_id: requestId, event: 'prompt_answered', session: key, kind: result.kind, decision: result.decision, user: principal.user?.username || null, status: 200, duration: Date.now() - started });
          send(res, 200, { ok: true, ...result }); return;
        }
        if (req.method === 'GET' && match[2] === '/stream') { streamSession(req, res, key, principal); return; }
        if (req.method === 'GET' && match[2] === '/queue') { send(res, 200, { queue: publicQueue(key), running: !!live.get(key)?.running || threadBusy(key) }); return; }
        if (req.method === 'POST' && match[2]?.startsWith('/queue/') && match[2].endsWith('/steer')) { send(res, 200, { ok: true, ...await steerQueued(key, match[2].slice(7, -6), principal) }); return; }
        if (req.method === 'DELETE' && match[2]?.startsWith('/queue/') && !match[2].endsWith('/steer')) { const entry = cancelQueued(key, match[2].slice(7), principal); send(res, 200, { ok: true, id: entry.id }); return; }
        if (req.method === 'POST' && match[2] === '/interrupt') { const turnId = await interruptSession(key); send(res, 200, { ok: true, turn_id: turnId }); return; }
        if (req.method === 'DELETE' && !match[2]) {
          if (!principal.admin) throw failure('仅管理员可以删除会话', 403);
          if (live.has(key)) throw failure('Session is running or queued', 409);
          if (!sessions[key] && !fs.existsSync(file)) throw failure('Session not found', 404);
          const previous = sessions[key]?.codex_session_id;
          removeAvatar(key); delete sessions[key]; persist(); users.forgetSession(key);
          if (appserver && previous && !Object.values(sessions).some(entry => entry?.codex_session_id === previous)) appserver.forgetThread(previous);
          try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          send(res, 200, { ok: true }); return;
        }
      }
      send(res, 404, { error: 'Not found' }); return;
    }
    if (req.method !== 'POST') { send(res, 404, { error: 'Not found' }); record(404); return; }
    const parsed = await readRequest(req, config);
    body = parsed.body;
    if (principal.kind === 'hook' && body && typeof body === 'object') body.session = principal.session;
    if (body && typeof body === 'object') body._fileCount = parsed.files.length;
    validate(body);
    const mode = sendMode(route, body);
    authorizeSend(principal, body);
    // Linking must name a thread that exists in Codex; nothing is created otherwise.
    if (body.codex_session_id !== undefined && body.codex_session_id !== sessions[body.session]?.codex_session_id) await verifyThread(body.codex_session_id);
    // Never create a Codex thread: unknown/unlinked sessions are rejected before anything is queued.
    if (!(body.codex_session_id || sessions[body.session]?.codex_session_id)) throw failure('会话不存在或未关联；控制台和 webhook 不会新建会话，请让管理员关联已有会话', 404);
    if (!body.message?.trim()) body.message = '请查看附件。';
    const prepared = await prepareAttachments(body, parsed.files, config, safeKey);
    body.attachments = prepared.attachments;
    body.input = prepared.input;
    const { entry, job, accepted } = enqueue(body, route === '/api/send' ? 'console' : 'webhook', requestId, { mode, user: principal.user?.username || null });
    await accepted;
    // Console sends return at once; the turn is followed over the stream.
    if (route === '/api/send' && ['1', 'true', true].includes(body.async)) {
      const q = sessionQueues.get(body.session);
      const index = q ? q.items.indexOf(entry) : -1;
      // First in line with nothing running: the worker is about to start it.
      const startsNow = index === 0 && !q.running && !threadBusy(body.session);
      const status = q?.steered.includes(entry) ? 'steered' : q?.running === entry || startsNow ? 'running' : 'queued';
      send(res, 202, { accepted: true, session: body.session, id: entry.id, mode, status, position: status === 'queued' ? index + 1 : 0, ...(entry.fallback ? { steer_fallback: entry.fallback } : {}) });
      record(202);
      void job.then(result => record(200, { message: body.message.slice(0, 200), reply: result.reply.slice(0, 200), transport: result.transport || 'exec' }), error => record(error.status || 500, { error: error.message, ...(error.transport ? { transport: error.transport } : {}) }));
      return;
    }
    if (route !== '/api/send' && body.callback_url !== undefined) {
      send(res, 202, { accepted: true, session: body.session, id: entry.id, mode });
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
