'use strict';
// Serving the Vue build (web/dist) at /console with SPA fallback, and the legacy fallback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-console-'));
const dist = path.join(temp, 'dist');
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Codex Relay</title><div id="app"></div><script type="module" src="/console/assets/app-abc.js"></script>');
fs.writeFileSync(path.join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
fs.writeFileSync(path.join(dist, 'assets', 'font.woff2'), 'x');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const s = http.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise(resolve => s.close(resolve));
  return port;
}
async function boot(extra) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', WEBHOOK_TOKEN: 'console-secret', CODEX_APP_SERVER_SOCK: 'off', DATA_DIR: path.join(temp, 'data'), WORK_DIR: path.join(temp, 'work'), LOG_DIR: path.join(temp, 'logs'), UPLOAD_DIR: path.join(temp, 'uploads'), ...extra } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base}/health`)).ok) return { child, base }; } catch {} await pause(25); }
  child.kill(); throw new Error('server did not start');
}
async function main() {
  let server = await boot({ CONSOLE_DIST: dist });
  try {
    const get = route => fetch(server.base + route);
    for (const route of ['/console', '/console/', '/console/sessions/a', '/console/logs']) {
      const r = await get(route);
      assert.equal(r.status, 200, route);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
      assert.ok((await r.text()).includes('<div id="app">'), route);
    }
    const js = await get('/console/assets/app-abc.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /^text\/javascript/);
    assert.match(js.headers.get('cache-control'), /immutable/);
    assert.equal(await js.text(), 'console.log(1)');
    assert.equal((await get('/console/assets/font.woff2')).headers.get('content-type'), 'font/woff2');
    assert.equal((await get('/console/assets/missing.js')).status, 404);
    assert.equal((await get('/console/assets/..%2F..%2F..%2Fserver.js')).status, 404);
    assert.equal((await get('/console/%2e%2e/%2e%2e/server.js')).status, 404);
    const legacy = await get('/console/legacy');
    assert.equal(legacy.status, 200);
    assert.ok((await legacy.text()).includes('id="login-form"'));
  } finally { server.child.kill(); }
  // Without a build (or with CONSOLE_UI=legacy) /console falls back to console.html.
  for (const extra of [{ CONSOLE_DIST: path.join(temp, 'nope') }, { CONSOLE_DIST: dist, CONSOLE_UI: 'legacy' }]) {
    server = await boot(extra);
    try {
      const r = await fetch(`${server.base}/console`);
      assert.equal(r.status, 200);
      assert.ok((await r.text()).includes('id="login-form"'));
      assert.equal((await fetch(`${server.base}/console/assets/app-abc.js`)).status, 404);
    } finally { server.child.kill(); }
  }
  console.log('Console dist serving tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
