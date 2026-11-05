<script setup lang="ts">
// Slim top bar for non-chat pages: back to the session list on mobile, sidebar toggle on desktop.
import { backToMobileList } from '../store'
import Icon from './Icon.vue'
</script>
<template>
  <div class="page-bar">
    <button class="btn ghost icon-only bar-toggle chat-back" data-tip="返回会话列表" aria-label="返回会话列表" @click="backToMobileList"><Icon name="back" /></button>
  </div>
</template>
