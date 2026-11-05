'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendInstruction, resolveAgentsPath } = require('../lib/agents-md');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
try {
  const first = appendInstruction({ cwd: dir, text: '以后日常不主动提内部流程', meta: { when: '2026-11-05', user: 'dylan', session: 'test1' } });
  assert.equal(path.basename(first.path), 'AGENTS.md');
  assert.equal(first.appended, true);
  assert.equal(first.created, true);
  const body = fs.readFileSync(first.path, 'utf8');
  assert.match(body, /以后日常不主动提内部流程/);
  const again = appendInstruction({ cwd: dir, text: '以后日常不主动提内部流程' });
  assert.equal(again.duplicate, true);
  assert.equal(again.appended, false);
  fs.writeFileSync(path.join(dir, 'Agent.md'), '# Agent\n\nkeep\n');
  const prefer = resolveAgentsPath(dir, null);
  // Existing Agent.md is preferred over creating AGENTS.md when AGENTS.md already exists from first write —
  // AGENTS.md already exists so that wins over Agent.md in candidate order... AGENTS.md is checked before Agent.md.
  assert.equal(path.basename(prefer.path), 'AGENTS.md');
  console.log('agents-md.test.js ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
