#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
function die(message) { console.error(message); process.exit(2); }
if (args.shift() !== 'exec') die('expected exec');
const resume = args[0] === 'resume';
if (resume) args.shift();
let output, cwd, sandbox, model;
while (args.length && args[0] !== '-' && args[0].startsWith('-')) {
  const flag = args.shift();
  if (flag === '--json' || flag === '--skip-git-repo-check') continue;
  if (!['-o', '-C', '-s', '-c', '-m'].includes(flag)) die(`unexpected flag ${flag}`);
  const value = args.shift();
  if (!value) die(`missing value for ${flag}`);
  if (flag === '-o') output = value;
  if (flag === '-C') { if (resume) die('resume has no -C'); cwd = value; }
  if (flag === '-s') { if (resume) die('resume has no -s'); sandbox = value; }
  if (flag === '-c') sandbox = value;
  if (flag === '-m') model = value;
}
const id = resume ? args.shift() : crypto.randomUUID();
if (args.length !== 1 || args[0] !== '-') die('prompt must be stdin positional argument');
if (!output) die('missing -o');
if (sandbox !== (resume ? 'sandbox_mode="workspace-write"' : 'workspace-write')) die('incorrect sandbox');
if (!resume && path.resolve(cwd) !== process.cwd()) die('wrong cwd');
if (process.env.EXPECT_CODEX_MODEL && model !== process.env.EXPECT_CODEX_MODEL) die('wrong model');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', async () => {
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  emit({ type: 'thread.started', thread_id: id });
  // Like the real CLI, a new thread gets a rollout file under CODEX_HOME/sessions.
  if (!resume && process.env.CODEX_HOME) {
    const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '01', '01');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`), '');
  }
  if (prompt === '__active_writer__') { console.error('thread-store conflict: thread already has an active writer (code -32600)'); process.exitCode = 3; return; }
  const once = /^__active_writer_once__:(\w+)$/.exec(prompt);
  if (once && process.env.FAKE_CODEX_STATE) {
    const marker = path.join(process.env.FAKE_CODEX_STATE, `writer-${once[1]}`);
    if (!fs.existsSync(marker)) { fs.mkdirSync(process.env.FAKE_CODEX_STATE, { recursive: true }); fs.writeFileSync(marker, ''); console.error('thread already has an active writer (code -32600)'); process.exitCode = 3; return; }
  }
  if (prompt === '__active_writer_event__') { emit({ type: 'error', message: 'thread already has an active writer (code -32600)' }); return; }
  if (prompt === '__timeout__') { setInterval(() => {}, 1000); return; }
  if (prompt === '__exit__') { console.error('fake stderr failure'); process.exitCode = 3; return; }
  if (prompt === '__error__') { emit({ type: 'error', message: 'fake event failure' }); return; }
  if (prompt === '__turn_failed__') { emit({ type: 'turn.failed', error: { message: 'fake turn failure' } }); return; }
  const delay = /^delay:(\d+):/.exec(prompt);
  if (delay) await new Promise(resolve => setTimeout(resolve, Number(delay[1])));
  const dir = process.env.FAKE_CODEX_STATE;
  if (!dir) die('FAKE_CODEX_STATE is required');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  let history = [];
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  history.push(prompt);
  fs.writeFileSync(file, JSON.stringify(history));
  const reply = `echo:${prompt}|history:${history.length}`;
  emit({ type: 'unknown.event' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'earlier reply' } });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: prompt === '__output__' ? 'JSONL fallback' : reply } });
  if (prompt !== '__fallback__') fs.writeFileSync(output, reply);
});
