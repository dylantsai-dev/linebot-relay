<script setup lang="ts">
import { computed, watch, onBeforeUnmount } from 'vue'
import { state } from '../store'
import Icon from './Icon.vue'

const close = () => (state.lightbox = null)
const items = computed(() => state.lightbox?.items || [])
const hasGallery = computed(() => items.value.length > 1)
const index = computed(() => state.lightbox?.index ?? 0)
const label = computed(() => state.lightbox?.alt || '图片')

function show(i: number) {
  const lb = state.lightbox
  if (!lb?.items?.length) return
  const n = lb.items.length
  const safe = ((i % n) + n) % n
  const item = lb.items[safe]
  state.lightbox = { ...lb, src: item.src, alt: item.alt, index: safe }
}
const prev = () => show(index.value - 1)
const next = () => show(index.value + 1)

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') close()
  else if (hasGallery.value && e.key === 'ArrowLeft') prev()
  else if (hasGallery.value && e.key === 'ArrowRight') next()
}
watch(() => state.lightbox, value => { if (value) addEventListener('keydown', onKey); else removeEventListener('keydown', onKey) })
onBeforeUnmount(() => removeEventListener('keydown', onKey))

let startX = 0, axis: 'x' | 'y' | '' = '', pointerId = -1
function onPointerDown(e: PointerEvent) {
  if (!hasGallery.value || e.button !== 0) return
  pointerId = e.pointerId
  startX = e.clientX
  axis = ''
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
}
function onPointerUp(e: PointerEvent) {
  if (e.pointerId !== pointerId || !hasGallery.value) return
  const dx = e.clientX - startX
  pointerId = -1
  if (Math.abs(dx) > 56) (dx < 0 ? next : prev)()
}
</script>
<template>
  <Transition name="fade">
    <div v-if="state.lightbox" class="lightbox" role="dialog" aria-modal="true" aria-label="查看图片" @click.self="close">
      <img
        :src="state.lightbox.src"
        :alt="label"
        referrerpolicy="no-referrer"
        @pointerdown="onPointerDown"
        @pointerup="onPointerUp"
        @pointercancel="() => (pointerId = -1)"
      >
      <button v-if="hasGallery" type="button" class="lightbox-nav prev" aria-label="上一张" @click.stop="prev"><Icon name="back" :size="18" /></button>
      <button v-if="hasGallery" type="button" class="lightbox-nav next" aria-label="下一张" @click.stop="next"><Icon name="back" :size="18" class="flip" /></button>
      <div class="lightbox-bar">
        <span v-if="hasGallery" class="lightbox-meta">{{ index + 1 }} / {{ items.length }}</span>
        <a class="btn sm" :href="state.lightbox.src" target="_blank" rel="noopener noreferrer" :download="state.lightbox.src.startsWith('blob:') ? 'image' : undefined"><Icon name="download" :size="14" />原图</a>
        <button type="button" class="btn sm icon-only" aria-label="关闭" data-tip="关闭 (Esc)" @click="close"><Icon name="x" :size="14" /></button>
      </div>
    </div>
  </Transition>
</template>
