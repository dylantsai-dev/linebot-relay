<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { state, selectedSession, addFiles, removeFile, sendMessage, selectSession, limits, canCreate, cancelQueued, stopTurn, isAdmin, sidebarCollapsed, toggleSidebar, requestLink } from '../store'
import type { HistoryEntry } from '../lib/types'
import { copy } from '../lib/clipboard'
import { fileSize } from '../lib/format'
import MessageItem from './MessageItem.vue'
import LiveTurn from './LiveTurn.vue'
import Icon from './Icon.vue'
import CopyMenu from './CopyMenu.vue'

const emit = defineEmits<{ delete: [] }>()
const scroller = ref<HTMLElement>(), textarea = ref<HTMLTextAreaElement>(), fileInput = ref<HTMLInputElement>()
const textDrafts = new Map<string, string>()
const text = ref('')
const dragging = ref(false)
let dragDepth = 0

const pending = computed(() => state.pending.get(state.selected))
const drafts = computed(() => state.attachments.get(state.selected) || [])
const busy = computed(() => state.threadRunning || selectedSession.value?.status === 'running' || state.queue.some(e => e.status !== 'queued'))
const running = computed(() => !!pending.value || busy.value)
const queued = computed(() => state.queue.filter(e => e.status === 'queued'))
/** Show the mode switch whenever a new message would not start right away. */
const showMode = computed(() => busy.value || queued.value.length > 0)
const mode = computed(() => (showMode.value ? state.sendMode : 'queue'))

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
// Running / steered relay entries the thread history has not echoed yet (e.g. right after a refresh).
const inflight = computed<{ id: string; entry: HistoryEntry; steered: boolean }[]>(() => state.queue
  .filter(e => e.status !== 'queued')
  .filter(e => !state.history.some(h => h.role === 'user' && h.text === e.text && new Date(h.time || 0).getTime() >= Date.parse(e.created_at) - 2000))
  .filter(e => !(pending.value && pending.value.message === e.text))
  .map(e => ({ id: e.id, steered: e.status === 'steered', entry: { role: 'user' as const, text: e.text, source: e.source, time: e.created_at, attachments: e.attachments } })))
const elapsed = computed(() => (pending.value ? Math.max(0, Math.floor((state.now - pending.value.started) / 1000)) : 0))
const liveShown = computed(() => running.value && !!state.live?.items.length)
const liveElapsed = computed(() => (state.live?.startedAt ? Math.max(0, Math.floor((state.now - Date.parse(state.live.startedAt)) / 1000)) : undefined))

