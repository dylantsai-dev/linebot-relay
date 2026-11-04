<script setup lang="ts">
import { computed } from 'vue'
import type { HistoryEntry } from '../lib/types'
import { renderMarkdown } from '../lib/markdown'
import { time, duration } from '../lib/format'
import { copy } from '../lib/clipboard'
import { state } from '../store'
import AttachmentList from './AttachmentList.vue'
import Icon from './Icon.vue'

const props = defineProps<{ entry: HistoryEntry; optimistic?: boolean }>()
const html = computed(() => renderMarkdown(props.entry.text))
const who = computed(() => (props.entry.role === 'user' ? '你' : props.entry.role === 'error' ? '错误' : 'Codex'))
const source = computed(() => (props.entry.role !== 'user' ? '' : props.entry.source === 'app' ? 'App' : props.entry.source || ''))
const meta = computed(() => (props.entry.time ? time(props.entry.time).slice(11) : '') + (props.entry.duration_ms !== undefined ? ` · ${duration(props.entry.duration_ms)}` : ''))

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
const withCopy = computed(() => html.value.replaceAll('<div class="code-block">', '<div class="code-block"><button type="button" class="code-copy" title="复制代码" aria-label="复制代码">复制</button>'))
</script>
<template>
  <article class="msg" :class="[entry.role, { optimistic }]">
    <div class="msg-meta">
      <span class="avatar" :class="entry.role"><Icon v-if="entry.role === 'assistant'" name="logo" :size="11" /><Icon v-else-if="entry.role === 'error'" name="alert" :size="11" /><Icon v-else name="user" :size="11" /></span>
      <span class="who">{{ who }}</span>
      <span v-if="source" class="badge" :class="{ app: source === 'App' }">{{ source }}</span>
      <span class="meta mono">{{ optimistic ? '发送中…' : meta }}</span>
      <button v-if="entry.role !== 'error' && entry.text" type="button" class="msg-copy" title="复制消息" aria-label="复制消息" @click="copy(entry.text)"><Icon name="copy" :size="12" /></button>
    </div>
    <div v-if="entry.text" class="msg-body md" @click="onClick" v-html="withCopy" />
    <div v-if="entry.images?.length" class="gen-images">
      <button v-for="(img, i) in entry.images" :key="img.url" type="button" class="gen-image" :title="img.prompt || img.name" @click="state.lightbox = { src: img.url, alt: img.prompt || img.name || `图片 ${i + 1}` }">
        <img :src="img.url" :alt="img.prompt || img.name || '图片'" loading="lazy" decoding="async" referrerpolicy="no-referrer">
      </button>
    </div>
    <AttachmentList v-if="entry.attachments?.length" :files="entry.attachments" />
  </article>
</template>
