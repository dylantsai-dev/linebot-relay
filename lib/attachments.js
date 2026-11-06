'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const { TextDecoder } = require('node:util');
const MARKER = '[附件 · linebot-relay]';
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const safeName = name => Array.from(path.basename(String(name || 'attachment').replace(/\\/g, '/')).replace(/[^A-Za-z0-9._\-\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, '_').replace(/^\.+/, '')).slice(0, 100).join('') || 'attachment';
const sizeLabel = size => `${(size / 1024).toFixed(1)} KB`;
const NOTE = '（以上文件已保存在服务器上，可直接按绝对路径读取；图片同时作为图像输入附上。）';
function imageMime(bytes, mime = '') {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return /^image\/(png|jpeg|gif|webp)$/.test(mime) ? mime : null;
}
function dispositionValue(value, key) {
  const extended = value.match(new RegExp('(?:^|;)\\s*' + key + '\\*=([^;]*)', 'i'));
  if (extended) {
    const encoded = extended[1].trim().replace(/^"|"$/g, '');
    const match = encoded.match(/^UTF-8'[^']*'(.*)$/i);
    if (match) try { return decodeURIComponent(match[1]); } catch { throw error('Invalid UTF-8 filename'); }
  }
  const match = value.match(new RegExp('(?:^|;)\\s*' + key + '=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))', 'i'));
  return match ? (match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2].trim()) : undefined;
}
function parseMultipart(buffer, contentType, limits) {
  const boundary = dispositionValue(contentType, 'boundary');
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw error('Invalid multipart boundary');
  const delimiter = Buffer.from('--' + boundary), separator = Buffer.from('\r\n--' + boundary);
  if (!buffer.subarray(0, delimiter.length).equals(delimiter)) throw error('Invalid multipart body');
  const body = {}, files = [];
  let offset = delimiter.length;
  while (true) {
    if (buffer.subarray(offset, offset + 2).toString() === '--') break;
    if (buffer.subarray(offset, offset + 2).toString() !== '\r\n') throw error('Invalid multipart delimiter');
    offset += 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', offset);
    if (headerEnd < 0 || headerEnd - offset > 16384) throw error('Invalid multipart headers');
    const headers = Object.create(null);
    for (const line of buffer.subarray(offset, headerEnd).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 1) throw error('Invalid multipart header');
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    offset = headerEnd + 4;
    let end = offset;
    do {
      end = buffer.indexOf(separator, end);
      if (end < 0) throw error('Missing multipart closing boundary');
      const suffix = buffer.subarray(end + separator.length, end + separator.length + 2).toString();
      if (suffix === '--' || suffix === '\r\n') break;
      end++;
    } while (true);
    const data = buffer.subarray(offset, end), disposition = headers['content-disposition'] || '';
    const name = dispositionValue(disposition, 'name'), filename = dispositionValue(disposition, 'filename');
    if (filename !== undefined) {
      if (!['file', 'files'].includes(name)) throw error('File parts must be named file or files');
      if (files.length >= limits.maxFiles) throw error(`Too many files (maximum ${limits.maxFiles})`, 413);
      if (data.length > limits.maxBytes) throw error(`File exceeds ${limits.maxBytes} bytes`, 413);
      if (limits.maxTotal && files.reduce((sum, file) => sum + file.data.length, data.length) > limits.maxTotal) throw error(`Files exceed ${limits.maxTotal} bytes in total`, 413);
      files.push({ name: filename, data, mime: headers['content-type'] });
    } else if (['session', 'message', 'codex_session_id', 'callback_url', 'mode', 'async'].includes(name)) {
      body[name] = data.toString('utf8');
    }
    offset = end + separator.length;
  }
  return { body, files };
}
function readRequest(req, limits) {
  const multipart = /^multipart\/form-data(?:;|$)/i.test(req.headers['content-type'] || '');
  const payload = Math.min(limits.maxTotal || Infinity, limits.maxFiles * limits.maxBytes);
  const maxBody = Math.ceil(payload * (multipart ? 1.01 : 1.4)) + 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0, exceeded = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBody) {
        if (!exceeded) { exceeded = true; chunks.length = 0; reject(error(`Request body exceeds ${maxBody} bytes`, 413)); }
      } else if (!exceeded) chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) return;
      try {
        const buffer = Buffer.concat(chunks), type = req.headers['content-type'] || '';
        if (/^multipart\/form-data(?:;|$)/i.test(type)) return resolve(parseMultipart(buffer, type, limits));
        let body;
        try { body = JSON.parse(buffer.toString('utf8')); } catch { throw error('Invalid JSON'); }
        if (!body?.files?.length && !body?.file_urls?.length && size > 1024 * 1024) throw error('Body exceeds 1MB', 413);
        resolve({ body, files: [] });
      } catch (cause) { reject(cause); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(error('Request aborted')));
  });
}

