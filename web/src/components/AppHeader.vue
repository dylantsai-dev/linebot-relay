<script setup lang="ts">
import BrandMark from './BrandMark.vue'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { state, logout, isDark, toggleTheme, refreshLogs, isAdmin, refreshUsers, changeOwnPassword, toast } from '../store'
import Icon from './Icon.vue'
type TabId = 'sessions' | 'logs' | 'docs' | 'users'
const tabs = computed(() => [['sessions', '会话'], ['logs', '日志'], ...(isAdmin.value ? [['users', '用户']] : []), ['docs', '文档']] as [TabId, string][])
function go(tab: TabId) { state.tab = tab; if (tab === 'logs') void refreshLogs(); if (tab === 'users') void refreshUsers() }

const name = computed(() => state.me?.user?.username || '访问令牌')
const initial = computed(() => (state.me?.user?.username || '#').slice(0, 1).toUpperCase())
const open = ref(false), root = ref<HTMLElement>()
function outside(e: PointerEvent) { if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false }
function esc(e: KeyboardEvent) { if (e.key === 'Escape') open.value = false }
onMounted(() => { document.addEventListener('pointerdown', outside); document.addEventListener('keydown', esc) })
onBeforeUnmount(() => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', esc) })

const dialog = ref<HTMLDialogElement>()
const current = ref(''), next = ref(''), confirm = ref(''), busy = ref(false), error = ref('')
function openPassword() { open.value = false; current.value = next.value = confirm.value = error.value = ''; dialog.value?.showModal() }
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
  <header class="topbar">
    <div class="brand"><BrandMark :size="22" /><span class="brand-name">Codex Relay</span></div>
    <nav class="tabs" aria-label="主导航">
      <button v-for="[id, label] in tabs" :key="id" class="tab" :class="{ active: state.tab === id }" :aria-current="state.tab === id ? 'page' : undefined" @click="go(id)">{{ label }}</button>
    </nav>
    <span class="spacer" />
    <button class="btn ghost icon-only" :title="isDark ? '浅色模式' : '深色模式'" aria-label="切换深浅主题" @click="toggleTheme"><Icon :name="isDark ? 'sun' : 'moon'" /></button>
    <div ref="root" class="user-menu">
      <button class="user-btn" :aria-expanded="open" aria-haspopup="menu" :title="name" @click="open = !open">
        <span class="user-avatar" :class="{ token: !state.me?.user }"><Icon v-if="!state.me?.user" name="key" :size="12" /><template v-else>{{ initial }}</template></span>
        <span class="user-name">{{ name }}</span>
        <Icon name="chevron" :size="13" />
      </button>
      <Transition name="pop">
        <div v-if="open" class="menu user-dropdown" role="menu">
          <div class="user-card">
            <strong>{{ name }}</strong>
            <span class="badge" :class="{ app: isAdmin }">{{ isAdmin ? '管理员' : '普通用户' }}</span>
            <small v-if="!state.me?.user" class="muted">使用 WEBHOOK_TOKEN 登录，拥有全部权限</small>
          </div>
          <button v-if="state.me?.user" class="menu-item" role="menuitem" @click="openPassword"><Icon name="lock" :size="14" /><span class="menu-label">修改密码</span></button>
          <button class="menu-item" role="menuitem" @click="logout()"><Icon name="logout" :size="14" /><span class="menu-label">退出登录</span></button>
        </div>
      </Transition>
    </div>
    <dialog ref="dialog" class="dialog" @click.self="dialog?.close()">
      <form @submit.prevent="savePassword">
        <h2>修改密码</h2>
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
          <button class="btn primary" :disabled="busy || !current || !next">{{ busy ? '保存中…' : '保存' }}</button>
        </div>
      </form>
    </dialog>
  </header>
</template>
