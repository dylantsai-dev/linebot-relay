<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import BrandMark from './BrandMark.vue'
import Icon from './Icon.vue'
import SessionAvatar from './SessionAvatar.vue'
import {
  editSession, openWebhook, setSessionPaused, state, allSessions, selectSession, refreshSessions, refreshLogs, refreshUsers, isAdmin, canCreate, isDark, toggleTheme,
  logout, changeOwnPassword, toast, sidebarCollapsed, toggleSidebar, requestLink,
} from '../store'
import { canInstall, showIosInstallHint, installPwa } from '../lib/pwa'
import { shortTime, time } from '../lib/format'
import { copy } from '../lib/clipboard'

type TabId = 'sessions' | 'logs' | 'docs' | 'users'
const nav = computed(() => [
  ['sessions', '会话', 'chat'], ['logs', '日志', 'logs'], ...(isAdmin.value ? [['users', '用户', 'users']] : []), ['docs', '文档', 'docs'],
] as [TabId, string, string][])
function go(tab: TabId) {
  state.tab = tab; state.drawer = false
  if (tab === 'logs') void refreshLogs()
  if (tab === 'users') void refreshUsers()
}
function open(key: string) { state.tab = 'sessions'; state.drawer = false; void selectSession(key) }

/* ---- session search ---- */
const query = ref(''), searchInput = ref<HTMLInputElement>()
const visible = computed(() => { const q = query.value.trim().toLowerCase(); return allSessions.value.filter(s => `${s.name || ''} ${s.key} ${s.codex_session_id || ''}`.toLowerCase().includes(q)) })
const statusText = (s: { status: string; queued: number }) => s.status === 'running' ? `运行中${s.queued ? ` +${s.queued}` : ''}` : s.status === 'queued' ? `排队 ${s.queued || 1}` : ''
const retry = () => refreshSessions().catch(e => (state.sessionsError = e.message))
function keys(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable
  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !typing) {
    e.preventDefault()
    if (matchMedia('(max-width: 767px)').matches) state.drawer = true
    else sidebarCollapsed.value = false
    setTimeout(() => searchInput.value?.focus())
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '.') { e.preventDefault(); toggleSidebar() }
  if (e.key === 'Escape') { if (userOpen.value) userOpen.value = false; else if (state.drawer) state.drawer = false }
}

/* ---- user menu + change password ---- */
const name = computed(() => state.me?.user?.display_name || state.me?.user?.username || '访问令牌')
const initial = computed(() => (state.me?.user?.display_name || state.me?.user?.username || '#').slice(0, 1).toUpperCase())
const avatarUrl = computed(() => state.me?.user?.avatar_url || '')
const canChangePassword = computed(() => !!state.me?.user?.has_password)
const userOpen = ref(false), userRoot = ref<HTMLElement>()
function outside(e: PointerEvent) { if (userOpen.value && userRoot.value && !userRoot.value.contains(e.target as Node)) userOpen.value = false }
onMounted(() => { document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keys) })
onBeforeUnmount(() => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keys) })

const dialog = ref<HTMLDialogElement>()
const current = ref(''), next = ref(''), confirm = ref(''), busy = ref(false), error = ref('')
function openPassword() { userOpen.value = false; current.value = next.value = confirm.value = error.value = ''; dialog.value?.showModal() }

