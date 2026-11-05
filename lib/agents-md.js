'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Filenames Codex (and common fallbacks) accept for project guidance. Prefer override, then AGENTS.md. */
const CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'Agent.md', 'agents.md'];

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function pickExisting(dir) {
  for (const name of CANDIDATES) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Resolve where to write for this thread's cwd.
 * Prefer an existing agents file in cwd; otherwise create AGENTS.md there.
 * Falls back to CODEX_HOME/AGENTS.md when cwd is missing or not writable.
 */
function resolveAgentsPath(cwd, codexHome) {
  const home = typeof codexHome === 'string' && codexHome ? path.resolve(codexHome) : null;
  const roots = [];
  if (typeof cwd === 'string' && cwd.trim()) roots.push(path.resolve(cwd.trim()));
  if (home) roots.push(home);

  for (const root of roots) {
    if (!isDir(root)) continue;
    const existing = pickExisting(root);
    if (existing) return { path: existing, created: false, cwd: root };
  }
  for (const root of roots) {
    if (!isDir(root)) continue;
    return { path: path.join(root, 'AGENTS.md'), created: true, cwd: root };
  }
  throw Object.assign(new Error('当前会话没有可用的工作目录，无法写入 Agent.md'), { status: 409 });
}

function normalizeInstruction(text) {
  const value = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!value) throw Object.assign(new Error('所选文本为空'), { status: 400 });
  if (value.length > 8000) throw Object.assign(new Error('所选文本过长（最多 8000 字）'), { status: 400 });
  return value;
}

function alreadyHas(content, instruction) {
  const needle = instruction.replace(/\s+/g, ' ').trim();
  if (!needle) return false;
  const hay = content.replace(/\s+/g, ' ');
  return hay.includes(needle);
}

function formatBlock(instruction, meta = {}) {
  const lines = [];
  lines.push('');
  lines.push('## 控制台批注');
  if (meta.when) lines.push(`- 时间：${meta.when}`);
  if (meta.user) lines.push(`- 添加人：${meta.user}`);
  if (meta.session) lines.push(`- 会话：${meta.session}`);
  lines.push('');
  lines.push(instruction);
  lines.push('');
  return lines.join('\n');
}

/**
 * Append a selected instruction to the session's AGENTS.md (or Agent.md).
 * Idempotent for exact duplicates (whitespace-normalized).
 */
function appendInstruction({ cwd, codexHome, text, comment, meta }) {
  const instruction = normalizeInstruction(comment ? `${normalizeInstruction(text)}\n\n（备注：${normalizeInstruction(comment)}）` : text);
  const target = resolveAgentsPath(cwd, codexHome);
  let previous = '';
  try { previous = fs.readFileSync(target.path, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (alreadyHas(previous, instruction)) {
    return { path: target.path, created: false, appended: false, bytes: Buffer.byteLength(previous), duplicate: true };
  }
  const block = previous.trim() ? formatBlock(instruction, meta) : `# AGENTS.md\n\n项目 / 会话给助手的持久说明。\n${formatBlock(instruction, meta)}`;
  const next = previous && !previous.endsWith('\n') ? `${previous}\n${block}` : `${previous}${block}`;
  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  const temporary = `${target.path}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, next, { mode: 0o600 });
  fs.renameSync(temporary, target.path);
  return {
    path: target.path,
    created: target.created && !previous,
    appended: true,
    duplicate: false,
    bytes: Buffer.byteLength(next),
    cwd: target.cwd,
  };
}

module.exports = { appendInstruction, resolveAgentsPath, CANDIDATES };
