<script setup lang="ts">
import { computed, ref } from 'vue'
import type { HistoryEntry } from '../lib/types'
import { renderMarkdown, renderPlain } from '../lib/markdown'
import { time, workedFor } from '../lib/format'
import { copy } from '../lib/clipboard'
import { state } from '../store'
import AttachmentList from './AttachmentList.vue'
import Icon from './Icon.vue'
import TurnSteps from './TurnSteps.vue'

const props = defineProps<{ entry: HistoryEntry; optimistic?: boolean }>()
const steps = computed(() => props.entry.steps || [])
const worked = computed(() => (props.entry.role === 'assistant' && props.entry.duration_ms !== undefined ? workedFor(props.entry.duration_ms / 1000) : ''))
const open = ref(true)
const copied = ref(false)
async function copyText() { await copy(props.entry.text); copied.value = true; setTimeout(() => (copied.value = false), 1400) }
const html = computed(() => {
  // User (and error) bubbles stay plain: pasted Markdown docs were blowing past the bubble via headings/pre/tables.
  if (props.entry.role === 'user' || props.entry.role === 'error') return renderPlain(props.entry.text)
  return renderMarkdown(props.entry.text)
})

// Copy buttons for fenced code blocks, via delegation (no per-render DOM work).
function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  // Images inside the reply open in the lightbox.
  if (target.tagName === 'IMG' && target.classList.contains('md-img')) {
    e.preventDefault()
    state.lightbox = { src: (target as HTMLImageElement).src, alt: target.getAttribute('alt') || '图片' }
    return
  }
  const btn = target.closest('.code-copy')
  if (!btn) return
  const pre = btn.parentElement?.querySelector('pre')
  if (pre) void copy(pre.innerText)
}
const withCopy = computed(() => {
  if (props.entry.role === 'user' || props.entry.role === 'error') return html.value
  return html.value.replaceAll('<div class="code-block">', '<div class="code-block"><button type="button" class="code-copy" aria-label="复制代码">复制</button>')
})
</script>
<template>
  <article class="msg" :class="[entry.role, { optimistic }]" :data-role="entry.role" :data-message-id="entry.message_id || undefined">
    <div class="msg-main">
      <template v-if="entry.role === 'assistant' && (worked || steps.length)">
        <button type="button" class="turn-head" :disabled="!steps.length" :aria-expanded="open" @click="open = !open">
          <span>{{ worked ? `用时 ${worked}` : '处理过程' }}</span><Icon v-if="steps.length" name="chevron" :size="13" class="turn-chev" :class="{ open }" />
        </button>
        <div class="turn-rule" />
        <div class="turn-steps" :class="{ open: open && steps.length }"><div><TurnSteps v-if="steps.length" :steps="steps" /></div></div>
      </template>
      <div v-if="entry.text" class="msg-body" :class="{ md: entry.role === 'assistant' }" data-cite-source="1" @click="onClick" v-html="withCopy" />
      <div v-if="entry.images?.length" class="gen-images">
        <button v-for="(img, i) in entry.images" :key="img.url" type="button" class="gen-image" :title="img.prompt || img.name" @click="state.lightbox = { src: img.url, alt: img.prompt || img.name || `图片 ${i + 1}` }">
          <img :src="img.url" :alt="img.prompt || img.name || '图片'" loading="lazy" decoding="async" referrerpolicy="no-referrer">
        </button>
      </div>
      <AttachmentList v-if="entry.attachments?.length" :files="entry.attachments" />
      <div class="msg-actions">
        <button v-if="entry.role !== 'error' && entry.text" type="button" class="act-btn" :data-tip="copied ? '已复制' : '复制'" aria-label="复制消息" @click="copyText"><Icon :name="copied ? 'check' : 'copy'" :size="14" :stroke="1.6" /></button>
        <span class="act-meta">{{ entry.time && !optimistic ? time(entry.time).slice(11, 16) : '' }}</span>
      </div>
    </div>
  </article>
</template>
