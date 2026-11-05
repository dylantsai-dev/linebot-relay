<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { state, restoreLogin, sidebarCollapsed, registerSessionEditor } from './store'
import LoginView from './components/LoginView.vue'
import AppSidebar from './components/AppSidebar.vue'
import SessionsView from './components/SessionsView.vue'
import LogsView from './components/LogsView.vue'
import DocsView from './components/DocsView.vue'
import ToastBar from './components/ToastBar.vue'
import Lightbox from './components/Lightbox.vue'
import UsersView from './components/UsersView.vue'
import SetupBanner from './components/SetupBanner.vue'
import PageBar from './components/PageBar.vue'
import SessionDialog from './components/SessionDialog.vue'
onMounted(restoreLogin)
const sessionDialog = ref<InstanceType<typeof SessionDialog>>()
registerSessionEditor(s => sessionDialog.value?.open(s))
</script>
<template>
  <div v-if="state.booting" class="boot"><span class="spinner" /></div>
  <LoginView v-else-if="!state.authed" />
  <div v-else class="shell" :class="{ collapsed: sidebarCollapsed }">
    <Transition name="fade"><div v-if="state.drawer" class="backdrop" @click="state.drawer = false" /></Transition>
    <AppSidebar />
    <main class="main">
      <SetupBanner />
      <PageBar v-if="state.tab !== 'sessions'" />
      <div class="main-body">
        <SessionsView v-show="state.tab === 'sessions'" />
        <LogsView v-if="state.tab === 'logs'" />
        <DocsView v-if="state.tab === 'docs'" />
        <UsersView v-if="state.tab === 'users' && state.me?.role === 'admin'" />
      </div>
    </main>
  </div>
  <SessionDialog ref="sessionDialog" />
  <ToastBar />
  <Lightbox />
</template>
