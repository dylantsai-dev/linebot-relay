<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { state, users, refreshUsers, refreshSessions, updateUser, resetPassword, deleteUser, toast, fetchFeishuSettings, saveFeishuSettings } from '../store'
import type { User, FeishuSettings } from '../lib/types'
import { time, shortTime } from '../lib/format'
import Icon from './Icon.vue'
import UserDialog from './UserDialog.vue'

onMounted(() => { void refreshUsers(); void refreshSessions().catch(() => {}); void loadFeishu() })
const editor = ref<InstanceType<typeof UserDialog>>()
const query = ref('')
const list = computed(() => { const q = query.value.trim().toLowerCase(); return users.list.filter(u => u.username.toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q)) })
const self = (u: User) => u.id === state.me?.user?.id

const pwDialog = ref<HTMLDialogElement>(), pwUser = ref<User | null>(null), pw = ref(''), pwBusy = ref(false), pwError = ref('')
function openReset(u: User) { pwUser.value = u; pw.value = ''; pwError.value = ''; pwDialog.value?.showModal() }
async function doReset() {
  pwBusy.value = true; pwError.value = ''
  try { await resetPassword(pwUser.value!.id, pw.value); pwDialog.value?.close(); toast(`已重置 ${pwUser.value!.username} 的密码`, true) }
  catch (e) { pwError.value = (e as Error).message }
  finally { pwBusy.value = false }
}
const delDialog = ref<HTMLDialogElement>(), delUser = ref<User | null>(null), delBusy = ref(false)
function openDelete(u: User) { delUser.value = u; delDialog.value?.showModal() }
async function doDelete() {
  delBusy.value = true
  try { await deleteUser(delUser.value!.id); delDialog.value?.close(); toast('用户已删除', true) }
  catch (e) { toast((e as Error).message) }
  finally { delBusy.value = false }
}
async function toggleDisabled(u: User) {
  try { await updateUser(u.id, { disabled: !u.disabled }); toast(u.disabled ? `已启用 ${u.username}` : `已停用 ${u.username}`, true) }
  catch (e) { toast((e as Error).message) }
}

