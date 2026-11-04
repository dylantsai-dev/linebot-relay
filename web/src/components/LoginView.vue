<script setup lang="ts">
import BrandMark from './BrandMark.vue'
import { ref, onMounted, nextTick } from 'vue'
import { login, loginPassword, isDark, toggleTheme } from '../store'
import Icon from './Icon.vue'
const mode = ref<'password' | 'token'>('password')
const username = ref(''), password = ref(''), token = ref('')
const remember = ref(false), busy = ref(false), error = ref(''), needsSetup = ref(false)
const first = ref<HTMLInputElement>()
onMounted(async () => {
  first.value?.focus()
  try {
    const status = await (await fetch('/api/auth/status', { cache: 'no-store' })).json()
    if (status.needs_setup) { needsSetup.value = true; switchMode('token') }
  } catch { /* the login form still works */ }
})
async function switchMode(next: 'password' | 'token') { mode.value = next; error.value = ''; await nextTick(); first.value?.focus() }
const ready = () => (mode.value === 'token' ? !!token.value : !!username.value.trim() && !!password.value)
async function submit() {
  if (!ready() || busy.value) return
  busy.value = true; error.value = ''
  try {
    if (mode.value === 'token') { await login(token.value, remember.value); token.value = '' }
    else { await loginPassword(username.value.trim(), password.value, remember.value); password.value = '' }
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>
<template>
  <div class="login">
    <button class="btn ghost icon-only login-theme" :title="isDark ? '浅色模式' : '深色模式'" aria-label="切换深浅主题" @click="toggleTheme"><Icon :name="isDark ? 'sun' : 'moon'" /></button>
    <form class="login-card" @submit.prevent="submit">
      <BrandMark class="login-mark" :size="36" />
      <h1>Codex Relay</h1>
      <p class="login-sub">{{ mode === 'password' ? '使用账号登录控制台' : '使用访问令牌（WEBHOOK_TOKEN）登录' }}</p>
      <p v-if="needsSetup && mode === 'token'" class="login-note"><Icon name="shield" :size="13" />尚未创建管理员。请先用访问令牌登录，再创建管理员账号。</p>
      <template v-if="mode === 'password'">
        <label class="field-label" for="username">用户名</label>
        <input id="username" ref="first" v-model="username" class="input" autocomplete="username" autocapitalize="off" spellcheck="false" required>
        <label class="field-label" for="password">密码</label>
        <input id="password" v-model="password" class="input" type="password" autocomplete="current-password" required>
      </template>
      <template v-else>
        <label class="field-label" for="token">访问令牌</label>
        <input id="token" ref="first" v-model="token" class="input" type="password" autocomplete="off" placeholder="••••••••••••" required>
      </template>
      <label class="check"><input v-model="remember" type="checkbox"> 记住我</label>
      <button class="btn primary block" :disabled="busy || !ready()">
        <span v-if="busy" class="spinner sm inv" />{{ busy ? '验证中…' : '登录' }}
      </button>
      <p class="login-error" role="alert">{{ error }}</p>
      <button type="button" class="link-btn" @click="switchMode(mode === 'password' ? 'token' : 'password')">
        {{ mode === 'password' ? '使用访问令牌登录' : '使用用户名和密码登录' }}
      </button>
    </form>
    <p class="login-foot">Webhook → Codex App 会话中继</p>
  </div>
</template>
