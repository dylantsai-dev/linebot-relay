<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { state, selectedSession, addFiles, removeFile, sendMessage, selectSession, MAX_FILES, canCreate } from '../store'
import type { HistoryEntry } from '../lib/types'
import { copy } from '../lib/clipboard'
import { fileSize } from '../lib/format'
import MessageItem from './MessageItem.vue'
import Icon from './Icon.vue'

const emit = defineEmits<{ delete: [] }>()
const scroller = ref<HTMLElement>(), textarea = ref<HTMLTextAreaElement>(), fileInput = ref<HTMLInputElement>()
const textDrafts = new Map<string, string>()
const text = ref('')
const dragging = ref(false)
let dragDepth = 0

const pending = computed(() => state.pending.get(state.selected))
const drafts = computed(() => state.attachments.get(state.selected) || [])
const running = computed(() => !!pending.value || state.threadRunning || selectedSession.value?.status === 'running')

// Stable keys so unchanged messages are never re-rendered between polls.
const items = computed(() => {
  const seen = new Map<string, number>()
  return state.history.map(entry => {
    const base = `${entry.role}|${entry.time || ''}|${entry.source || ''}|${entry.text.length}|${entry.text.slice(0, 64)}`
    const n = seen.get(base) || 0
    seen.set(base, n + 1)
    return { key: `${base}#${n}`, entry }
  })
})
const optimistic = computed<HistoryEntry | null>(() => {
  const p = pending.value
  if (!p) return null
  const echoed = state.history.some(e => e.role === 'user' && e.text === p.message && new Date(e.time || 0).getTime() >= p.started - 1000)
  return echoed ? null : { role: 'user', text: p.message, source: 'console', attachments: p.attachments.map(f => ({ name: f.name, size: f.size, kind: f.kind, preview: f.preview })) }
})
const elapsed = computed(() => (pending.value ? Math.max(0, Math.floor((state.now - pending.value.started) / 1000)) : 0))

/* ---- scroll: stick to bottom only when already near it; never jump otherwise ---- */
let stick = true
watch([items, optimistic, running], () => { const el = scroller.value; if (el) stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }, { flush: 'pre' })
watch([items, optimistic, running], () => { const el = scroller.value; if (el && (stick || pending.value)) el.scrollTop = el.scrollHeight }, { flush: 'post' })

watch(() => state.selected, async (key, prev) => {
  if (prev !== undefined) textDrafts.set(prev, text.value)
  text.value = textDrafts.get(key) || ''
  stick = true
  await nextTick(); grow()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  if (key && matchMedia('(min-width: 768px)').matches) textarea.value?.focus({ preventScroll: true })
}, { immediate: true })

