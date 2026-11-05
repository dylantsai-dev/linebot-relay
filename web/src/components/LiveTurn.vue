<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { LiveItem, LiveTurn } from '../lib/types'
import { renderMarkdown, splitBlocks } from '../lib/markdown'
import { workedFor } from '../lib/format'
import Icon from './Icon.vue'
import ImageStack from './ImageStack.vue'
import TurnSteps from './TurnSteps.vue'

// The in-progress turn, laid out exactly like the finished message (head, rule, steps, answer,
// actions row) so the swap to history at the end moves nothing.
const props = defineProps<{ turn: LiveTurn | null; elapsed?: number }>()
const items = computed(() => props.turn?.items || [])
const texts = computed(() => items.value.filter(i => i.kind === 'text'))
const answer = computed<LiveItem | null>(() => {
  const final = texts.value.find(i => i.phase === 'final_answer')
  if (final) return final
  // Older servers send no phase: treat the last un-phased message as the answer.
  const last = texts.value.at(-1)
  return last && !last.phase ? last : null
})
const steps = computed(() => items.value.filter(i => i !== answer.value && ['text', 'command', 'tool', 'search', 'file'].includes(i.kind) && (i.kind !== 'text' || !!i.text?.trim())))
const images = computed(() => items.value.filter(i => i.kind === 'image' && i.url))
const stackImages = computed(() => images.value.map(img => ({ src: img.url!, alt: img.title || '生成的图片', title: img.title || '生成的图片' })))
const head = computed(() => {
  const t = props.elapsed !== undefined ? ` ${workedFor(props.elapsed)}` : ''
  if (answer.value?.text) return `正在输出${t}`
  const busy = [...steps.value].reverse().find(s => s.kind !== 'text' && !s.done)
  return `${busy ? '正在工作' : '正在思考'}${t}`
})
const open = ref(true)

// Typewriter: reveal the answer at a steady per-frame pace that speeds up with the backlog.
const target = computed(() => answer.value?.text || '')
const shown = ref(target.value.length)
let raf = 0, answerId = answer.value?.id
function tick() {
  raf = 0
  const total = target.value.length
  if (shown.value >= total) { shown.value = total; return }
  let next = Math.min(total, shown.value + Math.max(1, Math.ceil((total - shown.value) / 10)))
  const code = target.value.charCodeAt(next - 1)
  if (code >= 0xd800 && code <= 0xdbff && next < total) next++
  shown.value = next
  if (next < total) raf = requestAnimationFrame(tick)
}
watch(() => answer.value?.id, id => { if (id !== answerId) { answerId = id; shown.value = 0 } })
watch(target, () => { if (!raf) raf = requestAnimationFrame(tick) }, { immediate: true })
onBeforeUnmount(() => cancelAnimationFrame(raf))
const blocks = computed(() => {
  const parts = splitBlocks(target.value.slice(0, shown.value))
  return parts.map((b, i) => renderMarkdown(b, i === parts.length - 1))
})
</script>
<template>
  <article class="msg assistant live-turn" aria-live="polite">
    <div class="msg-main">
      <button type="button" class="turn-head" :disabled="!steps.length" :aria-expanded="open" @click="open = !open">
        <span class="shimmer">{{ head }}</span><Icon v-if="steps.length" name="chevron" :size="13" class="turn-chev" :class="{ open }" />
      </button>
      <div class="turn-rule" />
      <div class="turn-steps" :class="{ open: open && steps.length }"><div><TurnSteps v-if="steps.length" :steps="steps" live /></div></div>
      <div v-if="blocks.length" class="msg-body md streaming"><div v-for="(b, i) in blocks" :key="i" class="md-block" v-html="b" /></div>
      <ImageStack v-if="stackImages.length" :images="stackImages" />
      <div class="msg-actions" aria-hidden="true" />
    </div>
  </article>
</template>
