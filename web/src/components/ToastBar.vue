<script setup lang="ts">
import { toastState } from '../store'
import Icon from './Icon.vue'
</script>
<template>
  <Transition name="toast">
    <div v-if="toastState.visible" :key="toastState.id" class="toast" role="status">
      <Icon v-if="toastState.ok" name="check" :size="14" />
      <Icon v-else name="alert" :size="14" />
      <span>{{ toastState.text }}</span>
    </div>
  </Transition>
</template>