function grow() { const t = textarea.value; if (!t) return; t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 220)}px` }
async function submit() {
  const key = state.selected, value = text.value
  if (!key || pending.value || (!value.trim() && !drafts.value.length)) return
  text.value = ''; textDrafts.delete(key); await nextTick(); grow()
  stick = true
  const ok = await sendMessage(value)
  if (!ok && state.selected === key && !text.value) { text.value = value; await nextTick(); grow() }
}
function onKey(e: KeyboardEvent) { if (e.key === 'Enter' && !e.isComposing && (!e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit() } }
function onPaste(e: ClipboardEvent) {
  const images = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/'))
  if (!images.length) return
  e.preventDefault()
  addFiles(images.map((item, i) => { const f = item.getAsFile(); return f ? new File([f], `pasted-${Date.now()}${i ? `-${i}` : ''}.png`, { type: f.type }) : null }).filter((f): f is File => !!f))
}
function onPick() { if (fileInput.value?.files) addFiles(fileInput.value.files); if (fileInput.value) fileInput.value.value = '' }
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files')
function dragEnter(e: DragEvent) { if (!hasFiles(e) || !state.selected) return; e.preventDefault(); dragDepth++; dragging.value = true }
function dragOver(e: DragEvent) { if (hasFiles(e) && state.selected) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy' } }
function dragLeave() { if (--dragDepth <= 0) { dragDepth = 0; dragging.value = false } }
function drop(e: DragEvent) { e.preventDefault(); dragDepth = 0; dragging.value = false; if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files) }
const retry = () => selectSession(state.selected)
</script>
<template>
  <section class="chat" :class="{ dragging }" @dragenter="dragEnter" @dragover="dragOver" @dragleave="dragLeave" @drop="drop">
    <div class="chat-head">
      <button class="btn ghost icon-only only-mobile" aria-label="会话列表" :aria-expanded="state.drawer" @click="state.drawer = true"><Icon name="menu" /></button>
      <template v-if="state.selected">
        <div class="chat-title">
          <span class="title-key">{{ state.selected }}</span>
          <button v-if="selectedSession?.codex_session_id" class="id-pill mono" title="复制 Codex 会话 ID" @click="copy(selectedSession.codex_session_id!)">{{ selectedSession.codex_session_id }}<Icon name="copy" :size="11" /></button>
          <span v-else class="id-pill mono muted">{{ selectedSession?.draft ? '首条消息后创建' : '未绑定' }}</span>
        </div>
        <span class="spacer" />
        <Transition name="fade"><span v-if="running" class="status-pill"><span class="dot running" />运行中</span></Transition>
        <span v-if="state.historySource === 'local'" class="src-pill" title="Codex App 未连接，显示中继本地记录">本地记录</span>
        <button v-if="canCreate" class="btn ghost icon-only" title="删除会话" aria-label="删除会话" @click="emit('delete')"><Icon name="trash" /></button>
      </template>
      <span v-else class="chat-title placeholder">未选择会话</span>
    </div>

    <div ref="scroller" class="messages">
      <div class="messages-inner">
        <div v-if="!state.selected" class="state-box big">
          <div class="state-icon"><Icon name="chat" :size="20" /></div>
          <strong>选择一个会话</strong>
          <span>从左侧列表打开会话，或新建一个。</span>
          <button class="btn sm only-mobile" @click="state.drawer = true">打开会话列表</button>
        </div>
        <template v-else>
          <div v-if="state.historyLoading && !items.length" class="msg-skeleton">
            <div v-for="i in 3" :key="i" class="sk-msg"><span class="sk w30" /><span class="sk w90" /><span class="sk w70" /></div>
          </div>
          <div v-else-if="state.historyError && !items.length" class="state-box big error">
            <div class="state-icon"><Icon name="alert" :size="20" /></div>
            <strong>加载失败</strong><span>{{ state.historyError }}</span>
            <button class="btn sm" @click="retry">重试</button>
          </div>
          <div v-else-if="!items.length && !optimistic && !running" class="state-box big">
            <div class="state-icon"><Icon name="send" :size="20" /></div>
            <strong>开始对话</strong><span>发送第一条消息，消息会进入该 key 对应的 Codex 会话。</span>
          </div>
          <MessageItem v-for="item in items" :key="item.key" :entry="item.entry" />
          <MessageItem v-if="optimistic" key="__optimistic" :entry="optimistic" optimistic />
          <Transition name="fade">
            <div v-if="running" class="thinking">
              <span class="avatar assistant"><Icon name="logo" :size="11" /></span>
              <span class="dots"><i /><i /><i /></span>
              <span>思考中…<template v-if="pending"> {{ elapsed }}s</template></span>
            </div>
          </Transition>
        </template>
      </div>
    </div>

    <form v-if="state.selected" class="composer" @submit.prevent="submit" @paste="onPaste">
      <TransitionGroup v-if="drafts.length" tag="div" name="list" class="draft-files">
        <span v-for="f in drafts" :key="f.id" class="chip draft">
          <img v-if="f.preview" :src="f.preview" alt=""><Icon v-else name="file" :size="14" />
          <span class="chip-name">{{ f.name }}</span><span class="chip-size">{{ fileSize(f.size) }}</span>
          <button type="button" class="chip-x" :aria-label="`移除 ${f.name}`" @click="removeFile(state.selected, f.id)"><Icon name="x" :size="12" /></button>
        </span>
      </TransitionGroup>
      <div class="composer-box">
        <input ref="fileInput" type="file" multiple hidden @change="onPick">
        <button type="button" class="btn ghost icon-only" :title="`添加附件（最多 ${MAX_FILES} 个，每个 20 MiB）`" aria-label="添加附件" :disabled="drafts.length >= MAX_FILES" @click="fileInput?.click()"><Icon name="paperclip" /></button>
        <textarea ref="textarea" v-model="text" rows="1" aria-label="消息" placeholder="发送消息…" @input="grow" @keydown="onKey" />
        <button class="btn primary icon-only send" title="发送" aria-label="发送" :disabled="!!pending || (!text.trim() && !drafts.length)"><span v-if="pending" class="spinner sm inv" /><Icon v-else name="send" /></button>
      </div>
      <div class="hint"><span>Enter 发送 · Shift+Enter 换行</span><span>可粘贴或拖入文件 · {{ drafts.length }}/{{ MAX_FILES }}</span></div>
    </form>
    <Transition name="fade">
      <div v-if="dragging" class="drop-overlay"><Icon name="upload" :size="22" /><span>松开以添加附件</span></div>
    </Transition>
  </section>
</template>
