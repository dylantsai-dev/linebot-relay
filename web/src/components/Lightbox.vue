<script setup lang="ts">
import { watch, onBeforeUnmount } from 'vue'
import { state } from '../store'
import Icon from './Icon.vue'

const close = () => (state.lightbox = null)
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
watch(() => state.lightbox, value => { if (value) addEventListener('keydown', onKey); else removeEventListener('keydown', onKey) })
onBeforeUnmount(() => removeEventListener('keydown', onKey))
</script>
<template>
  <Transition name="fade">
    <div v-if="state.lightbox" class="lightbox" role="dialog" aria-modal="true" aria-label="查看图片" @click.self="close">
      <img :src="state.lightbox.src" :alt="state.lightbox.alt" referrerpolicy="no-referrer">
      <div class="lightbox-bar">
        <a class="btn sm" :href="state.lightbox.src" target="_blank" rel="noopener noreferrer" :download="state.lightbox.src.startsWith('blob:') ? 'image' : undefined">原图</a>
        <button type="button" class="btn sm" aria-label="关闭" @click="close"><Icon name="x" :size="14" /></button>
      </div>
    </div>
  </Transition>
</template>
