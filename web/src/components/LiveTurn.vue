<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { LiveTurn } from '../lib/types'
import { renderMarkdown, splitBlocks } from '../lib/markdown'
import { state } from '../store'
import Icon from './Icon.vue'

// The in-progress turn: activity lines (commands, tools, searches, edits), the streaming answer
// rendered progressively, and a typing indicator. Deltas are already throttled by the store.
const props = defineProps<{ turn: LiveTurn | null; elapsed?: number }>()
const items = computed(() => props.turn?.items || [])
const answer = computed(() => {
  const texts = items.value.filter(i => i.kind === 'text' && i.text)
  return texts.find(i => i.phase === 'final_answer') || texts.at(-1) || null
})
const commentary = computed(() => items.value.filter(i => i.kind === 'text' && i.text && i !== answer.value).slice(-3))
const activity = computed(() => items.value.filter(i => ['command', 'tool', 'search', 'file', 'reasoning', 'plan'].includes(i.kind)).slice(-6))
const images = computed(() => items.value.filter(i => i.kind === 'image' && i.url))
// Typewriter: reveal the answer at a steady per-frame pace that speeds up with the backlog, so
// ~10-character network chunks become smooth character-by-character output.
const target = computed(() => answer.value?.text || '')
const shown = ref(target.value.length) // joined mid-turn: show what exists, animate only new text
let raf = 0, answerId = answer.value?.id
function tick() {
  raf = 0
  const total = target.value.length
  if (shown.value >= total) { shown.value = total; return }
  let next = Math.min(total, shown.value + Math.max(1, Math.ceil((total - shown.value) / 10)))
  const code = target.value.charCodeAt(next - 1)
  if (code >= 0xd800 && code <= 0xdbff && next < total) next++ // never split a surrogate pair
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
const html = computed(() => blocks.value.length > 0)
const label = (kind: string) => ({ command: '命令', tool: '工具', search: '搜索', file: '修改', reasoning: '思考', plan: '计划' } as Record<string, string>)[kind] || kind
const icon = (kind: string) => ({ command: 'terminal', file: 'file-code', search: 'search', tool: 'braces', reasoning: 'sparkles', plan: 'queue' } as Record<string, string>)[kind] || 'activity'
const line = (i: any) => (i.kind === 'reasoning' || i.kind === 'plan' ? (i.text || '').replace(/\s+/g, ' ').replace(/\*\*/g, '').trim().slice(-140) : i.title || '')
const tail = (text?: string) => (text || '').trimEnd().split('\n').slice(-3).join('\n')
const zoom = (src: string) => (state.lightbox = { src, alt: '生成的图片' })
</script>
<template>
  <article class="msg assistant live-turn" aria-live="polite">
    <div class="msg-avatar assistant working" aria-hidden="true"><Icon name="sparkles" :size="15" :stroke="1.6" /></div>
    <div class="msg-main">
      <ul v-if="activity.length || commentary.length" class="activity">
        <li v-for="c in commentary" :key="c.id" class="act commentary">{{ (c.text || '').replace(/\s+/g, ' ').slice(0, 200) }}</li>
        <li v-for="a in activity" :key="a.id" class="act" :class="[a.kind, { done: a.done, failed: a.status === 'failed' || (a.exitCode ?? 0) !== 0 }]">
          <span class="act-icon"><Icon :name="icon(a.kind)" :size="13" /></span>
          <span class="act-kind">{{ label(a.kind) }}</span>
          <code class="act-title">{{ line(a) || '…' }}</code>
          <span class="act-state"><template v-if="!a.done"><span class="spinner xs" />运行中</template><template v-else-if="a.exitCode != null && a.exitCode !== 0">退出 {{ a.exitCode }}</template><Icon v-else name="check" :size="13" /></span>
          <pre v-if="a.kind === 'command' && a.output && !a.done" class="act-output">{{ tail(a.output) }}</pre>
        </li>
      </ul>
      <div v-if="html" class="msg-body md streaming"><div v-for="(b, i) in blocks" :key="i" class="md-block" v-html="b" /></div>
      <div v-if="images.length" class="gen-images">
        <button v-for="img in images" :key="img.id" type="button" class="gen-image" @click="zoom(img.url!)"><img :src="img.url" alt="生成的图片" loading="lazy" referrerpolicy="no-referrer"></button>
      </div>
      <div class="typing"><span>{{ html ? '输出中' : activity.length ? '工作中' : '思考中' }}</span><span class="dots"><i /><i /><i /></span><span v-if="elapsed !== undefined" class="mono">{{ elapsed }}s</span><span class="badge live">实时</span></div>
    </div>
  </article>
</template>
