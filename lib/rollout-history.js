'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHUNK = 256 * 1024;
const EXTEND_TARGET = 1024 * 1024;
const MAX_EXTEND_PER_REQUEST = 32 * 1024 * 1024;
const MAX_OUTPUT = 8000;

function findRolloutFile(codexHome, threadId) {
  if (!codexHome || !threadId) return null;
  const needle = `-${String(threadId).toLowerCase()}.jsonl`;
  let jsonl = null, zst = null;
  for (const dir of ['sessions', 'archived_sessions']) {
    const root = path.join(codexHome, dir);
    let names;
    try { names = fs.readdirSync(root, { recursive: true }); } catch { continue; }
    for (const name of names) {
      const lower = String(name).toLowerCase();
      const full = path.join(root, name);
      if (lower.endsWith(needle + '.zst')) zst = zst || full;
      else if (lower.endsWith(needle)) jsonl = jsonl || full;
    }
  }
  if (jsonl) return { path: jsonl, compressed: false };
  if (zst) return { path: zst, compressed: true };
  return null;
}

function rolloutFileSize(codexHome, threadId) {
  const found = findRolloutFile(codexHome, threadId);
  if (!found) return null;
  try { return fs.statSync(found.path).size; } catch { return null; }
}

function unixSeconds(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value / 1000 : value;
  }
  if (typeof value === 'string') {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 0) return asNum > 1e12 ? asNum / 1000 : asNum;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  return undefined;
}

function truncateOutput(text) {
  if (typeof text !== 'string' || text.length <= MAX_OUTPUT) return text;
  return text.slice(-MAX_OUTPUT);
}

function convertItem(item) {
  if (!item || typeof item !== 'object' || !item.type) return null;
  const type = item.type;
  if (type === 'UserMessage') return { type: 'userMessage', id: item.id, content: item.content };
  if (type === 'AgentMessage') {
    const text = [item.text, ...(item.content || []).map(part => part && part.text)].filter(part => typeof part === 'string').join('')
      || (item.content || []).map(part => part && part.text).filter(Boolean).join('');
    return { type: 'agentMessage', id: item.id, text: text || '', phase: item.phase || null };
  }
  if (type === 'CommandExecution') {
    return {
      type: 'commandExecution', id: item.id, command: item.command, cwd: item.cwd,
      status: item.status, aggregatedOutput: truncateOutput(item.aggregated_output || item.aggregatedOutput),
      exitCode: item.exit_code ?? item.exitCode ?? null,
    };
  }
  if (type === 'Reasoning') {
    const summary = item.summary || (item.summary_text ? [item.summary_text] : []);
    return { type: 'reasoning', id: item.id, summary };
  }
  if (type === 'McpToolCall') {
    return { type: 'mcpToolCall', id: item.id, server: item.server, tool: item.tool, status: item.status, result: item.result };
  }
  if (type === 'FileChange') {
    const raw = item.changes;
    const changes = Array.isArray(raw) ? raw
      : raw && typeof raw === 'object' ? Object.entries(raw).map(([file, change]) => ({ path: file, ...(change && typeof change === 'object' ? change : {}) }))
      : [];
    return { type: 'fileChange', id: item.id, changes, status: item.status };
  }
  if (type === 'ImageView') return { type: 'imageView', id: item.id, path: item.path };
  if (type === 'ContextCompaction') return { type: 'contextCompaction', id: item.id };
  if (type === 'Extension') {
    if (item.kind === 'web.search' || item.query || item.action?.query || item.action?.queries) {
      return { type: 'webSearch', id: item.id, query: item.query || item.action?.query || item.action?.queries, status: item.status, action: item.action };
    }
    if (item.kind === 'image_gen.generation' || item.savedPath) {
      return { type: 'imageGeneration', id: item.id, status: item.status, savedPath: item.savedPath, revisedPrompt: item.revisedPrompt };
    }
    return { type: 'dynamicToolCall', id: item.id, tool: item.kind || 'extension', status: item.status };
  }
  return null;
}

function eventType(record) {
  if (record?.type === 'event_msg') return record.payload?.type || null;
  return null;
}

function isTurnStart(record) {
  const type = eventType(record);
  return type === 'task_started' || type === 'turn_started';
}

function isTurnEnd(record) {
  const type = eventType(record);
  return type === 'task_complete' || type === 'turn_complete' || type === 'turn_aborted';
}

