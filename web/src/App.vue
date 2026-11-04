<script setup lang="ts">
import { onMounted } from 'vue'
import { state, restoreLogin } from './store'
import LoginView from './components/LoginView.vue'
import AppHeader from './components/AppHeader.vue'
import SessionsView from './components/SessionsView.vue'
import LogsView from './components/LogsView.vue'
import DocsView from './components/DocsView.vue'
import ToastBar from './components/ToastBar.vue'
onMounted(restoreLogin)
</script>
<template>
  <div v-if="state.booting" class="boot"><span class="spinner" /></div>
  <LoginView v-else-if="!state.authed" />
  <div v-else class="shell">
    <AppHeader />
    <main class="main">
      <SessionsView v-show="state.tab === 'sessions'" />
      <LogsView v-if="state.tab === 'logs'" />
      <DocsView v-if="state.tab === 'docs'" />
    </main>
  </div>
  <ToastBar />
</template>