async function onInstall() {
  userOpen.value = false
  const ok = await installPwa()
  toast(ok ? '已开始安装到桌面' : '已取消安装', ok)
}
function onIosHint() {
  userOpen.value = false
  toast('在 Safari 点分享，再选「添加到主屏幕」', true)
}
async function savePassword() {
  if (next.value.length < 8) { error.value = '新密码至少 8 位'; return }
  if (next.value !== confirm.value) { error.value = '两次输入的新密码不一致'; return }
  busy.value = true; error.value = ''
  try { await changeOwnPassword(current.value, next.value); dialog.value?.close(); toast('密码已修改，其他设备已退出登录', true) }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>
<template>
  <aside class="sidebar" :class="{ open: state.drawer, rail: sidebarCollapsed }" aria-label="侧边栏">
    <div class="side-head">
      <button class="brand" title="ディランボット 三代目" @click="go('sessions')"><BrandMark :size="24" /><span class="brand-name">ディランボット 三代目</span></button>
      <button class="btn ghost icon-only side-toggle" :data-tip="sidebarCollapsed ? '展开侧边栏 (Ctrl+.)' : '收起侧边栏 (Ctrl+.)'" :aria-label="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'" @click="toggleSidebar"><Icon :name="sidebarCollapsed ? 'panel-open' : 'panel-close'" /></button>
    </div>

    <button v-if="canCreate" class="side-primary" data-tip="关联已有的会话" @click="requestLink">
      <span class="plus-dot"><Icon name="plus" :size="15" :stroke="2.2" /></span><span class="label">关联会话</span>
    </button>

    <nav class="side-nav" aria-label="主导航">
      <button v-for="[id, label, icon] in nav" :key="id" class="nav-item" :class="{ active: state.tab === id }" :aria-current="state.tab === id ? 'page' : undefined" :data-tip="sidebarCollapsed ? label : undefined" @click="go(id)">
        <Icon :name="icon" /><span class="label">{{ label }}</span>
      </button>
    </nav>

    <div class="side-section">
      <div class="side-label"><span>会话</span><span class="count">{{ visible.length }}</span></div>
      <label class="search side-search">
        <Icon name="search" :size="14" />
        <input ref="searchInput" v-model="query" class="input" placeholder="搜索会话" aria-label="搜索会话">
        <kbd v-if="!query" class="kbd">/</kbd>
      </label>
      <div class="session-list">
        <template v-if="!state.sessionsLoaded && !state.sessionsError">
          <div v-for="i in 5" :key="i" class="skeleton-row"><span class="sk w60" /><span class="sk w40" /></div>
        </template>
        <div v-else-if="state.sessionsError && !allSessions.length" class="state-box error">
          <Icon name="alert" /><span>{{ state.sessionsError }}</span><button class="btn sm" @click="retry">重试</button>
        </div>
        <TransitionGroup v-else name="list" tag="div" class="session-items">
          <div v-for="s in visible" :key="s.key" class="session-row" :class="{ selected: state.selected === s.key && state.tab === 'sessions' }">
            <button type="button" class="session" :aria-pressed="state.selected === s.key" :title="`${s.key} · ${s.codex_session_id || '未关联'} · ${time(s.updated_at)}`" @click="open(s.key)">
              <SessionAvatar :session="s" :size="20" />
              <span class="s-key">{{ s.name || s.key }}</span>
              <span v-if="s.status === 'running' || s.status === 'queued'" class="s-spin" :title="statusText(s)" />
              <span v-else-if="s.paused" class="s-paused" data-tip="已暂停接收" aria-label="已暂停接收"><Icon name="pause" :size="13" /></span>
              <span v-else class="s-time">{{ shortTime(s.updated_at) }}</span>
            </button>
            <div class="row-actions">
              <button v-if="canCreate && !s.draft" type="button" class="mini" data-tip="编辑名称和头像" :aria-label="`编辑 ${s.name || s.key}`" @click="editSession(s)"><Icon name="pencil" :size="13" /></button>
              <button v-if="s.codex_session_id" type="button" class="mini" data-tip="复制会话 ID" :aria-label="`复制 ${s.key} 的会话 ID`" @click="copy(s.codex_session_id)"><Icon name="copy" :size="13" /></button>
              <button v-if="canCreate && !s.draft" type="button" class="mini" :data-tip="s.paused ? '恢复接收' : '暂停接收'" :aria-label="`${s.paused ? '恢复' : '暂停'}接收 ${s.name || s.key}`" @click="setSessionPaused(s.key, !s.paused).catch(e => toast(e.message))"><Icon :name="s.paused ? 'play' : 'pause'" :size="13" /></button>
              <button v-if="canCreate && !s.draft" type="button" class="mini" data-tip="Webhook" :aria-label="`${s.name || s.key} 的 Webhook`" aria-haspopup="dialog" @click="openWebhook(s)"><Icon name="webhook" :size="13" /></button>
            </div>
          </div>
        </TransitionGroup>
        <div v-if="state.sessionsLoaded && !visible.length" class="side-empty">
          <Icon name="empty" :size="20" />
          <span>{{ allSessions.length ? '没有匹配的会话' : canCreate ? '还没有会话' : '还没有分配给你的会话' }}</span>
          <small v-if="!allSessions.length && !canCreate">请联系管理员分配会话</small>
          <button v-if="!allSessions.length && canCreate" class="btn sm" @click="requestLink"><Icon name="plus" :size="13" />关联第一个会话</button>
        </div>
      </div>
    </div>

    <div ref="userRoot" class="side-foot">
      <button class="user-btn" :aria-expanded="userOpen" aria-haspopup="menu" :data-tip="sidebarCollapsed ? name : undefined" @click="userOpen = !userOpen">
        <span class="user-avatar" :class="{ token: !state.me?.user, 'has-img': !!avatarUrl }"><Icon v-if="!state.me?.user" name="key" :size="13" /><img v-else-if="avatarUrl" :src="avatarUrl" alt="" referrerpolicy="no-referrer" /><template v-else>{{ initial }}</template></span>
        <span class="user-meta"><span class="user-name">{{ name }}</span><span class="user-role">{{ isAdmin ? '超级管理员' : '普通用户' }}</span></span>
        <Icon name="chevron" :size="14" class="user-chev" />
      </button>
      <Transition name="pop">
        <div v-if="userOpen" class="menu user-dropdown" role="menu">
          <div class="user-card">
            <span class="user-avatar lg" :class="{ token: !state.me?.user, 'has-img': !!avatarUrl }"><Icon v-if="!state.me?.user" name="key" :size="15" /><img v-else-if="avatarUrl" :src="avatarUrl" alt="" referrerpolicy="no-referrer" /><template v-else>{{ initial }}</template></span>
            <span><strong>{{ name }}</strong><small class="muted">{{ state.me?.user ? (isAdmin ? '超级管理员 · 全部会话' : '普通用户 · 仅分配的会话') : 'WEBHOOK_TOKEN · 全部权限' }}</small></span>
          </div>
          <button class="menu-item" role="menuitem" @click="toggleTheme(); userOpen = false"><Icon :name="isDark ? 'sun' : 'moon'" :size="15" /><span class="menu-label">{{ isDark ? '浅色模式' : '深色模式' }}</span></button>
          <button v-if="canInstall" class="menu-item" role="menuitem" @click="onInstall"><Icon name="download" :size="15" /><span class="menu-label">安装到桌面</span></button>
          <button v-else-if="showIosInstallHint" class="menu-item" role="menuitem" @click="onIosHint"><Icon name="download" :size="15" /><span class="menu-label">添加到主屏幕</span></button>
          <button v-if="canChangePassword" class="menu-item" role="menuitem" @click="openPassword"><Icon name="lock" :size="15" /><span class="menu-label">修改密码</span></button>
          <button class="menu-item" role="menuitem" @click="logout()"><Icon name="logout" :size="15" /><span class="menu-label">退出登录</span></button>
        </div>
      </Transition>
    </div>


    <dialog ref="dialog" class="dialog" @click.self="dialog?.close()">
      <form @submit.prevent="savePassword">
        <div class="dialog-head">
          <h2><span class="title-icon"><Icon name="lock" :size="16" /></span>修改密码</h2>
          <button type="button" class="btn ghost icon-only sm" aria-label="关闭" data-tip="关闭 (Esc)" @click="dialog?.close()"><Icon name="x" :size="15" /></button>
        </div>
        <p class="muted">修改后，其他设备上的登录会失效。</p>
        <label class="field-label" for="pw-current">当前密码</label>
        <input id="pw-current" v-model="current" class="input" type="password" autocomplete="current-password" required>
        <label class="field-label" for="pw-next">新密码</label>
        <input id="pw-next" v-model="next" class="input" type="password" autocomplete="new-password" minlength="8" required>
        <label class="field-label" for="pw-confirm">确认新密码</label>
        <input id="pw-confirm" v-model="confirm" class="input" type="password" autocomplete="new-password" required>
        <small class="field-hint" :class="{ error: !!error }">{{ error || '至少 8 位' }}</small>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="dialog?.close()">取消</button>
          <button class="btn primary" :disabled="busy || !current || !next"><span v-if="busy" class="spinner sm inv" />{{ busy ? '保存中…' : '保存' }}</button>
        </div>
      </form>
    </dialog>
  </aside>
</template>