function applyRecord(turns, open, record) {
  if (!record || typeof record !== 'object') return open;
  if (isTurnStart(record)) {
    const payload = record.payload || {};
    const id = payload.turn_id || payload.turnId;
    if (open && open.id !== id) turns.push(finishTurn(open, 'completed'));
    return {
      id: id || `rollout-${turns.length}`,
      status: 'inProgress',
      startedAt: unixSeconds(payload.started_at ?? payload.startedAt),
      items: [],
    };
  }
  if (eventType(record) === 'item_completed') {
    const payload = record.payload || {};
    const item = convertItem(payload.item);
    if (!item) return open;
    const turnId = payload.turn_id || payload.turnId;
    if (!open || (turnId && open.id !== turnId)) {
      if (open) turns.push(finishTurn(open, 'completed'));
      open = { id: turnId || `rollout-${turns.length}`, status: 'inProgress', startedAt: unixSeconds((payload.started_at_ms || 0) / 1000) || undefined, items: [] };
    }
    open.items.push(item);
    return open;
  }
  if (isTurnEnd(record)) {
    const payload = record.payload || {};
    const turnId = payload.turn_id || payload.turnId;
    if (open && (!turnId || open.id === turnId)) {
      open.startedAt = unixSeconds(payload.started_at ?? payload.startedAt) ?? open.startedAt;
      open.completedAt = unixSeconds(payload.completed_at ?? payload.completedAt);
      open.durationMs = payload.duration_ms ?? payload.durationMs;
      const aborted = eventType(record) === 'turn_aborted' || payload.status === 'interrupted';
      turns.push(finishTurn(open, aborted ? 'interrupted' : (payload.status === 'failed' ? 'failed' : 'completed')));
      return null;
    }
  }
  return open;
}

function finishTurn(turn, status) {
  return { ...turn, status: status || turn.status || 'completed' };
}

function parseForward(file, start, end, { open = null } = {}) {
  const turns = [];
  let current = open ? { ...open, items: [...(open.items || [])] } : null;
  if (start >= end) return { turns, open: current };
  const fd = fs.openSync(file, 'r');
  try {
    let offset = start;
    let carry = '';
    const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, end - start)));
    while (offset < end) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - offset), offset);
      if (n <= 0) break;
      offset += n;
      carry += buf.toString('utf8', 0, n);
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        current = applyRecord(turns, current, record);
      }
    }
    if (carry.trim() && offset >= end) {
      try { current = applyRecord(turns, current, JSON.parse(carry)); } catch { /* incomplete line at slice edge is held by caller */ }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { turns, open: current, remainder: undefined };
}

function readChunk(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.toString('utf8', 0, n);
}

// Walk backward from `from` and return the byte offset of a complete turn-start line, or 0.
function lineStartsIn(file, from, to) {
  // Return [{offset, line}] for complete lines that start in [from, to).
  const fd = fs.openSync(file, 'r');
  const out = [];
  try {
    let start = from;
    let carry = '';
    let carryAt = from;
    if (from > 0) {
      // If we do not start at a newline, skip the partial first line.
      const probe = Buffer.alloc(1);
      fs.readSync(fd, probe, 0, 1, from - 1);
      if (probe[0] !== 10) {
        // consume through the next newline
        let off = from;
        const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, to - from)));
        while (off < to) {
          const n = fs.readSync(fd, buf, 0, Math.min(buf.length, to - off), off);
          if (n <= 0) break;
          const text = buf.toString('utf8', 0, n);
          const nl = text.indexOf('\n');
          if (nl >= 0) { start = off + nl + 1; break; }
          off += n;
        }
        if (start === from && off >= to) return out;
      }
    }
    let offset = start;
    const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, to - start)));
    let acc = '', accAt = start;
    while (offset < to) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, to - offset), offset);
      if (n <= 0) break;
      acc += buf.toString('utf8', 0, n);
      offset += n;
      let cut;
      while ((cut = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, cut);
        out.push({ offset: accAt, line });
        acc = acc.slice(cut + 1);
        accAt += cut + 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

function findTurnStartByLineScan(file, from, targetBytes) {
  if (from <= 0) return { offset: 0, exhausted: true };
  const begin = Math.max(0, from - Math.max(targetBytes, CHUNK));
  const rows = lineStartsIn(file, begin, from);
  let found = null;
  for (const row of rows) {
    let record;
    try { record = JSON.parse(row.line); } catch { continue; }
    if (isTurnStart(record)) found = row.offset;
  }
  if (found !== null) return { offset: found, exhausted: begin === 0 && rows[0]?.offset === found };
  if (begin === 0) return { offset: 0, exhausted: true };
  return { offset: begin, exhausted: false, needMore: true };
}

function emptyIndex(file, size, mtimeMs) {
  return { path: file, size, mtimeMs, startOffset: size, turns: [], open: null, exhausted: size === 0 };
}

function syncIndexFile(index, file) {
  const st = fs.statSync(file);
  if (!index || index.path !== file || st.size < index.size) {
    return { index: emptyIndex(file, st.size, st.mtimeMs), size: st.size, mtimeMs: st.mtimeMs, grew: false, reset: true };
  }
  return { index, size: st.size, mtimeMs: st.mtimeMs, grew: st.size > index.size, reset: false };
}

function mergeTurn(earlier, later) {
  const seen = new Set((earlier.items || []).map(item => item.id).filter(Boolean));
  return {
    ...later, ...earlier,
    startedAt: earlier.startedAt ?? later.startedAt,
    completedAt: later.completedAt ?? earlier.completedAt,
    durationMs: later.durationMs ?? earlier.durationMs,
    status: (later.status && later.status !== 'inProgress') ? later.status : earlier.status,
    items: [...(earlier.items || []), ...(later.items || []).filter(item => !item.id || !seen.has(item.id))],
  };
}

function prependTurns(base, prefix) {
  if (!prefix.length) return base;
  const used = new Set();
  const out = [];
  for (const turn of prefix) {
    const later = base.find(item => item.id === turn.id);
    out.push(later ? mergeTurn(turn, later) : turn);
    used.add(turn.id);
  }
  for (const turn of base) if (!used.has(turn.id)) out.push(turn);
  return out;
}

function appendTurns(base, extra) {
  if (!extra.length) return base;
  const out = [...base];
  for (const turn of extra) {
    const i = out.findIndex(item => item.id === turn.id);
    if (i >= 0) out[i] = mergeTurn(out[i], turn);
    else out.push(turn);
  }
  return out;
}

function displayStubEntries(turns) {
  const entries = [];
  for (const turn of turns) {
    const started = turn.startedAt, time = turn.completedAt ?? turn.startedAt;
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') entries.push({ role: 'user', time: started, text: (item.content || []).map(p => p.type === 'text' ? p.text || '' : '').join('') });
    }
    if (turn.status !== 'inProgress') {
      const agents = (turn.items || []).filter(item => item.type === 'agentMessage');
      const finals = agents.filter(item => item.phase === 'final_answer');
      const answers = finals.length ? finals : agents.slice(-1);
      for (const item of answers) entries.push({ role: 'assistant', time, text: item.text || '' });
      if (turn.status === 'interrupted') entries.push({ role: 'error', time, text: '回合已停止' });
      if (turn.status === 'failed') entries.push({ role: 'error', time, text: '处理失败' });
    }
  }
  return entries;
}

function entryTimeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function pageCovered(entries, { limit, before, exhausted }) {
  if (exhausted) return true;
  if (!before) return entries.length > limit;
  const cut = entryTimeMs(before);
  if (!Number.isFinite(cut)) return false;
  const older = entries.filter(entry => {
    const stamp = entryTimeMs(entry.time);
    return Number.isFinite(stamp) && stamp < cut;
  });
  return older.length >= limit;
}

// Load a bounded tail (and older slices on demand) of a rollout JSONL into turns.
// Never reads the whole file unless the requested page requires it or the file is small.
function ensurePage(file, { limit = 30, before = null, index = null, maxBytes = MAX_EXTEND_PER_REQUEST } = {}) {
  const st = fs.statSync(file);
  const synced = syncIndexFile(index, file);
  index = synced.index;
  if (synced.grew) {
    const added = parseForward(file, index.size, synced.size, { open: index.open });
    index.turns = appendTurns(index.turns, added.turns);
    if (added.open && added.turns.some(turn => turn.id === added.open.id)) {
      // completed and reopened — keep open only if not already finished
    }
    const finishedIds = new Set(added.turns.map(turn => turn.id));
    index.open = added.open && !finishedIds.has(added.open.id) ? added.open : null;
    // If a previously open turn was finished in the suffix, it's in added.turns.
    index.size = synced.size;
    index.mtimeMs = synced.mtimeMs;
  }
  let used = 0;
  while (!pageCovered(displayStubEntries(index.turns), { limit, before, exhausted: index.exhausted }) && !index.exhausted && used < maxBytes) {
    const window = Math.min(EXTEND_TARGET, maxBytes - used);
    let found = findTurnStartByLineScan(file, index.startOffset, window);
    if (found.needMore && !found.exhausted) {
      const wider = findTurnStartByLineScan(file, index.startOffset, Math.min(maxBytes - used, window * 8));
      found = wider;
    }
    const newStart = found.offset;
    if (newStart >= index.startOffset) {
      if (found.exhausted || newStart === 0) { index.exhausted = true; index.startOffset = 0; break; }
      // No turn start in this window: step the window start back and retry once.
      if (index.startOffset - window <= 0) {
        const all = parseForward(file, 0, index.startOffset, { open: null });
        index.turns = prependTurns(index.turns, all.turns);
        index.startOffset = 0;
        index.exhausted = true;
        index.open = index.open || all.open;
        break;
      }
      // Force include this window even mid-turn, then next loop will look for an earlier start.
      const slice = parseForward(file, Math.max(0, index.startOffset - window), index.startOffset, { open: null });
      index.turns = prependTurns(index.turns, slice.turns);
      index.startOffset = Math.max(0, index.startOffset - window);
      used += window;
      continue;
    }
    const slice = parseForward(file, newStart, index.startOffset, { open: null });
    index.turns = prependTurns(index.turns, slice.turns);
    used += index.startOffset - newStart;
    index.startOffset = newStart;
    if (found.exhausted || newStart === 0) index.exhausted = true;
  }
  if (index.startOffset === 0) index.exhausted = true;
  index.size = synced.size;
  index.mtimeMs = synced.mtimeMs;
  return index;
}

function hasMore(index, pageHasMore) {
  if (pageHasMore) return true;
  return !!(index && !index.exhausted);
}

module.exports = {
  findRolloutFile,
  rolloutFileSize,
  convertItem,
  parseForward,
  ensurePage,
  displayStubEntries,
  pageCovered,
  hasMore,
  emptyIndex,
  unixSeconds,
  isTurnStart,
  CHUNK,
  MAX_EXTEND_PER_REQUEST,
};
