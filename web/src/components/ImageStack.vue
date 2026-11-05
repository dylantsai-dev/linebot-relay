<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { state } from '../store'
import Icon from './Icon.vue'

export type StackImage = { src: string; alt?: string; title?: string }

const props = withDefaults(defineProps<{ images: StackImage[]; collapseAt?: number }>(), { collapseAt: 2 })
const expanded = ref(false)
const index = ref(0)
const dragX = ref(0)
const dragging = ref(false)
const animating = ref(false)

const count = computed(() => props.images.length)
const stackable = computed(() => count.value >= props.collapseAt)
const current = computed(() => props.images[Math.min(index.value, Math.max(0, count.value - 1))] || null)
const peeks = computed(() => {
  if (!stackable.value || count.value < 2) return [] as StackImage[]
  const out: StackImage[] = []
  for (let i = 1; i <= Math.min(2, count.value - 1); i++) out.push(props.images[(index.value + i) % count.value])
  return out
})

watch(() => props.images.map(i => i.src).join('\0'), () => {
  index.value = 0
  expanded.value = false
  dragX.value = 0
})

function openAt(i: number) {
  const items = props.images.map(img => ({ src: img.src, alt: img.alt || img.title || '图片' }))
  const safe = ((i % items.length) + items.length) % items.length
  state.lightbox = { src: items[safe].src, alt: items[safe].alt, items, index: safe }
}

function step(delta: number) {
  if (!stackable.value || count.value < 2) return
  index.value = (index.value + delta + count.value) % count.value
}

let startX = 0, startY = 0, axis: 'x' | 'y' | '' = '', pointerId = -1, moved = false
function onPointerDown(e: PointerEvent) {
  if (!stackable.value || expanded.value || e.button !== 0) return
  pointerId = e.pointerId
  startX = e.clientX
  startY = e.clientY
  axis = ''
  moved = false
  dragging.value = true
  dragX.value = 0
  animating.value = false
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== pointerId) return
  const dx = e.clientX - startX
  const dy = e.clientY - startY
  if (!axis) {
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
    axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
    if (axis === 'y') { dragging.value = false; dragX.value = 0; return }
  }
  if (axis !== 'x') return
  e.preventDefault()
  moved = true
  dragX.value = dx
}
function onPointerUp(e: PointerEvent) {
  if (e.pointerId !== pointerId) return
  const dx = dragX.value
  const wasDragging = dragging.value
  const didMove = moved
  pointerId = -1
  dragging.value = false
  animating.value = true
  if (wasDragging && axis === 'x' && Math.abs(dx) > 48) {
    step(dx < 0 ? 1 : -1)
    dragX.value = 0
  } else {
    dragX.value = 0
    if (!didMove && current.value) openAt(index.value)
  }
  axis = ''
  setTimeout(() => (animating.value = false), 220)
}
function onPointerCancel(e: PointerEvent) {
  if (e.pointerId !== pointerId) return
  pointerId = -1
  dragging.value = false
  animating.value = true
  dragX.value = 0
  axis = ''
  setTimeout(() => (animating.value = false), 220)
}

function toggleExpand() {
  expanded.value = !expanded.value
  if (!expanded.value) dragX.value = 0
}
</script>
<template>
  <div v-if="images.length === 1 && images[0]" class="gen-images">
    <button type="button" class="gen-image" :title="images[0].title || images[0].alt" @click="openAt(0)">
      <img :src="images[0].src" :alt="images[0].alt || images[0].title || '图片'" loading="lazy" decoding="async" referrerpolicy="no-referrer">
    </button>
  </div>

  <div v-else-if="images.length" class="img-stack" :class="{ expanded, stackable }">
    <template v-if="!expanded && stackable">
      <div
        class="img-deck"
        role="group"
        :aria-label="`${count} 张图片，第 ${index + 1} 张`"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
      >
        <div
          v-for="(peek, i) in peeks.slice().reverse()"
          :key="`peek-${index}-${i}-${peek.src}`"
          class="img-card peek"
          :style="{ '--peek': String(peeks.length - i) }"
          aria-hidden="true"
        >
          <img :src="peek.src" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable="false">
        </div>
        <button
          type="button"
          class="img-card front"
          :class="{ dragging, animating }"
          :style="{ transform: dragX ? `translateX(${dragX}px) rotate(${dragX / 48}deg)` : undefined }"
          :title="current?.title || current?.alt || `图片 ${index + 1}`"
          @click.prevent
        >
          <img v-if="current" :src="current.src" :alt="current.alt || current.title || '图片'" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable="false">
          <span class="img-count">{{ index + 1 }}/{{ count }}</span>
        </button>
      </div>
      <button type="button" class="img-expand-pill" :aria-expanded="false" @click="toggleExpand">
        <Icon name="images" :size="13" :stroke="1.8" />
        <span>{{ count }}张图片</span>
      </button>
    </template>

    <template v-else>
      <div class="gen-images">
        <button
          v-for="(img, i) in images"
          :key="img.src + '-' + i"
          type="button"
          class="gen-image"
          :title="img.title || img.alt"
          @click="openAt(i)"
        >
          <img :src="img.src" :alt="img.alt || img.title || `图片 ${i + 1}`" loading="lazy" decoding="async" referrerpolicy="no-referrer">
        </button>
      </div>
      <button v-if="stackable" type="button" class="img-expand-pill" :aria-expanded="true" @click="toggleExpand">
        <Icon name="images" :size="13" :stroke="1.8" />
        <span>收起</span>
      </button>
    </template>
  </div>
</template>
