<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { login, isDark, toggleTheme } from '../store'
import Icon from './Icon.vue'
const token = ref(''), remember = ref(false), busy = ref(false), error = ref(''), input = ref<HTMLInputElement>()
onMounted(() => input.value?.focus())
async function submit() {
  if (!token.value || busy.value) return
  busy.value = true; error.value = ''
  try { await login(token.value, remember.value); token.value = '' }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>
<template>
  <div class="login">
    <button class="btn ghost icon-only login-theme" :title="isDark ? '浅色模式' : '深色模式'" aria-label="切换深浅主题" @click="toggleTheme"><Icon :name="isDark ? 'sun' : 'moon'" /></button>
    <form class="login-card" @submit.prevent="submit">
      <div class="login-mark"><Icon name="logo" :size="20" /></div>
      <h1>Codex Relay</h1>
      <p class="login-sub">输入访问 Token 进入控制台</p>
      <label class="field-label" for="token">访问 Token</label>
      <input id="token" ref="input" v-model="token" class="input" type="password" autocomplete="off" placeholder="••••••••••••" required>
      <label class="check"><input v-model="remember" type="checkbox"> 记住我</label>
      <button class="btn primary block" :disabled="busy || !token">
        <span v-if="busy" class="spinner sm" />{{ busy ? '验证中…' : '登录' }}
      </button>
      <p class="login-error" role="alert">{{ error }}</p>
    </form>
    <p class="login-foot">Webhook → Codex App 会话中继</p>
  </div>
</template>