/* ---- scroll: stick to bottom only when already near it; never jump otherwise ---- */
let stick = true
watch([items, optimistic, running, inflight, () => state.live], () => { const el = scroller.value; if (el) stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }, { flush: 'pre' })
watch([items, optimistic, running, inflight, () => state.live], () => { const el = scroller.value; if (el && (stick || pending.value)) el.scrollTop = el.scrollHeight }, { flush: 'post' })

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
  const ok = await sendMessage(value, mode.value)
  if (!ok && state.selected === key && !text.value) { text.value = value; await nextTick(); grow() }
}
function onKey(e: KeyboardEvent) { if (e.key === 'Enter' && !e.isComposing && (!e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit() } }
// Paste any file (screenshots, copied files); clipboard images without a real name get one.
function onPaste(e: ClipboardEvent) {
  const pasted = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file')
  if (!pasted.length) return
  e.preventDefault()
  addFiles(pasted.map((item, i) => {
    const f = item.getAsFile()
    if (!f) return null
    if (f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name)) return f
    const ext = (f.type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'
    return new File([f], `pasted-${Date.now()}${i ? `-${i}` : ''}.${ext}`, { type: f.type })
  }).filter((f): f is File => !!f))
}
// Admins withdraw anything; users only their own queued messages (the server enforces the same rule).
const canWithdraw = (q: { user: string | null }) => isAdmin.value || (!!q.user && q.user === state.me?.user?.username)
const queueTitle = (e: { mode: string; fallback?: string; user: string | null; source: string }) =>
  [e.fallback === 'steer_rejected' ? '引导被拒绝，已改为队首排队' : e.mode === 'steer' ? '引导' : '排队', e.user ? `来自 ${e.user}` : e.source].join(' · ')
function onPick() { if (fileInput.value?.files) addFiles(fileInput.value.files); if (fileInput.value) fileInput.value.value = '' }
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files')
function dragEnter(e: DragEvent) { if (!hasFiles(e) || !state.selected) return; e.preventDefault(); dragDepth++; dragging.value = true }
function dragOver(e: DragEvent) { if (hasFiles(e) && state.selected) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy' } }
function dragLeave() { if (--dragDepth <= 0) { dragDepth = 0; dragging.value = false } }
function drop(e: DragEvent) { e.preventDefault(); dragDepth = 0; dragging.value = false; if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files) }
const retry = () => selectSession(state.selected)
/** No history yet: Claude-style centred greeting with the composer right under it. */
const fresh = computed(() => !!state.selected && !state.historyLoading && !state.historyError && !items.value.length && !optimistic.value && !running.value && !inflight.value.length)
const greeting = computed(() => { const h = new Date(state.now || Date.now()).getHours(); return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好' })
const who = computed(() => state.me?.user?.username || '')
const menuAnchor = ref<HTMLElement | null>(null)
function toggleCopyMenu(e: MouseEvent) { const el = e.currentTarget as HTMLElement; menuAnchor.value = menuAnchor.value === el ? null : el }
function closeCopyMenu(focus: boolean) { const a = menuAnchor.value; menuAnchor.value = null; if (focus) a?.focus({ preventScroll: true }) }
const sendLabel = computed(() => (showMode.value ? (mode.value === 'steer' ? '引导当前回合' : '排队发送') : '发送') + ' (Enter)')
</script>
<template>
  <section class="chat" :class="{ dragging, fresh }" @dragenter="dragEnter" @dragover="dragOver" @dragleave="dragLeave" @drop="drop">
    <header class="chat-head">
      <button class="btn ghost icon-only bar-toggle" :class="{ show: sidebarCollapsed }" data-tip="展开侧边栏" aria-label="展开侧边栏" :aria-expanded="state.drawer" @click="toggleSidebar"><Icon name="panel-open" /></button>
      <template v-if="state.selected">
        <div class="chat-title">
          <span class="title-key" :title="state.selected">{{ state.selected }}</span>
          <button v-if="selectedSession?.codex_session_id" class="id-pill mono" data-tip="复制 Codex 会话 ID" @click="copy(selectedSession.codex_session_id!)"><span>{{ selectedSession.codex_session_id }}</span><Icon name="copy" :size="11" /></button>
          <span v-else class="id-pill mono muted">{{ selectedSession?.draft ? '首条消息后创建' : '未绑定' }}</span>
        </div>
        <span class="spacer" />
        <Transition name="fade"><span v-if="running" class="status-pill" :class="{ live: state.streaming }" :data-tip="state.streaming ? '通过 SSE 实时推送' : '正在运行'"><span class="dot running" />运行中<template v-if="state.streaming"> · 实时</template></span></Transition>
        <span v-if="queued.length" class="src-pill" data-tip="当前回合结束后依次发送"><Icon name="clock" :size="12" />排队 {{ queued.length }}</span>
        <span v-if="state.historySource === 'local'" class="src-pill" data-tip="Codex App 未连接，显示中继本地记录">本地记录</span>
        <button v-if="busy && !selectedSession?.draft" class="btn sm stop-btn" data-tip="停止当前回合（turn/interrupt）" :disabled="state.stopping" @click="stopTurn"><span v-if="state.stopping" class="spinner sm" /><Icon v-else name="stop" :size="12" :stroke="2.4" />{{ state.stopping ? '停止中…' : '停止' }}</button>
        <button class="btn ghost icon-only" data-tip="复制 Webhook / curl" aria-label="复制 Webhook" aria-haspopup="menu" :aria-expanded="!!menuAnchor" @click="toggleCopyMenu"><Icon name="webhook" /></button>
        <button v-if="canCreate" class="btn ghost icon-only danger-hover" data-tip="删除会话" aria-label="删除会话" @click="emit('delete')"><Icon name="trash" /></button>
      </template>
      <span v-else class="spacer" />
    </header>
    <CopyMenu :anchor="menuAnchor" :session-key="state.selected" @close="closeCopyMenu" />

    <div ref="scroller" class="messages">
      <div class="messages-inner">
        <div v-if="!state.selected" class="welcome">
          <div class="welcome-mark"><Icon name="sparkles" :size="26" :stroke="1.5" /></div>
          <h1 class="display">{{ greeting }}<template v-if="who">，{{ who }}</template></h1>
          <p class="muted">从左侧选择一个会话继续对话{{ canCreate ? '，或关联一个 Codex 会话' : '' }}。</p>
          <div class="welcome-actions">
            <button class="btn only-mobile" @click="state.drawer = true"><Icon name="menu" :size="14" />打开会话列表</button>
            <button v-if="canCreate" class="btn primary" @click="requestLink"><Icon name="link" :size="14" />关联会话</button>
          </div>
        </div>
        <template v-else>
          <div v-if="state.historyLoading && !items.length" class="msg-skeleton">
            <div v-for="i in 3" :key="i" class="sk-msg" :class="{ right: i === 2 }"><span class="sk w30" /><span class="sk w90" /><span class="sk w70" /></div>
          </div>
          <div v-else-if="state.historyError && !items.length" class="state-box big error">
            <div class="state-icon"><Icon name="alert" :size="20" /></div>
            <strong>加载失败</strong><span>{{ state.historyError }}</span>
            <button class="btn sm" @click="retry"><Icon name="refresh" :size="13" />重试</button>
          </div>
          <div v-else-if="fresh" class="welcome compact">
            <div class="welcome-mark"><Icon name="sparkles" :size="24" :stroke="1.5" /></div>
            <h1 class="display">{{ greeting }}<template v-if="who">，{{ who }}</template></h1>
            <p class="muted">消息会进入 <span class="mono">{{ state.selected }}</span> 对应的 Codex 会话。</p>
          </div>
          <MessageItem v-for="item in items" :key="item.key" :entry="item.entry" />
          <div v-for="f in inflight" :key="'q-' + f.id" class="inflight" :class="{ steered: f.steered }">
            <MessageItem :entry="f.entry" optimistic />
            <span v-if="f.steered" class="inflight-tag"><Icon name="steer" :size="11" />已引导到当前回合</span>
          </div>
          <MessageItem v-if="optimistic" key="__optimistic" :entry="optimistic" optimistic />
          <LiveTurn v-if="liveShown" :turn="state.live" :elapsed="pending ? elapsed : liveElapsed" />
          <Transition name="fade">
            <div v-if="running && !liveShown" class="thinking">
              <span class="spark"><Icon name="sparkles" :size="16" :stroke="1.6" /></span>
              <span>思考中<span class="dots"><i /><i /><i /></span><template v-if="pending"> {{ elapsed }}s</template></span>
            </div>
          </Transition>
        </template>
      </div>
    </div>

    <form v-if="state.selected" class="composer" @submit.prevent="submit" @paste="onPaste">
      <div class="composer-card" :class="{ steer: showMode && mode === 'steer' }">
        <TransitionGroup v-if="queued.length" tag="ul" name="list" class="queue-list" aria-label="排队中的消息">
          <li v-for="(q, i) in queued" :key="q.id" class="queue-row" :title="queueTitle(q)">
            <Icon name="clock" :size="13" /><span class="queue-pos">{{ i + 1 }}</span>
            <span class="queue-text">{{ q.text }}</span>
            <span v-if="q.attachments.length" class="queue-meta"><Icon name="paperclip" :size="11" />{{ q.attachments.length }}</span>
            <span v-if="q.fallback === 'steer_rejected'" class="queue-meta warn">引导未生效</span>
            <span v-if="q.user" class="queue-meta">{{ q.user }}</span>
            <button v-if="canWithdraw(q)" type="button" class="chip-x" :aria-label="`撤回排队消息 ${i + 1}`" data-tip="撤回（尚未发送）" @click="cancelQueued(q.id)"><Icon name="x" :size="12" /></button>
          </li>
        </TransitionGroup>
        <TransitionGroup v-if="drafts.length" tag="div" name="list" class="draft-files">
          <span v-for="f in drafts" :key="f.id" class="chip draft" :title="f.name">
            <img v-if="f.preview" :src="f.preview" alt=""><span v-else class="chip-icon"><Icon name="file-text" :size="15" /></span>
            <span class="chip-text"><span class="chip-name">{{ f.name }}</span><span class="chip-size">{{ fileSize(f.size) }}</span></span>
            <button type="button" class="chip-x" :aria-label="`移除 ${f.name}`" data-tip="移除" @click="removeFile(state.selected, f.id)"><Icon name="x" :size="12" /></button>
          </span>
        </TransitionGroup>
        <textarea ref="textarea" v-model="text" rows="1" aria-label="消息" :placeholder="showMode ? (mode === 'steer' ? '补充说明，插入正在运行的回合…' : '排队，当前回合结束后发送…') : '给 Codex 发消息…'" @input="grow" @keydown="onKey" />
        <div class="composer-tools">
          <input ref="fileInput" type="file" multiple hidden @change="onPick">
          <button type="button" class="tool-btn" :data-tip="`添加附件 · 任意类型，最多 ${limits.files} 个，每个 ≤ ${fileSize(limits.fileBytes)}`" aria-label="添加附件" :disabled="drafts.length >= limits.files" @click="fileInput?.click()"><Icon name="plus" :size="17" /></button>
          <span v-if="drafts.length" class="tool-count">{{ drafts.length }}/{{ limits.files }}</span>
          <Transition name="fade">
            <div v-if="showMode" class="mode-switch" role="radiogroup" aria-label="发送方式">
              <button type="button" role="radio" :aria-checked="state.sendMode === 'queue'" :class="{ on: state.sendMode === 'queue' }" data-tip="排队：当前回合结束后自动发送，发送前可撤回" @click="state.sendMode = 'queue'"><Icon name="queue" :size="13" />排队</button>
              <button type="button" role="radio" :aria-checked="state.sendMode === 'steer'" :class="{ on: state.sendMode === 'steer' }" data-tip="引导：插入正在运行的回合（turn/steer）" @click="state.sendMode = 'steer'"><Icon name="steer" :size="13" />引导</button>
            </div>
          </Transition>
          <span class="spacer" />
          <button class="send" :data-tip="sendLabel" :aria-label="sendLabel" :disabled="!!pending || (!text.trim() && !drafts.length)"><span v-if="pending" class="spinner sm inv" /><Icon v-else :name="mode === 'steer' ? 'steer' : 'send'" :size="16" :stroke="2.2" /></button>
        </div>
      </div>
      <div class="hint"><span><kbd class="kbd">Enter</kbd> {{ showMode ? (mode === 'steer' ? '引导' : '排队') : '发送' }} · <kbd class="kbd">Shift</kbd>+<kbd class="kbd">Enter</kbd> 换行</span><span class="hint-files">可粘贴或拖入任意文件 · 单个 ≤ {{ fileSize(limits.fileBytes) }}</span></div>
    </form>
    <Transition name="fade">
      <div v-if="dragging" class="drop-overlay"><div class="drop-card"><Icon name="upload" :size="26" /><strong>松开以添加附件</strong><span>任意类型 · 最多 {{ limits.files }} 个</span></div></div>
    </Transition>
  </section>
</template>
