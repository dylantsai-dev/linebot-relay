<script setup lang="ts">
import { state, logout, isDark, toggleTheme, refreshLogs } from '../store'
import Icon from './Icon.vue'
const tabs = [['sessions', '会话'], ['logs', '日志'], ['docs', '文档']] as const
function go(tab: typeof tabs[number][0]) { state.tab = tab; if (tab === 'logs') void refreshLogs() }
</script>
<template>
  <header class="topbar">
    <div class="brand"><span class="brand-mark"><Icon name="logo" :size="14" /></span><span class="brand-name">Codex Relay</span></div>
    <nav class="tabs" aria-label="主导航">
      <button v-for="[id, label] in tabs" :key="id" class="tab" :class="{ active: state.tab === id }" :aria-current="state.tab === id ? 'page' : undefined" @click="go(id)">{{ label }}</button>
    </nav>
    <span class="spacer" />
    <button class="btn ghost icon-only" :title="isDark ? '浅色模式' : '深色模式'" aria-label="切换深浅主题" @click="toggleTheme"><Icon :name="isDark ? 'sun' : 'moon'" /></button>
    <button class="btn ghost icon-only" title="退出登录" aria-label="退出登录" @click="logout"><Icon name="logout" /></button>
  </header>
</template>
