'use strict';
// Minimal zero-dependency WebSocket client over a unix domain socket (RFC 6455, text frames).
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class UnixWebSocket extends EventEmitter {
  constructor(socketPath, { path = '/', host = 'localhost', handshakeTimeoutMs = 10000 } = {}) {
    super();
    this.open = false;
    this._buf = Buffer.alloc(0);
    this._frags = [];
    const key = crypto.randomBytes(16).toString('base64');
    const expect = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const sock = net.connect({ path: socketPath });
    this.sock = sock;
    const timer = setTimeout(() => { this._fail(new Error('websocket handshake timeout')); }, handshakeTimeoutMs);
    sock.on('connect', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let handshaking = true;
    sock.on('data', (d) => {
      this._buf = Buffer.concat([this._buf, d]);
      if (handshaking) {
        const end = this._buf.indexOf('\r\n\r\n');
        if (end < 0) { if (this._buf.length > 65536) this._fail(new Error('handshake too large')); return; }
        const head = this._buf.slice(0, end).toString('latin1');
        this._buf = this._buf.slice(end + 4);
        const status = head.split('\r\n')[0];
        const accept = /\r\nsec-websocket-accept:\s*(\S+)/i.exec(head);
        if (!/^HTTP\/1\.1 101/.test(status) || !accept || accept[1] !== expect) { clearTimeout(timer); this._fail(new Error('websocket handshake failed: ' + status)); return; }
        handshaking = false; clearTimeout(timer); this.open = true; this.emit('open');
      }
      this._parse();
    });
    sock.on('error', (e) => { clearTimeout(timer); this._fail(e); });
    sock.on('close', () => { clearTimeout(timer); const was = this.open || handshaking; this.open = false; if (was) this.emit('close'); handshaking = false; });
  }
  _fail(err) { if (this._failed) return; this._failed = true; this.emit('error', err); try { this.sock.destroy(); } catch {} }
  _parse() {
    for (;;) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      let mask;
      if (masked) { if (b.length < off + 4) return; mask = b.slice(off, off + 4); off += 4; }
      if (b.length < off + len) return;
      let payload = b.slice(off, off + len);
      if (masked) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
      this._buf = b.slice(off + len);
      if (op === 0x8) { try { this._send(0x8, payload.slice(0, 2)); } catch {} this.sock.end(); return; }
      if (op === 0x9) { this._send(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this._frags.push(payload);
        if (fin) { const msg = Buffer.concat(this._frags).toString('utf8'); this._frags = []; this.emit('message', msg); }
      }
    }
  }
  _send(op, payload) {
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | op;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  send(text) { if (!this.open) throw new Error('websocket not open'); this._send(0x1, Buffer.from(text, 'utf8')); }
  close() { try { if (this.open) this._send(0x8, Buffer.from([0x03, 0xe8])); } catch {} try { this.sock.end(); } catch {} setTimeout(() => { try { this.sock.destroy(); } catch {} }, 1000).unref(); }
}
module.exports = { UnixWebSocket };
