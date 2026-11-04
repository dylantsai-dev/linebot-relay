'use strict';
// Unit tests: media signing/path restriction, markdown rewriting, image extraction, live turn buffering.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Media, rewriteMarkdown, itemImages } = require('../lib/media');
const { AppServer, summarizeItem } = require('../lib/appserver');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-media-'));
(async () => {
try {
  const root = path.join(temp, 'work', 'k');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'a.png'), 'png');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'txt');
  fs.writeFileSync(path.join(temp, 'outside.png'), 'png');
  fs.symlinkSync(path.join(temp, 'outside.png'), path.join(root, 'escape.png'));
  const media = new Media('secret-one');
  const url = media.url(path.join(root, 'sub', 'a.png'), [root], 'k', 7);
  assert.match(url, /^\/api\/media\/a\.png\?p=[\w-]+&k=k&u=7&e=\d+&s=[\w-]{32}$/);
  const verified = media.verify(new URL('http://x' + url).searchParams);
  assert.deepEqual({ ...verified, file: path.basename(verified.file) }, { file: 'a.png', key: 'k', uid: 7, download: false });
  assert.equal(new Media('secret-two').verify(new URL('http://x' + url).searchParams), null, 'other secret');
  assert.equal(media.url(path.join(root, 'notes.txt'), [root], 'k', 7), null, 'not an image');
  assert.equal(media.url(path.join(root, 'escape.png'), [root], 'k', 7), null, 'symlink escape');
  assert.equal(media.url(path.join(root, '..', '..', 'outside.png'), [root], 'k', 7), null, 'traversal');
  assert.equal(media.url(path.join(root, 'sub', 'a.png'), ['/'], 'k', 7), null, 'shallow roots are ignored');
  assert.equal(media.url('relative/a.png', [root], 'k', 7), null);
  const expired = new URL('http://x' + url).searchParams; expired.set('e', String(Date.now() - 1000));
  assert.equal(media.verify(expired), null, 'expired');

  // Download URLs for any uploaded file type (t=f), bound to their kind and root.
  const fileUrl = media.fileUrl(path.join(root, 'notes.txt'), root, 'k', 7);
  assert.match(fileUrl, /^\/api\/media\/notes\.txt\?p=[\w-]+&k=k&u=7&e=\d+&t=f&s=[\w-]{32}$/);
  assert.equal(media.verify(new URL('http://x' + fileUrl).searchParams).download, true);
  const forged = new URL('http://x' + fileUrl).searchParams; forged.delete('t');
  assert.equal(media.verify(forged), null, 'a download signature is not an image signature');
  assert.equal(media.fileUrl(path.join(root, 'escape.png'), root, 'k', 7), null, 'symlink escape');
  assert.equal(media.fileUrl(path.join(root, '..', '..', 'outside.png'), root, 'k', 7), null, 'traversal');
  assert.equal(media.fileUrl(path.join(root, 'sub'), root, 'k', 7), null, 'directories');
  assert.equal(media.fileUrl(path.join(root, 'notes.txt'), '/', 'k', 7), null, 'shallow root');
  {
    const headers = {}; let body = '';
    const res = new (require('node:stream').Writable)({ write(chunk, _e, cb) { body += chunk; cb(); } });
    res.writeHead = (status, h) => { headers.status = status; Object.assign(headers, h); };
    await new Promise(resolve => { res.on('finish', resolve); media.serve({ method: 'GET' }, res, fs.realpathSync(path.join(root, 'notes.txt')), true); });
    assert.equal(headers.status, 200);
    assert.equal(headers['Content-Type'], 'application/octet-stream');
    assert.match(headers['Content-Disposition'], /^attachment;/);
    assert.equal(body, 'txt');
  }

  const toUrl = raw => raw.startsWith(root) ? `/api/media/x?p=${encodeURIComponent(raw)}` : null;
  const md = rewriteMarkdown(`看图 ![猫](${root}/sub/a.png) 和 [文件](file://${root}/sub/a.png) 以及 ![外](/etc/x.png) [网](https://e.com/a.png)`, toUrl);
  assert.match(md.text, /!\[猫\]\(\/api\/media\/x\?p=/);
  assert.match(md.text, /\[文件\]\(\/api\/media\/x\?p=/);
  assert.match(md.text, /!\[外\]\(\/etc\/x\.png\)/);
  assert.match(md.text, /\[网\]\(https:\/\/e\.com\/a\.png\)/);
  assert.ok(md.used.includes(path.join(root, 'sub', 'a.png')));

  assert.deepEqual(itemImages({ type: 'imageGeneration', savedPath: '/x/cat.png', result: 'AAAA', revisedPrompt: 'cat' }).map(i => i.path), ['/x/cat.png']);
  assert.deepEqual(itemImages({ type: 'imageView', path: '/x/v.jpg' }).map(i => i.path), ['/x/v.jpg']);
  assert.equal(itemImages({ type: 'mcpToolCall', result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] } })[0].url, 'data:image/png;base64,AAAA');
  assert.deepEqual(itemImages({ type: 'agentMessage', text: 'hi' }), []);

  assert.equal(summarizeItem({ type: 'commandExecution', id: 'c', command: "/bin/bash -lc 'npm test'", status: 'completed', exitCode: 0, aggregatedOutput: 'ok' }).title, 'npm test');
  assert.equal(summarizeItem({ type: 'userMessage', id: 'u', content: [] }), null);
  assert.equal(summarizeItem({ type: 'imageGeneration', id: 'i', savedPath: '/x/c.png', result: 'AAAA' }).path, '/x/c.png');
  assert.equal(JSON.stringify(summarizeItem({ type: 'imageGeneration', id: 'i', savedPath: '/x/c.png', result: 'AAAA' })).includes('AAAA'), false);

  // Live buffer: started → deltas → completed, events in order, cleared on completion.
  const client = new AppServer('/nonexistent.sock', { log() {} });
  const events = [];
  const off = client.onLive((thread, event) => events.push([thread, event.type, event.delta || event.status || event.item?.kind]));
  client.trackLive('turn/started', { threadId: 't', turn: { id: 'turn1' } });
  client.trackLive('item/started', { threadId: 't', turnId: 'turn1', item: { type: 'agentMessage', id: 'm', text: '' } });
  client.trackLive('item/agentMessage/delta', { threadId: 't', turnId: 'turn1', itemId: 'm', delta: 'He' });
  client.trackLive('item/agentMessage/delta', { threadId: 't', turnId: 'turn1', itemId: 'm', delta: 'llo' });
  assert.equal(client.threadState('t').live.items[0].text, 'Hello');
  client.trackLive('turn/completed', { threadId: 't', turn: { id: 'turn1', status: 'completed' } });
  assert.equal(client.threadState('t').live, null);
  assert.deepEqual(events.map(e => e.slice(1)), [['turn', 'started'], ['item', 'text'], ['delta', 'He'], ['delta', 'llo'], ['turn', 'completed']]);
  off();
  assert.equal(client.liveListeners.size, 0);
  console.log('Media signing and live buffer tests passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
})().catch(error => { console.error(error); process.exitCode = 1; });
