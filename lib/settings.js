'use strict';

// Persisted console settings (Feishu OAuth credentials, …). File mode 0600; secrets never logged.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  feishu: { app_id: '', app_secret: '', redirect_uri: '', enabled: true },
};

function blankFeishu() {
  return { app_id: '', app_secret: '', redirect_uri: '', enabled: true };
}

class Settings {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        feishu: { ...blankFeishu(), ...(raw && typeof raw === 'object' ? raw.feishu || {} : {}) },
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { feishu: blankFeishu() };
    }
  }

  #save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  /** Resolved Feishu credentials: settings file first, then env fallbacks. */
  feishu() {
    const saved = this.data.feishu || blankFeishu();
    const app_id = String(saved.app_id || process.env.FEISHU_APP_ID || '').trim();
    const app_secret = String(saved.app_secret || process.env.FEISHU_APP_SECRET || '').trim();
    const redirect_uri = String(saved.redirect_uri || process.env.FEISHU_REDIRECT_URI || '').trim();
    const want = saved.enabled !== false;
    return { app_id, app_secret, redirect_uri, enabled: want && !!(app_id && app_secret) };
  }

  /** Admin GET shape: never re-emit the raw secret after save. */
  publicFeishu(defaultRedirect = '') {
    const f = this.feishu();
    const saved = this.data.feishu || blankFeishu();
    return {
      app_id: f.app_id,
      has_secret: !!f.app_secret,
      redirect_uri: saved.redirect_uri || '',
      enabled: saved.enabled !== false,
      ready: f.enabled,
      default_redirect_uri: defaultRedirect || 'https://linebot.dylantsai.com/api/auth/feishu/callback',
    };
  }

  setFeishu({ app_id, app_secret, redirect_uri, enabled } = {}) {
    if (!this.data.feishu) this.data.feishu = blankFeishu();
    if (app_id !== undefined) {
      if (typeof app_id !== 'string' || app_id.length > 128) throw Object.assign(new Error('App ID 无效'), { status: 400 });
      this.data.feishu.app_id = app_id.trim();
    }
    if (app_secret !== undefined && app_secret !== '') {
      if (typeof app_secret !== 'string' || app_secret.length > 256) throw Object.assign(new Error('App Secret 无效'), { status: 400 });
      this.data.feishu.app_secret = app_secret.trim();
    }
    if (redirect_uri !== undefined) {
      if (typeof redirect_uri !== 'string' || redirect_uri.length > 500) throw Object.assign(new Error('回调地址无效'), { status: 400 });
      const value = redirect_uri.trim();
      if (value && !/^https:\/\/[^\s]+$/i.test(value)) throw Object.assign(new Error('回调地址需为 https:// 开头'), { status: 400 });
      this.data.feishu.redirect_uri = value;
    }
    if (enabled !== undefined) this.data.feishu.enabled = !!enabled;
    this.#save();
    return this.publicFeishu();
  }
}

module.exports = { Settings, DEFAULTS };
