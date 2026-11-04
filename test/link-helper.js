'use strict';
// The relay never creates Codex threads, so tests "pre-create" one the way Codex would
// (a rollout file under CODEX_HOME) and have the admin link it before the first message.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function newThread(codexHome) {
  const id = crypto.randomUUID();
  const dir = path.join(codexHome, 'sessions', '2026', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`), '');
  return id;
}
module.exports = { newThread };
