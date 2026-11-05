'use strict';

// Feishu (Lark) OAuth for the console. Mirrors ss172: authorize → token (v3 form, v2 JSON fallback) → user_info.
// PKCE off by default (Feishu QR/SSO drops code_challenge). Never log codes, tokens or secrets.
const crypto = require('node:crypto');
const { URLSearchParams } = require('node:url');

const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const TOKEN_URL_V3 = 'https://accounts.feishu.cn/oauth/v3/token';
const TOKEN_URL_V2 = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const TIMEOUT_MS = 8000;
const STATE_TTL = 600;

const FEISHU_ERRORS = {
  no_permission: '你的飞书账号不在本应用的可用范围内，请联系管理员添加',
  wrong_tenant: '非本企业飞书账号，无法登录',
  denied: '该飞书账号已被禁止登录',
  expired: '授权已过期，请重新登录',
  state: '登录请求无效或已过期，请重新点击「使用飞书登录」',
  cancelled: '你取消了飞书授权',
  tenant_unset: '企业校验尚未完成，请先由应用管理员登录一次',
  disabled: '飞书登录尚未配置',
  network: '连接飞书超时，请稍后重试',
  pkce: '飞书授权校验失败（PKCE），请重新点击「使用飞书登录」',
  redirect_mismatch: '回调地址与飞书应用配置不一致，请联系管理员',
  app_secret: '飞书应用凭证无效，请联系管理员',
  not_installed: '飞书应用未启用或未安装到本企业',
  user_invalid: '该飞书账号状态异常（已停用或不存在）',
  userinfo_failed: '已授权，但读取飞书用户信息失败，请重试',
  token_failed: '飞书授权换取失败，请重试',
  account_disabled: '账号已停用，请联系管理员',
};
const FEISHU_ERROR_DEFAULT = '飞书登录失败，请稍后重试';

class FeishuLoginError extends Error {
  constructor(key, detail = '') {
    super(key);
    this.key = key;
    this.detail = detail;
  }
}

/** Test seam: replace with a stub fetch. */
let _fetch = globalThis.fetch.bind(globalThis);
function setFetchForTests(fn) { _fetch = fn || globalThis.fetch.bind(globalThis); }

function mask(openId) {
  const s = openId || '';
  return s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-4)}` : '***';
}

function credentials(settings) {
  return settings.feishu();
}

function enabled(settings) {
  return credentials(settings).enabled;
}

function buildAuthorize(settings, redirectUri, nextUrl = '/console/') {
  const { app_id } = credentials(settings);
  if (!app_id) throw new FeishuLoginError('disabled');
  const state = crypto.randomBytes(24).toString('base64url');
  const params = new URLSearchParams({
    client_id: app_id,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  let verifier = '';
  if (process.env.FEISHU_PKCE === '1') {
    verifier = crypto.randomBytes(48).toString('base64url').slice(0, 96);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    params.set('code_challenge', challenge);
    params.set('code_challenge_method', 'S256');
  }
  return {
    url: `${AUTHORIZE_URL}?${params}`,
    pending: { state, verifier, next: nextUrl, redirect_uri: redirectUri, ts: Math.floor(Date.now() / 1000) },
  };
}

async function readJson(response) {
  try {
    const data = await response.json();
    return data && typeof data === 'object' ? data : { code: -1 };
  } catch {
    return { code: -1, http_status: response.status };
  }
}

async function exchangeCode(settings, code, verifier, redirectUri) {
  const { app_id, app_secret } = credentials(settings);
  if (!app_id || !app_secret) throw new FeishuLoginError('disabled');
  const body = {
    grant_type: 'authorization_code',
    client_id: app_id,
    client_secret: app_secret,
    code,
    redirect_uri: redirectUri,
  };
  if (verifier) body.code_verifier = verifier;
  let data;
  try {
    const form = new URLSearchParams(body);
    const res = await _fetch(TOKEN_URL_V3, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    data = await readJson(res);
    if (data.code === -1) {
      const res2 = await _fetch(TOKEN_URL_V2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      data = await readJson(res2);
    }
  } catch (error) {
    throw new FeishuLoginError('network', error.name || 'Error');
  }
  const token = data.access_token;
  if (data.code === 0 && token) return token;
  const codeNo = data.code;
  if (codeNo === 20010) throw new FeishuLoginError('no_permission', '20010');
  if ([20003, 20004, 20065].includes(codeNo)) throw new FeishuLoginError('expired', String(codeNo));
  const key = ({
    20049: 'pkce',
    20071: 'redirect_mismatch',
    20002: 'app_secret',
    20024: 'app_secret',
    20009: 'not_installed',
    20069: 'not_installed',
    20048: 'not_installed',
    20008: 'user_invalid',
    20066: 'user_invalid',
  })[codeNo] || 'token_failed';
  throw new FeishuLoginError(key, `${codeNo} ${data.error || ''}`.trim());
}

async function fetchUser(userToken) {
  let data;
  try {
    const res = await _fetch(USER_INFO_URL, {
      headers: { Authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    data = await readJson(res);
  } catch (error) {
    throw new FeishuLoginError('network', error.name || 'Error');
  }
  const info = data.data || {};
  if (data.code !== 0 || !info.open_id) throw new FeishuLoginError('userinfo_failed', String(data.code));
  const out = {};
  for (const key of ['name', 'en_name', 'open_id', 'union_id', 'tenant_key', 'avatar_url']) out[key] = info[key] || '';
  return out;
}

module.exports = {
  AUTHORIZE_URL, STATE_TTL, FEISHU_ERRORS, FEISHU_ERROR_DEFAULT,
  FeishuLoginError, enabled, buildAuthorize, exchangeCode, fetchUser, mask, setFetchForTests,
};