/* ---- Feishu settings (super admin) ---- */
const feishu = ref<FeishuSettings | null>(null)
const fsAppId = ref(''), fsSecret = ref(''), fsRedirect = ref(''), fsEnabled = ref(true)
const fsBusy = ref(false), fsError = ref(''), fsLoaded = ref(false)
async function loadFeishu() {
  try {
    const data = await fetchFeishuSettings()
    feishu.value = data
    fsAppId.value = data.app_id || ''
    fsRedirect.value = data.redirect_uri || ''
    fsEnabled.value = data.enabled !== false
    fsSecret.value = ''
    fsLoaded.value = true
  } catch (e) { fsError.value = (e as Error).message }
}
async function saveFeishu() {
  fsBusy.value = true; fsError.value = ''
  try {
    const body: { app_id: string; redirect_uri: string; enabled: boolean; app_secret?: string } = {
      app_id: fsAppId.value.trim(),
      redirect_uri: fsRedirect.value.trim(),
      enabled: fsEnabled.value,
    }
    if (fsSecret.value.trim()) body.app_secret = fsSecret.value.trim()
    const data = await saveFeishuSettings(body)
    feishu.value = data
    fsSecret.value = ''
    toast(data.ready ? '飞书登录已保存并启用' : '飞书配置已保存（尚未完整，登录按钮不会显示）', true)
  } catch (e) { fsError.value = (e as Error).message }
  finally { fsBusy.value = false }
}
</script>
<template>
  <div class="page">
    <div class="page-inner">
      <div class="page-head row">
        <div><h1><span class="title-icon"><Icon name="users" :size="18" /></span>用户</h1><p class="muted">管理员可以访问全部会话；普通用户只能看到被授权的会话。</p></div>
        <button class="btn primary" @click="editor?.open(null)"><Icon name="user-plus" :size="15" />新建用户</button>
      </div>

      <section class="settings-card" aria-labelledby="feishu-settings-title">
        <div class="settings-card-head">
          <div>
            <h2 id="feishu-settings-title"><Icon name="login" :size="15" />飞书登录</h2>
            <p class="muted">配置后，控制台登录页会显示「使用飞书登录」。飞书新用户默认是普通用户。</p>
          </div>
          <span v-if="feishu" class="badge" :class="{ app: feishu.ready }">{{ feishu.ready ? '已启用' : '未就绪' }}</span>
        </div>
        <div class="feishu-form">
          <label class="field-label" for="fs-app-id">App ID</label>
          <input id="fs-app-id" v-model="fsAppId" class="input" autocomplete="off" spellcheck="false" placeholder="cli_…" :disabled="!fsLoaded">
          <label class="field-label" for="fs-secret">App Secret</label>
          <input id="fs-secret" v-model="fsSecret" class="input" type="password" autocomplete="new-password" :placeholder="feishu?.has_secret ? '已保存，留空则保持不变' : '在飞书开放平台复制'" :disabled="!fsLoaded">
          <label class="field-label" for="fs-redirect">回调地址（可选）</label>
          <input id="fs-redirect" v-model="fsRedirect" class="input mono" autocomplete="off" spellcheck="false" :placeholder="feishu?.default_redirect_uri || 'https://linebot.dylantsai.com/api/auth/feishu/callback'" :disabled="!fsLoaded">
          <small class="field-hint">请把同一地址填到飞书开放平台 → 安全设置 → 重定向 URL。留空则使用：{{ feishu?.default_redirect_uri }}</small>
          <label class="check"><input v-model="fsEnabled" type="checkbox" :disabled="!fsLoaded"> 启用飞书登录</label>
          <small v-if="fsError" class="field-hint error">{{ fsError }}</small>
          <div class="dialog-actions feishu-actions">
            <button type="button" class="btn primary" :disabled="fsBusy || !fsLoaded" @click="saveFeishu">
              <span v-if="fsBusy" class="spinner sm inv" />{{ fsBusy ? '保存中…' : '保存飞书配置' }}
            </button>
          </div>
        </div>
      </section>

      <div class="toolbar">
        <label class="search users-search">
          <Icon name="search" :size="14" />
          <input v-model="query" class="input" placeholder="搜索用户名" aria-label="搜索用户">
        </label>
        <span class="muted users-count">{{ users.list.length }} 个用户</span>
        <span class="spacer" />
        <button class="btn ghost icon-only sm" :class="{ spinning: users.loading }" data-tip="刷新" aria-label="刷新" @click="refreshUsers"><Icon name="refresh" :size="14" /></button>
      </div>
      <div v-if="users.error" class="banner error"><Icon name="alert" :size="14" />{{ users.error }}</div>
      <div class="table-card">
        <div class="user-grid head">
          <span>用户</span><span>角色</span><span>可见会话</span><span>权限</span><span>最近登录</span><span />
        </div>
        <template v-if="!users.loaded && !users.error">
          <div v-for="i in 3" :key="i" class="user-grid"><span class="sk w60" /><span class="sk w40" /><span class="sk w40" /><span class="sk w30" /><span class="sk w40" /><span /></div>
        </template>
        <div v-for="u in list" :key="u.id" class="user-grid row" :class="{ off: u.disabled }">
          <span class="u-name">
            <span class="user-avatar" :class="{ 'has-img': !!u.avatar_url }">
              <img v-if="u.avatar_url" :src="u.avatar_url" alt="" referrerpolicy="no-referrer" />
              <template v-else>{{ (u.display_name || u.username).slice(0, 1).toUpperCase() }}</template>
            </span>
            <span class="u-text">
              <b>{{ u.display_name || u.username }}</b>
              <small v-if="u.display_name && u.display_name !== u.username" class="muted u-handle">@{{ u.username }}</small>
              <small v-if="self(u)" class="badge">你</small>
              <small v-if="u.auth_provider === 'feishu'" class="badge feishu-badge">飞书</small>
              <small v-if="u.disabled" class="badge off-badge">已停用</small>
            </span>
          </span>
          <span class="u-cell" data-label="角色"><span class="badge" :class="{ app: u.role === 'admin' }"><Icon :name="u.role === 'admin' ? 'shield' : 'user'" :size="11" />{{ u.role === 'admin' ? '管理员' : '普通用户' }}</span></span>
          <span class="u-cell u-sessions" data-label="会话">
            <template v-if="u.role === 'admin'"><span class="muted">全部</span></template>
            <template v-else-if="!u.sessions.length"><span class="faint">无</span></template>
            <template v-else>
              <span v-for="k in u.sessions.slice(0, 2)" :key="k" class="key-chip mono">{{ k }}</span>
              <span v-if="u.sessions.length > 2" class="muted">+{{ u.sessions.length - 2 }}</span>
            </template>
          </span>
          <span class="u-cell" data-label="权限">{{ u.role === 'admin' ? '新建/删除会话' : '仅授权会话' }}</span>
          <span class="u-cell faint" data-label="登录" :title="time(u.last_login_at || undefined)">{{ u.last_login_at ? shortTime(u.last_login_at) : '从未' }}</span>
          <span class="u-actions">
            <button class="btn sm" @click="editor?.open(u)"><Icon name="pencil" :size="13" />编辑</button>
            <button class="btn ghost icon-only sm" data-tip="重置密码" aria-label="重置密码" @click="openReset(u)"><Icon name="key" :size="14" /></button>
            <button class="btn ghost icon-only sm" :data-tip="u.disabled ? '启用账号' : '停用账号'" :aria-label="u.disabled ? '启用' : '停用'" :disabled="self(u)" @click="toggleDisabled(u)"><Icon :name="u.disabled ? 'check' : 'ban'" :size="14" /></button>
            <button class="btn ghost icon-only sm danger-ghost" data-tip="删除用户" aria-label="删除" :disabled="self(u)" @click="openDelete(u)"><Icon name="trash" :size="14" /></button>
          </span>
        </div>
        <div v-if="users.loaded && !list.length" class="state-box">
          <div class="state-icon"><Icon name="users" :size="20" /></div><strong>{{ users.list.length ? '没有匹配的用户' : '还没有用户' }}</strong><span v-if="!users.list.length">点击右上角「新建用户」添加第一个账号。</span>
        </div>
      </div>
      <p class="users-foot muted"><Icon name="key" :size="12" />只有管理员可以新建和删除会话；普通用户只能查看被授权的会话并在其中发消息。访问令牌（WEBHOOK_TOKEN）始终拥有全部权限，可用于 Webhook 集成和找回管理员。</p>
    </div>
    <UserDialog ref="editor" />
    <dialog ref="pwDialog" class="dialog" @click.self="pwDialog?.close()">
      <form @submit.prevent="doReset">
        <div class="dialog-head">
          <h2><span class="title-icon"><Icon name="key" :size="16" /></span>重置密码</h2>
          <button type="button" class="btn ghost icon-only sm" aria-label="关闭" data-tip="关闭 (Esc)" @click="pwDialog?.close()"><Icon name="x" :size="15" /></button>
        </div>
        <p class="muted">为 <b>{{ pwUser?.username }}</b> 设置新密码。该用户所有已登录设备会退出。{{ pwUser?.auth_provider === 'feishu' ? '飞书用户设置密码后也可用账号密码登录。' : '' }}</p>
        <label class="field-label" for="reset-pw">新密码</label>
        <input id="reset-pw" v-model="pw" class="input" type="password" autocomplete="new-password" minlength="8" required>
        <small class="field-hint" :class="{ error: !!pwError }">{{ pwError || '至少 8 位' }}</small>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="pwDialog?.close()">取消</button>
          <button class="btn primary" :disabled="pwBusy || pw.length < 8"><span v-if="pwBusy" class="spinner sm inv" />{{ pwBusy ? '保存中…' : '重置密码' }}</button>
        </div>
      </form>
    </dialog>
    <dialog ref="delDialog" class="dialog" @click.self="delDialog?.close()">
      <div class="dialog-head">
        <h2><span class="title-icon danger"><Icon name="trash" :size="16" /></span>删除用户</h2>
        <button type="button" class="btn ghost icon-only sm" aria-label="关闭" data-tip="关闭 (Esc)" @click="delDialog?.close()"><Icon name="x" :size="15" /></button>
      </div>
      <p class="mono del-key">{{ delUser?.username }}</p>
      <p class="muted">删除账号及其会话授权，并立即退出所有设备。会话本身不会被删除。此操作无法撤销。</p>
      <div class="dialog-actions">
        <button class="btn" @click="delDialog?.close()">取消</button>
        <button class="btn danger-solid" :disabled="delBusy" @click="doDelete"><span v-if="delBusy" class="spinner sm inv" />{{ delBusy ? '删除中…' : '删除' }}</button>
      </div>
    </dialog>
  </div>
</template>
