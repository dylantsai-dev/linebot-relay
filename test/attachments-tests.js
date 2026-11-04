'use strict';
// Socket-free tests for downloads, DNS pinning, redirects and parser edge cases.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { parseMultipart, safeName, publicAddress } = require('../lib/attachments');

async function main() {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2002:7f00:1::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  assert.equal(safeName('../../.筆記 a.txt'), '筆記_a.txt');
  assert.equal(safeName('..\\.hidden.txt'), 'hidden.txt');
  assert.equal(safeName('.'.repeat(30)), 'attachment');
  assert.equal(Array.from(safeName('字'.repeat(110))).length, 100);
  // A boundary-like byte sequence inside a binary file must not truncate it.
  const binary = Buffer.from('abc\r\n--quoted-boundary-not-a-delimiter\0xyz');
  const multipart = Buffer.concat([
    Buffer.from('--quoted-boundary\r\nContent-Disposition: form-data; name="file"; filename="quoted\\\" name.txt"\r\nContent-Type: text/plain\r\n\r\n'), binary,
    Buffer.from('\r\n--quoted-boundary--\r\n'),
  ]);
  const parsed = parseMultipart(multipart, 'multipart/form-data; boundary="quoted-boundary"', {maxFiles:5,maxBytes:1000});
  assert.equal(parsed.files[0].name, 'quoted" name.txt');
  assert.deepEqual(parsed.files[0].data, binary);
  assert.throws(() => parseMultipart(multipart.subarray(0, multipart.length - 30), 'multipart/form-data; boundary="quoted-boundary"', {maxFiles:5,maxBytes:1000}), /boundary/);

  let addresses = [{address:'8.8.8.8',family:4}], plans = [], requests = [], seenHosts = [];
  const network = {
    get(url, options, onResponse) {
      const request = new EventEmitter(); requests.push({url,options});
      request.destroy = cause => { request.emit('error',cause); request.emit('close'); };
      queueMicrotask(() => {
        const plan = plans.shift();
        assert.ok(plan, 'unexpected outgoing request');
        const response = Readable.from(plan.chunks || [Buffer.from('downloaded text')]);
        response.statusCode = plan.status || 200; response.headers = plan.headers || {};
        response.on('close', () => request.emit('close'));
        onResponse(response);
      });
      return request;
    },
  };
  const context = vm.createContext({
    Buffer, URL, setTimeout, clearTimeout, module:{exports:{}},
    require: name => name === 'node:dns' ? {promises:{lookup:async host=>{seenHosts.push(host);return addresses;}}} : ['node:http','node:https'].includes(name) ? network : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../lib/attachments.js'),'utf8'), context);
  const { downloadFile } = context.module.exports;
  plans = [{headers:{'content-type':'text/plain; charset=utf-8','content-disposition':"attachment; filename*=UTF-8''%E7%AD%86%E8%A8%98.txt"}}];
  const downloaded = await downloadFile('https://public.example/old.txt',1024);
  assert.equal(downloaded.name,'筆記.txt'); assert.equal(downloaded.data.toString(),'downloaded text');
  assert.equal(requests[0].options.agent,false);
  const pinned = await new Promise((resolve,reject)=>requests[0].options.lookup('public.example',{},(cause,address,family)=>cause?reject(cause):resolve({address,family})));
  assert.deepEqual(pinned,{address:'8.8.8.8',family:4});
  addresses = [{address:'8.8.8.8',family:4},{address:'10.1.1.1',family:4}];
  await assert.rejects(downloadFile('https://mixed.example/file',1024), /private/);
  assert.equal(requests.length,1,'reject if any DNS result is private');
  addresses = [{address:'8.8.8.8',family:4}];
  plans = [{status:302,headers:{location:'http://private.example/file'}}];
  // Change the DNS result after the first hop to verify each redirect is rechecked.
  const originalGet = network.get;
  network.get = (...args) => { const request=originalGet(...args); addresses=[{address:'127.0.0.1',family:4}];return request; };
  await assert.rejects(downloadFile('https://public.example/start',1024), /private/);
  assert.ok(seenHosts.includes('private.example'));
  network.get = originalGet; addresses = [{address:'8.8.8.8',family:4}];
  plans = Array.from({length:4},()=>({status:302,headers:{location:'/next'}}));
  await assert.rejects(downloadFile('https://public.example/start',1024), /redirects/);
  plans = [{headers:{'content-length':'1025'}}];
  await assert.rejects(downloadFile('https://public.example/large',1024), cause=>cause.status===413);
  plans = [{chunks:[Buffer.alloc(600),Buffer.alloc(600)]}];
  await assert.rejects(downloadFile('https://public.example/chunked',1024), cause=>cause.status===413);
  plans = [{status:404}];
  await assert.rejects(downloadFile('https://public.example/missing',1024), /HTTP 404/);
  await assert.rejects(downloadFile('https://public.example/late',1024,Date.now()-1), /timed out/);
  await assert.rejects(downloadFile('ftp://public.example/file',1024), /HTTP\/HTTPS/);

  // A hanging connection must be destroyed when the shared deadline expires.
  network.get = () => {const request=new EventEmitter();request.destroy=cause=>{request.emit('error',cause);request.emit('close');};return request;};
  await assert.rejects(downloadFile('https://public.example/hanging',1024,Date.now()+15), /timed out/);
  network.get = originalGet;
  const html = fs.readFileSync(path.join(__dirname,'../console.html'),'utf8');
  const script = html.slice(html.lastIndexOf('<script>')+8, html.lastIndexOf('</script>'));
  new vm.Script(script);
  // Exercise the actual curl helpers, including hostile token quoting.
  const helpers = script.slice(script.indexOf('const shellQuote='),script.indexOf('function openWebhookMenu'));
  const browser = vm.createContext({location:{origin:'https://relay.example'},token:"secret'with $shell `chars`",document:{}});
  vm.runInContext(helpers,browser);
  const normal = vm.runInContext("webhookCurl('line:key')",browser);
  assert.ok(normal.includes('"Authorization: Bearer $TOKEN"'));
  assert.ok(!normal.includes('secret'));
  assert.ok(normal.includes('{"session":"line:key","message":"你好"}'));
  const real = vm.runInContext("webhookCurl('line:key','json',true)",browser);
  assert.ok(real.includes("'Authorization: Bearer secret'\\''with $shell `chars`'"));
  assert.ok(vm.runInContext("webhookCurl('line:key','file')",browser).includes("-F 'session=line:key'"));
  console.log('Attachment parser, download security and console helper tests passed');
}
main().catch(cause => {console.error(cause);process.exitCode=1;});
