<script setup lang="ts">
// Slim top bar for non-chat pages: sidebar toggle (drawer on mobile, expand when collapsed).
import { state, sidebarCollapsed, toggleSidebar } from '../store'
import Icon from './Icon.vue'
</script>
<template>
  <div class="page-bar">
    <button class="btn ghost icon-only bar-toggle" :class="{ show: sidebarCollapsed }" data-tip="展开侧边栏" aria-label="展开侧边栏" :aria-expanded="state.drawer" @click="toggleSidebar"><Icon name="panel-open" /></button>
  </div>
</template>
