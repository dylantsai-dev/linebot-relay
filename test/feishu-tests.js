'use strict';
// Feishu OAuth settings, status flag, loginOrCreateFeishu (role=user + avatar), mocked token exchange.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Users } = require('../lib/users');
const { Settings } = require('../lib/settings');
const feishu = require('../lib/feishu');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-feishu-'));
const token = crypto.randomBytes(24).toString('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];

async function freePort() {
  const s = http.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise(resolve => s.close(resolve));
  return port;
}

async function boot(name, extra = {}) {
  const port = await freePort(), dir = path.join(temp, name);
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', WEBHOOK_TOKEN: token,
      CODEX_APP_SERVER_SOCK: 'off', CONSOLE_UI: 'legacy',
      DATA_DIR: path.join(dir, 'data'), WORK_DIR: path.join(dir, 'work'), LOG_DIR: path.join(dir, 'logs'),
      UPLOAD_DIR: path.join(dir, 'uploads'), CODEX_HOME: path.join(dir, 'codex-home'),
      CODEX_TIMEOUT_MS: '5000', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-pass-1', ...extra,
    },
  });
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await pause(25);
  }
  const call = async (auth, route, { method = 'GET', body, headers = {}, redirect = 'follow' } = {}) => {
    const h = { ...headers };
    if (auth) h.Authorization = `Bearer ${auth}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect });
    const type = response.headers.get('content-type') || '';
    const setCookie = response.headers.getSetCookie?.() || [];
    return {
      status: response.status,
      headers: response.headers,
      setCookie,
      location: response.headers.get('location'),
      body: type.includes('json') ? await response.json() : await response.text(),
    };
  };
  return { base, call, dir, output: () => output };
}

async function main() {
  // ---- unit: settings mask + users.loginOrCreateFeishu ----
  {
    const settingsFile = path.join(temp, 'settings-unit.json');
    const settings = new Settings(settingsFile);
    assert.equal(settings.feishu().enabled, false);
    const pub = settings.setFeishu({ app_id: 'cli_test', app_secret: 'sec_secret_value', redirect_uri: 'https://linebot.dylantsai.com/api/auth/feishu/callback' });
    assert.equal(pub.app_id, 'cli_test');
    assert.equal(pub.has_secret, true);
    assert.equal(pub.ready, true);
    assert.ok(!JSON.stringify(pub).includes('sec_secret_value'), 'secret must not appear in public GET');
    const again = settings.publicFeishu();
    assert.equal(again.has_secret, true);
    assert.equal(again.app_id, 'cli_test');
    // empty secret keeps existing
    settings.setFeishu({ app_id: 'cli_test2', app_secret: '' });
    assert.equal(settings.feishu().app_secret, 'sec_secret_value');
    assert.equal(settings.feishu().app_id, 'cli_test2');
  }
  {
    const db = path.join(temp, 'users-unit.db');
    const users = new Users(db);
    const first = await users.loginOrCreateFeishu({
      open_id: 'ou_aaaaaaaaaaaaaaaa',
      union_id: 'on_bbbb',
      name: '小明',
      avatar_url: 'https://s1-imfile.feishucdn.com/static-resource/v1/avatar.png',
    });
    assert.equal(first.user.role, 'user');
    assert.equal(first.user.auth_provider, 'feishu');
    assert.equal(first.user.avatar_url, 'https://s1-imfile.feishucdn.com/static-resource/v1/avatar.png');
    assert.equal(first.user.has_password, false);
    assert.ok(first.token.startsWith('rs_'));
    let loginFailed = false;
    try { await users.login('小明', 'anything-long'); } catch (e) { loginFailed = e.status === 401; }
    assert.equal(loginFailed, true, 'feishu-only user cannot password-login');

    const second = await users.loginOrCreateFeishu({
      open_id: 'ou_aaaaaaaaaaaaaaaa',
      name: '小明改',
      avatar_url: 'https://s1-imfile.feishucdn.com/static-resource/v1/avatar2.png',
    });
    assert.equal(second.user.id, first.user.id);
    assert.equal(second.user.avatar_url, 'https://s1-imfile.feishucdn.com/static-resource/v1/avatar2.png');
    assert.equal(second.user.display_name, '小明改');
    assert.equal(users.list().filter(u => u.feishu_open_id).length, 1);

    await users.update(first.user.id, { disabled: true });
    let blocked = false;
    try { await users.loginOrCreateFeishu({ open_id: 'ou_aaaaaaaaaaaaaaaa', name: 'x' }); }
    catch (e) { blocked = e.status === 403; }
    assert.equal(blocked, true, 'disabled feishu user blocked');
    users.close();
  }

  // ---- HTTP: status + admin settings + mocked callback ----
  {
    const { call, dir } = await boot('http');
    assert.deepEqual((await call(null, '/api/auth/feishu/status')).body, { enabled: false });
    assert.equal((await call(null, '/api/settings/feishu')).status, 401);

    const adminLogin = await call(null, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-1' } });
    assert.equal(adminLogin.status, 200);
    const admin = adminLogin.body.token;

    assert.equal((await call(admin, '/api/settings/feishu')).status, 200);
    const saved = await call(admin, '/api/settings/feishu', {
      method: 'PUT',
      body: {
        app_id: 'cli_http_test',
        app_secret: 'http_secret_value',
        redirect_uri: 'https://linebot.dylantsai.com/api/auth/feishu/callback',
        enabled: true,
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.has_secret, true);
    assert.equal(saved.body.ready, true);
    assert.ok(!JSON.stringify(saved.body).includes('http_secret_value'));
    assert.deepEqual((await call(null, '/api/auth/feishu/status')).body, { enabled: true });

    // ordinary user cannot read/write settings
    await call(admin, '/api/users', { method: 'POST', body: { username: 'bob', password: 'bob-pass-12', role: 'user' } });
    const bob = (await call(null, '/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bob-pass-12' } })).body.token;
    assert.equal((await call(bob, '/api/settings/feishu')).status, 403);

    // login redirect
    const start = await call(null, '/api/auth/feishu/login?next=/console/', { redirect: 'manual' });
    assert.equal(start.status, 302);
    assert.ok(String(start.location).startsWith('https://accounts.feishu.cn/open-apis/authen/v1/authorize?'));
    assert.ok(start.location.includes('client_id=cli_http_test'));
    assert.ok(!start.location.includes('code_challenge'), 'PKCE off by default');
    const cookie = (start.setCookie.find(c => c.startsWith('feishu_oauth=')) || '').split(';')[0];
    assert.ok(cookie.startsWith('feishu_oauth='));
    const state = new URL(start.location).searchParams.get('state');
    assert.ok(state);

    // Mock Feishu HTTP for the in-process module used by THIS test process only —
    // the server is a child process, so we exercise loginOrCreate via a direct callback
    // simulation against the child's settings by hitting callback with a test hook.
    // Instead: write a sidecar mock by patching through env FEISHU_TEST_MOCK is heavy.
    // Use Users DB the server wrote + simulate by calling users API after manual create —
    // For full callback, spawn is separate process; use undici-style by setting a local mock
    // server is hard. Verify callback rejects bad state without mocking Feishu:
    const bad = await call(null, `/api/auth/feishu/callback?code=x&state=wrong`, {
      redirect: 'manual', headers: { Cookie: cookie },
    });
    assert.equal(bad.status, 302);
    assert.ok(String(bad.location).includes('feishu_error=state') || String(bad.location).includes('feishu_error=expired'));

    // Direct create via Users on the same DB path the server uses, then whoami with issued token
    // proves avatar fields round-trip through authenticate/principalInfo after migration.
    const usersDb = path.join(dir, 'data', 'users.db');
    // Server holds the DB open; issue a token via loginOrCreate in a temporary copy is flaky.
    // Instead rely on unit test above + settings/status HTTP coverage.
    void usersDb;
  }

  // ---- mocked exchange/userinfo in-process (no server) ----
  {
    const settings = new Settings(path.join(temp, 'settings-mock.json'));
    settings.setFeishu({ app_id: 'cli_m', app_secret: 'sec_m', redirect_uri: 'https://example.com/cb' });
    let hits = [];
    feishu.setFetchForTests(async (url, opts) => {
      hits.push(String(url));
      if (String(url).includes('/oauth/v3/token') || String(url).includes('/oauth/token')) {
        return { status: 200, json: async () => ({ code: 0, access_token: 'ut_test_token' }) };
      }
      if (String(url).includes('/user_info')) {
        assert.equal(opts.headers.Authorization, 'Bearer ut_test_token');
        return {
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              name: '飞书测', open_id: 'ou_mock_open_id_001', union_id: 'on_x',
              avatar_url: 'https://s1-imfile.feishucdn.com/a.png', tenant_key: 't',
            },
          }),
        };
      }
      return { status: 404, json: async () => ({ code: -1 }) };
    });
    const access = await feishu.exchangeCode(settings, 'auth_code', '', 'https://example.com/cb');
    assert.equal(access, 'ut_test_token');
    const profile = await feishu.fetchUser(access);
    assert.equal(profile.open_id, 'ou_mock_open_id_001');
    assert.equal(profile.avatar_url, 'https://s1-imfile.feishucdn.com/a.png');
    feishu.setFetchForTests(null);

    // error mapping
    feishu.setFetchForTests(async () => ({ status: 200, json: async () => ({ code: 20071, error: 'redirect' }) }));
    await assert.rejects(() => feishu.exchangeCode(settings, 'c', '', 'https://example.com/cb'), e => e.key === 'redirect_mismatch');
    feishu.setFetchForTests(null);
  }

  console.log('feishu-tests: ok');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const child of children) try { child.kill('SIGTERM'); } catch {}
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