const privateV4 = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['192.0.2.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) privateV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new net.BlockList();
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) specialV6.addSubnet(address, prefix, 'ipv6');
function publicAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? !privateV4.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
}
async function downloadFile(raw, maxBytes, deadline = Date.now() + 30000, redirects = 0) {
  let url;
  try { url = new URL(raw); } catch { throw error('Invalid file URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw error('File URLs must use HTTP/HTTPS without credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw error('File download timed out', 408);
  let timer;
  const addresses = await Promise.race([
    dns.lookup(hostname, { all: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(error('File DNS lookup timed out', 408)), remaining); }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw error('File URL resolves to a private or reserved address');
  // Pin the validated address so a second DNS resolution cannot rebind to an internal host.
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => request.destroy(error('File download timed out', 408)), Math.max(1, deadline - Date.now()));
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      agent: false,
      lookup: (_host, options, callback) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
    }, response => {
      response.on('error', reject);
      if ([301,302,303,307,308].includes(response.statusCode)) {
        response.destroy(); clearTimeout(timeout);
        if (redirects >= 3 || !response.headers.location) return reject(error('Too many or invalid file redirects'));
        let next;
        try { next = new URL(response.headers.location, url).href; } catch { return reject(error('Invalid file redirect')); }
        resolve(downloadFile(next, maxBytes, deadline, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) { response.destroy(); return reject(error(`File download HTTP ${response.statusCode}`)); }
      if (Number(response.headers['content-length']) > maxBytes) { response.destroy(error(`File exceeds ${maxBytes} bytes`, 413)); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(error(`File exceeds ${maxBytes} bytes`, 413));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          let fallback;
          try { fallback = decodeURIComponent(url.pathname.split('/').pop()); } catch { fallback = 'attachment'; }
          resolve({ name: dispositionValue(response.headers['content-disposition'] || '', 'filename') || fallback, mime: response.headers['content-type'], data: Buffer.concat(chunks) });
        } catch (cause) { reject(cause); }
      });
      response.on('aborted', () => reject(error('File download aborted')));
    });
    request.on('error', reject);
    request.on('close', () => clearTimeout(timeout));
  });
}
async function prepareAttachments(body, incoming, config, safeKey) {
  const files = [...incoming];
  if (body.files !== undefined && !Array.isArray(body.files)) throw error('files must be an array');
  if (body.file_urls !== undefined && !Array.isArray(body.file_urls)) throw error('file_urls must be an array');
  if (files.length + (body.files?.length || 0) + (body.file_urls?.length || 0) > config.maxFiles) throw error(`Too many files (maximum ${config.maxFiles})`, 413);
  for (const file of body.files || []) {
    if (!file || typeof file.name !== 'string' || typeof file.content_base64 !== 'string') throw error('Invalid base64 file');
    const encoded = file.content_base64;
    const decodedSize = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (decodedSize > config.maxBytes) throw error(`File exceeds ${config.maxBytes} bytes`, 413);
    if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw error('Invalid base64 file');
    const data = Buffer.from(file.content_base64, 'base64');
    if (data.length > config.maxBytes) throw error(`File exceeds ${config.maxBytes} bytes`, 413);
    files.push({ name: file.name, mime: file.mime, data });
  }
  for (const url of body.file_urls || []) {
    if (typeof url !== 'string') throw error('Invalid file URL');
    files.push(await downloadFile(url, config.maxBytes));
  }
  if (config.maxTotal && files.reduce((sum, file) => sum + file.data.length, 0) > config.maxTotal) throw error(`Files exceed ${config.maxTotal} bytes in total`, 413);
  const attachments = [];
  try {
    for (const file of files) {
      if (file.data.length > config.maxBytes) throw error(`File exceeds ${config.maxBytes} bytes`, 413);
      const name = safeName(file.name), mime = typeof file.mime === 'string' && /^[\w.+-]+\/[\w.+-]+(?:;[^\r\n]*)?$/.test(file.mime) ? file.mime.split(';')[0].toLowerCase() : 'application/octet-stream';
      const image = imageMime(file.data, mime);
      const dir = path.join(config.uploads, safeKey(body.session));
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      fs.chmodSync(config.uploads, 0o755);
      fs.chmodSync(dir, 0o755);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const target = path.join(dir, `${stamp}-${crypto.randomBytes(2).toString('hex')}-${name}`);
      fs.writeFileSync(target, file.data, { mode: 0o644, flag: 'wx' });
      fs.chmodSync(target, 0o644);
      const attachment = { name, path: target, mime: image || mime, size: file.data.length, kind: image ? 'image' : 'file' };
      attachments.push(attachment);
    }
    return { attachments, input: buildInput(body.message, attachments, files) };
  } catch (cause) { for (const file of attachments) try { fs.unlinkSync(file.path); } catch {} throw cause; }
}
function buildInput(message, attachments, files) {
  if (!attachments.length) return undefined;
  let text = message + '\n\n' + MARKER + '\n' + attachments.map(file => `- ${file.path} (${file.mime}, ${sizeLabel(file.size)})`).join('\n') + '\n' + NOTE;
  attachments.forEach((file, i) => {
    if (file.kind === 'image' || file.size > 65536 || !(/^(text\/|application\/(?:json|xml|yaml|x-yaml|javascript))/.test(file.mime) || /\.(txt|json|csv|md|xml|ya?ml|[cm]?[jt]sx?|py|rb|go|rs|java|[ch](pp)?|sh|sql|css|html|toml|ini)$/i.test(file.name))) return;
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(files[i].data);
      if (!content.includes('\0')) text += `\n\n--- ${file.name} ---\n${content}`;
    } catch { /* Binary data must not be inlined. */ }
  });
  return [{ type: 'text', text, text_elements: [] }, ...attachments.filter(file => file.kind === 'image').map(file => ({ type: 'localImage', path: file.path }))];
}
// Merge several queued messages into one turn input, in order: texts joined by a blank line, every
// attachment listed under a single marker block (so the thread still parses it), inlined file
// contents kept, and all images attached.
const PLACEHOLDER = '请查看附件。';
function combineInput(entries) {
  const attachments = entries.flatMap(entry => entry.attachments || []);
  const texts = entries.map(entry => entry.message);
  const real = texts.filter(text => text.trim() && text !== PLACEHOLDER);
  const message = real.length ? real.join('\n\n') : PLACEHOLDER;
  if (!attachments.length) return { message, attachments, input: undefined };
  let text = message + '\n\n' + MARKER + '\n' + attachments.map(file => `- ${file.path} (${file.mime}, ${sizeLabel(file.size)})`).join('\n') + '\n' + NOTE;
  for (const entry of entries) {
    const own = (entry.input || []).find(part => part.type === 'text')?.text || '';
    const at = own.indexOf(NOTE);
    if (at >= 0) text += own.slice(at + NOTE.length);
  }
  return { message, attachments, input: [{ type: 'text', text, text_elements: [] }, ...attachments.filter(file => file.kind === 'image').map(file => ({ type: 'localImage', path: file.path }))] };
}
function parseUserContent(item) {
  const fullText = (item.content || []).map(part => part.type === 'text' ? part.text || '' : /image/i.test(part.type) && !part.path && !part.url ? '[image]' : '').join('');
  const marker = fullText.indexOf(MARKER), text = marker < 0 ? fullText : fullText.slice(0, marker).trim();
  const attachments = [];
  if (marker >= 0) {
    for (const line of fullText.slice(marker + MARKER.length).split('\n')) {
      if (!line.trim()) continue;
      const match = line.match(/^- (\/.*) \(([^,\r\n]+), ([\d.]+) (B|KB|MB)\)$/);
      if (!match) break; // Do not interpret inline attachment content as metadata.
      const [, filePath, mime, size, unit] = match;
      attachments.push({ name: path.basename(filePath).replace(/^\d{8}-\d{6}-[a-f0-9]{4}-/, ''), path: filePath, mime, size: Math.round(Number(size) * ({ B: 1, KB: 1024, MB: 1048576 }[unit])), kind: /^image\/(png|jpeg|gif|webp)$/.test(mime) ? 'image' : 'file' });
    }
  }
  for (const part of item.content || []) {
    if (part.type === 'localImage' && typeof part.path === 'string') {
      const found = attachments.find(file => file.path === part.path);
      if (found) found.kind = 'image';
      else attachments.push({ name: path.basename(part.path), path: part.path, kind: 'image' });
    } else if (part.type === 'image' && typeof part.url === 'string' && !attachments.some(file => file.url === part.url)) attachments.push({ name: 'image', url: part.url, kind: 'image' });
  }
  return { text, fullText, attachments };
}
function serveFile(req, res, rawPath, uploadDir) {
  let real, root;
  try {
    if (!rawPath || !path.isAbsolute(rawPath)) throw error('Invalid file path', 403);
    root = fs.realpathSync(uploadDir); real = fs.realpathSync(rawPath);
  } catch (cause) { throw cause.status ? cause : error('File not found', 404); }
  const relative = path.relative(root, real);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw error('File outside UPLOAD_DIR', 403);
  // Open without following a final symlink; stream the validated file descriptor.
  let fd;
  try { fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { throw error('File not found', 404); }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) { fs.closeSync(fd); throw error('File not found', 404); }
  const prefix = Buffer.alloc(12); const count = fs.readSync(fd, prefix, 0, 12, 0);
  const mime = imageMime(prefix.subarray(0, count));
  res.writeHead(200, { 'Content-Type': mime || 'application/octet-stream', 'Content-Length': stat.size,
    'Content-Disposition': `${mime ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(real))}`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' });
  const stream = fs.createReadStream(real, { fd, autoClose: true, start: 0 });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
module.exports = { readRequest, parseMultipart, prepareAttachments, combineInput, parseUserContent, serveFile, publicAddress, downloadFile, safeName, imageMime, MARKER };
