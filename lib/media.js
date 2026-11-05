'use strict';

// Images that Codex produces or references (generated images, imageView items, markdown links to
// local files) are served through short-lived signed URLs, because <img> cannot send a bearer token.
// A URL is only minted for a real image file inside the session's allowed roots, and it is bound to
// the session key, the principal and an expiry.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif' };
// Linked files that may display inline as plain text or PDF (never as active content).
const VIEW_TYPES = { '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8' };
const MAX_BYTES = 40 * 1024 * 1024;
const WINDOW_MS = 6 * 60 * 60 * 1000;
const b64url = text => Buffer.from(text, 'utf8').toString('base64url');
const unb64url = text => Buffer.from(text, 'base64url').toString('utf8');

function imageType(file) { return IMAGE_TYPES[path.extname(file).toLowerCase()] || null; }
function inside(root, target) {
  const relative = path.relative(root, target);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
// Roots must be specific directories; "/" or a top-level directory such as /root or /tmp is too broad.
function specific(root) { return typeof root === 'string' && path.isAbsolute(root) && path.resolve(root).split(path.sep).filter(Boolean).length >= 2; }
function localPath(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || raw.includes('\0')) return null;
  let value = raw.trim();
  if (/^file:\/\//i.test(value)) {
    try { value = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  } else if (value.startsWith('/')) {
    try { value = decodeURIComponent(value); } catch { /* keep raw */ }
  } else return null;
  return path.isAbsolute(value) ? path.normalize(value) : null;
}

class Media {
  constructor(secret, { now = () => Date.now() } = {}) {
    this.key = crypto.createHmac('sha256', String(secret)).update('linebot-relay media v1').digest();
    this.now = now;
  }
  mac(file, key, uid, exp, kind = '') { return crypto.createHmac('sha256', this.key).update(`${file}\n${key}\n${uid}\n${exp}${kind ? `\n${kind}` : ''}`).digest('base64url').slice(0, 32); }
  // Resolve a referenced path to a real image file under one of the roots, or null.
  resolve(raw, roots) {
    const file = localPath(raw);
    if (!file || !imageType(file)) return null;
    let real;
    try { real = fs.realpathSync(file); } catch { return null; }
    if (!imageType(real)) return null;
    const ok = roots.filter(specific).some(root => { try { return inside(fs.realpathSync(root), real); } catch { return false; } });
    if (!ok) return null;
    try { const stat = fs.statSync(real); if (!stat.isFile() || stat.size > MAX_BYTES) return null; } catch { return null; }
    return real;
  }
  // URLs stay stable within a window so polling does not reload images; they live 6-12 hours.
  sign(real, key, uid) {
    const exp = (Math.floor(this.now() / WINDOW_MS) + 2) * WINDOW_MS;
    const query = new URLSearchParams({ p: b64url(real), k: key, u: String(uid), e: String(exp), s: this.mac(real, key, uid, exp) });
    return `/api/media/${encodeURIComponent(path.basename(real))}?${query}`;
  }
  url(raw, roots, key, uid) { const real = this.resolve(raw, roots); return real ? this.sign(real, key, uid) : null; }
  // Any uploaded file (not only images) under one specific root, signed as a download (t=f).
  fileUrl(raw, root, key, uid) {
    const file = localPath(raw);
    if (!file || !specific(root)) return null;
    let real;
    try { real = fs.realpathSync(file); if (!inside(fs.realpathSync(root), real)) return null; const stat = fs.statSync(real); if (!stat.isFile()) return null; } catch { return null; }
    const exp = (Math.floor(this.now() / WINDOW_MS) + 2) * WINDOW_MS;
    const query = new URLSearchParams({ p: b64url(real), k: key, u: String(uid), e: String(exp), t: 'f', s: this.mac(real, key, uid, exp, 'f') });
    return `/api/media/${encodeURIComponent(path.basename(real))}?${query}`;
  }
  // A non-image file Codex linked to ([report](/abs/out.html)) inside the session's roots, signed as a download (t=f).
  linkUrl(raw, roots, key, uid) {
    const file = localPath(raw);
    if (!file) return null;
    let real;
    try { real = fs.realpathSync(file); const stat = fs.statSync(real); if (!stat.isFile()) return null; } catch { return null; }
    const ok = roots.filter(specific).some(root => { try { return inside(fs.realpathSync(root), real); } catch { return false; } });
    if (!ok) return null;
    const exp = (Math.floor(this.now() / WINDOW_MS) + 2) * WINDOW_MS;
    const query = new URLSearchParams({ p: b64url(real), k: key, u: String(uid), e: String(exp), t: 'f', s: this.mac(real, key, uid, exp, 'f') });
    return `/api/media/${encodeURIComponent(path.basename(real))}?${query}`;
  }
  verify(params) {
    const [p, key, u, e, s] = ['p', 'k', 'u', 'e', 's'].map(name => params.get(name));
    if (!p || !key || !u || !e || !s || !/^\d{1,12}$/.test(u) || !/^\d{1,16}$/.test(e)) return null;
    if (Number(e) < this.now()) return null;
    let file;
    try { file = unb64url(p); } catch { return null; }
    const kind = params.get('t') === 'f' ? 'f' : '';
    const expected = Buffer.from(this.mac(file, key, Number(u), Number(e), kind));
    const given = Buffer.from(s);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return { file, key, uid: Number(u), download: kind === 'f' };
  }
  serve(req, res, file, download = false) {
    let fd, real;
    const fail = () => { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Image not found' })); };
    try { real = fs.realpathSync(file); } catch { fail(); return; }
    // The signed path is already canonical; a symlink swapped in later is refused.
    if (real !== file || (!download && !imageType(real))) { fail(); return; }
    try { fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { fail(); return; }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (!download && stat.size > MAX_BYTES)) { fs.closeSync(fd); fail(); return; }
    // Raster images, PDFs and plain text display inline. HTML opens inline only inside a CSP sandbox (an opaque
    // origin: it cannot read this site's storage or cookies). Everything else downloads.
    const raster = /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(imageType(real) || '');
    const ext = path.extname(real).toLowerCase();
    const html = download && (ext === '.html' || ext === '.htm');
    const viewType = download && !raster ? (html ? 'text/html; charset=utf-8' : VIEW_TYPES[ext] || null) : null;
    const type = download ? (raster ? imageType(real) : viewType || 'application/octet-stream') : imageType(real);
    const name = download ? path.basename(real).replace(/^\d{8}-\d{6}-[a-f0-9]{4}-/, '') : path.basename(real);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${download && !raster && !viewType ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      ...(type === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
      ...(html ? { 'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-modals allow-downloads', 'Referrer-Policy': 'no-referrer' } : {}) });
    if (req.method === 'HEAD') { fs.closeSync(fd); res.end(); return; }
    const stream = fs.createReadStream(real, { fd, autoClose: true, start: 0 });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

// Markdown image/link targets that point at local files: ![alt](/abs/x.png), [x](file:///abs/x.png), <...> forms too.
const MD_LINK = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(\s+"[^"\n]*")?\s*\)/g;
function rewriteMarkdown(text, toUrl, toLink = null) {
  if (typeof text !== 'string' || !text.includes('](')) return { text, used: [] };
  const used = [];
  const out = text.replace(MD_LINK, (whole, bang, alt, target, title = '') => {
    const raw = target.startsWith('<') ? target.slice(1, -1) : target;
    const file = localPath(raw);
    if (!file) return whole;
    const url = toUrl(file) || (!bang && toLink ? toLink(file) : null);
    if (!url) return whole;
    used.push(file);
    return `${bang}[${alt}](${url}${title})`;
  });
  return { text: out, used };
}

// Image references carried by thread items (not by the message text).
function itemImages(item) {
  const out = [];
  if (!item || typeof item !== 'object') return out;
  if (item.type === 'imageGeneration' && item.status !== 'failed' && typeof item.savedPath === 'string') out.push({ path: item.savedPath, name: path.basename(item.savedPath), source: 'generated', prompt: typeof item.revisedPrompt === 'string' ? item.revisedPrompt.slice(0, 300) : undefined });
  if (item.type === 'imageView' && typeof item.path === 'string') out.push({ path: item.path, name: path.basename(item.path), source: 'view' });
  const inline = (data, mime) => typeof data === 'string' && data.length < 2 * 1024 * 1024 && /^image\/(png|jpeg|gif|webp)$/.test(mime || '') ? { url: `data:${mime};base64,${data}`, name: 'image', source: 'tool' } : null;
  if (item.type === 'mcpToolCall') for (const part of item.result?.content || []) { if (part?.type === 'image') { const image = inline(part.data, part.mimeType); if (image) out.push(image); } }
  if (item.type === 'dynamicToolCall') for (const part of item.contentItems || []) {
    if (part?.type === 'inputImage' && typeof part.imageUrl === 'string') {
      if (/^data:image\/(png|jpeg|gif|webp);base64,/.test(part.imageUrl) && part.imageUrl.length < 2 * 1024 * 1024) out.push({ url: part.imageUrl, name: 'image', source: 'tool' });
      else if (localPath(part.imageUrl)) out.push({ path: localPath(part.imageUrl), name: path.basename(localPath(part.imageUrl)), source: 'tool' });
    }
  }
  return out;
}

module.exports = { Media, rewriteMarkdown, itemImages, imageType, localPath, specific };
