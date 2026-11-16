'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { ensurePage, parseForward, convertItem, findRolloutFile } = require('../lib/rollout-history');
const { writePaddedRollout, isoEntries, historyPage, keyOf, walkPages } = require('./rollout-fixture');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rollout-history-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function assertConvert() {
  const item = convertItem({
    type: 'AgentMessage', id: 'a1', phase: 'final_answer',
    content: [{ type: 'Text', text: 'hello ' }, { type: 'Text', text: 'world' }],
  });
  assert.equal(item.type, 'agentMessage');
  assert.equal(item.text, 'hello world');
  assert.equal(item.phase, 'final_answer');
  const user = convertItem({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }] });
  assert.equal(user.type, 'userMessage');
}

async function freePort() {
  const socket = http.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function main() {
  assertConvert();

  const home = path.join(temp, 'codex-home');
  const threadId = crypto.randomUUID();
  const written = writePaddedRollout(home, threadId, { padBytes: 17 * 1024 * 1024, earlyTurns: 40, lateTurns: 40 });
  assert.ok(written.size > 16 * 1024 * 1024, `expected a >16MB rollout, got ${written.size}`);
  assert.equal(findRolloutFile(home, threadId).path, written.file);
  assert.equal(findRolloutFile(home, threadId).compressed, false);

  const first = ensurePage(written.file, { limit: 30 });
  assert.ok(first.startOffset > 0, 'first page must not scan the whole padded file');
  const firstEntries = isoEntries(first.turns);
  const firstPage = historyPage(firstEntries, 30, null);
  const texts = firstPage.entries.map(e => e.text);
  assert.ok(texts.some(t => String(t).startsWith('LATE-ASSISTANT-')), 'recent assistant replies must be present after a 16MB-class skip');
  assert.ok(!texts.some(t => String(t).startsWith('EARLY-')), 'newest page should be late turns only');
  assert.equal(firstPage.entries.filter(e => e.role === 'assistant').length > 0, true);
  assert.equal(first.exhausted, false);
  assert.equal(firstPage.has_more || !first.exhausted, true);

  const full = parseForward(written.file, 0, written.size);
  if (full.open) full.turns.push({ ...full.open, status: 'completed' });
  const expected = isoEntries(full.turns);
  assert.ok(expected.some(e => e.text === 'LATE-ASSISTANT-39'));
  assert.ok(expected.some(e => e.text === 'EARLY-ASSISTANT-0'));

  const walked = walkPages(written.file, { limit: 30, ensurePage });
  assert.equal(walked.entries.length, expected.length, 'paged walk must not drop or duplicate entries');
  assert.deepEqual(walked.entries.map(keyOf), expected.map(keyOf));
  assert.equal(walked.index.exhausted, true);

  // Incremental index reuse: a later before= request must extend, not reparse the tail from scratch.
  const firstStart = first.startOffset;
  const firstTurnCount = first.turns.length;
  const reused = ensurePage(written.file, { limit: 30, before: Date.parse(firstPage.entries[0].time), index: first });
  assert.ok(reused.startOffset < firstStart, 'before= should extend the existing index backward');
  assert.ok(reused.turns.length >= firstTurnCount, 'extending the index must keep already-read turns');
  const older = historyPage(isoEntries(reused.turns), 30, Date.parse(firstPage.entries[0].time));
  for (const entry of older.entries) assert.ok(Date.parse(entry.time) < Date.parse(firstPage.entries[0].time));
  const overlap = new Set(firstPage.entries.map(keyOf));
  for (const entry of older.entries) assert.ok(!overlap.has(keyOf(entry)), 'older page must not repeat the newest page');

  // Restart / empty cache: a fresh server process, no snapshot, appserver off, only-user local jsonl.
  const token = crypto.randomBytes(24).toString('hex');
  const dataDir = path.join(temp, 'data');
  const key = 'huge-restart';
  fs.mkdirSync(path.join(dataDir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'history', `${key}.jsonl`), written.late.map((turn, i) => JSON.stringify({
    role: 'user', text: turn.user, time: new Date(turn.start * 1000).toISOString(), source: 'console',
  }) + '\n').join(''));
  const port = await freePort();
  const env = {
    ...process.env, CODEX_APP_SERVER_SOCK: 'off', WEBHOOK_TOKEN: token, HOST: '127.0.0.1', PORT: String(port),
    DATA_DIR: dataDir, WORK_DIR: path.join(temp, 'work'), LOG_DIR: path.join(temp, 'logs'),
    UPLOAD_DIR: path.join(temp, 'uploads'), CODEX_HOME: home, CODEX_BIN: path.join(temp, 'missing-codex'),
  };
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  server.stdout.on('data', d => { diagnostics += d; });
  server.stderr.on('data', d => { diagnostics += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`server exited: ${diagnostics}`);
      try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
      if (i === 99) throw new Error(`server startup timeout: ${diagnostics}`);
      await pause(30);
    }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const bound = await fetch(`${base}/api/sessions/${key}`, { method: 'PUT', headers, body: JSON.stringify({ codex_session_id: threadId }) });
    assert.ok([200, 201].includes(bound.status), await bound.text());
    const newest = await (await fetch(`${base}/api/sessions/${key}/history?limit=30`, { headers })).json();
    assert.equal(newest.source, 'thread');
    const newestTexts = newest.history.map(e => e.text);
    assert.ok(newestTexts.some(t => String(t).startsWith('LATE-ASSISTANT-')), 'restart with empty cache must still return recent assistant text');
    assert.ok(!newestTexts.some(t => String(t).startsWith('EARLY-')), 'newest HTTP page should not jump into early turns');
    assert.equal(newest.has_more, true);
    assert.ok(newest.history.some(e => e.role === 'assistant'));

    const collected = [];
    const seen = new Set();
    let before = null, page = newest, pages = 0;
    for (;;) {
      pages++;
      for (const entry of page.history) {
        const k = keyOf(entry);
        assert.ok(!seen.has(k), `HTTP page ${pages} duplicated ${k}`);
        seen.add(k);
      }
      collected.unshift(...page.history);
      if (!page.has_more || !page.history.length) break;
      before = page.history[0].time;
      page = await (await fetch(`${base}/api/sessions/${key}/history?limit=30&before=${encodeURIComponent(before)}`, { headers })).json();
      assert.equal(page.source, 'thread');
      if (pages > 20) throw new Error('too many history pages');
    }
    assert.ok(pages >= 3, `expected several pages, got ${pages}`);
    assert.ok(collected.some(e => e.text === 'EARLY-ASSISTANT-0'), 'before= walk must reach the earliest assistant text');
    assert.ok(collected.some(e => e.text === 'LATE-ASSISTANT-39'));
    const collectedKeys = collected.filter(e => e.role === 'user' || e.role === 'assistant').map(e => `${e.role}|${e.text}`);
    const expectedKeys = expected.map(e => `${e.role}|${e.text}`);
    assert.deepEqual(collectedKeys, expectedKeys, 'HTTP pages must match a full parse, in order, without gaps');
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const closed = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      await closed;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('Rollout history tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
