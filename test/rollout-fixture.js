'use strict';

const fs = require('node:fs');
const path = require('node:path');

function line(type, payload) {
  return JSON.stringify({ timestamp: payload.started_at || payload.completed_at || 0, type: 'event_msg', payload: { type, ...payload } }) + '\n';
}

function turnBlock(i, { start, user, assistant, prefix }) {
  const turnId = `${prefix}-${i}`;
  return [
    line('task_started', { turn_id: turnId, started_at: start }),
    line('item_completed', { turn_id: turnId, item: { type: 'UserMessage', id: `${prefix}-u-${i}`, content: [{ type: 'text', text: user }] } }),
    line('item_completed', { turn_id: turnId, item: { type: 'AgentMessage', id: `${prefix}-a-${i}`, content: [{ type: 'Text', text: assistant }], phase: 'final_answer' } }),
    line('task_complete', { turn_id: turnId, started_at: start, completed_at: start + 1, status: 'completed' }),
  ].join('');
}

function writePaddedRollout(codexHome, threadId, { earlyTurns = 40, lateTurns = 40, padBytes = 17 * 1024 * 1024, earlyBase = 1_700_000_000, lateBase = 1_700_100_000 } = {}) {
  const dir = path.join(codexHome, 'sessions', '2026', '02', '02');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-02-02T00-00-00-${threadId}.jsonl`);
  const chunks = [];
  const early = [], late = [];
  for (let i = 0; i < earlyTurns; i++) {
    const user = `EARLY-USER-${i}`;
    const assistant = `EARLY-ASSISTANT-${i}`;
    early.push({ user, assistant, start: earlyBase + i * 10 });
    chunks.push(turnBlock(i, { start: earlyBase + i * 10, user, assistant, prefix: 'early' }));
  }
  let padded = 0;
  const piece = 64 * 1024;
  while (padded < padBytes) {
    const n = Math.min(piece, padBytes - padded);
    chunks.push(JSON.stringify({ type: 'event_msg', payload: { type: 'session_meta', pad: 'x'.repeat(n) } }) + '\n');
    padded += n;
  }
  for (let i = 0; i < lateTurns; i++) {
    const user = `LATE-USER-${i}`;
    const assistant = `LATE-ASSISTANT-${i}`;
    late.push({ user, assistant, start: lateBase + i * 10 });
    chunks.push(turnBlock(i, { start: lateBase + i * 10, user, assistant, prefix: 'late' }));
  }
  fs.writeFileSync(file, chunks.join(''));
  const size = fs.statSync(file).size;
  return { file, size, early, late, earlyBase, lateBase, padBytes };
}

function isoEntries(turns) {
  const { displayStubEntries } = require('../lib/rollout-history');
  return displayStubEntries(turns).map(entry => ({
    ...entry,
    time: typeof entry.time === 'number' ? new Date(entry.time > 1e12 ? entry.time : entry.time * 1000).toISOString() : entry.time,
  }));
}

function historyPage(all, limit, before) {
  const at = entry => { const t = Date.parse(entry.time); return Number.isFinite(t) ? t : -Infinity; };
  const list = before === null ? all : all.filter(entry => at(entry) < before);
  let start = Math.max(0, list.length - limit);
  while (start > 0 && at(list[start - 1]) === at(list[start]) && at(list[start]) !== -Infinity) start--;
  return { entries: list.slice(start), has_more: start > 0 };
}

function keyOf(entry) {
  return `${entry.role}|${entry.time}|${entry.text}`;
}

function walkPages(file, { limit = 30, ensurePage }) {
  let index = null, before = null, seen = new Set(), out = [];
  for (let i = 0; i < 50; i++) {
    index = ensurePage(file, { limit, before, index });
    const page = historyPage(isoEntries(index.turns), limit, before);
    const keys = page.entries.map(keyOf);
    for (const key of keys) {
      if (seen.has(key)) throw new Error(`duplicate history entry ${key}`);
      seen.add(key);
    }
    out = [...page.entries, ...out];
    const more = page.has_more || !index.exhausted;
    if (!more || !page.entries.length) break;
    before = Date.parse(page.entries[0].time);
  }
  return { entries: out, index };
}

module.exports = { writePaddedRollout, isoEntries, historyPage, keyOf, walkPages };
