<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { state, selectedSession, addFiles, removeFile, sendMessage, selectSession, limits, canCreate, cancelQueued, steerQueued, stopTurn, isAdmin, sidebarCollapsed, toggleSidebar, requestLink, editSession, openWebhook, toast, loadOlder } from '../store'
import SessionAvatar from './SessionAvatar.vue'
import type { HistoryEntry } from '../lib/types'
import { copy } from '../lib/clipboard'
import { fileSize } from '../lib/format'
import MessageItem from './MessageItem.vue'
import LiveTurn from './LiveTurn.vue'
import PromptCard from './PromptCard.vue'
import Icon from './Icon.vue'
import ModelPicker from './ModelPicker.vue'
import AccessPicker from './AccessPicker.vue'

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
// Codex-style: a message sent while a turn runs always queues; the queue card's 引导 button steers it.
const mode = computed(() => 'queue' as const)

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
// A relay entry is already in the thread history when a user message with the same text shows up after it was
// sent — or, for a steered entry, anywhere in the still-running turn: Codex stamps a steered message with the
// turn's start time, which is earlier than the moment it was steered in.
function echoedInHistory(e: { text: string; created_at: string; status: string }) {
  const since = Date.parse(e.created_at) - 2000
  const h = state.history
  if (h.some(x => x.role === 'user' && x.text.trim() === e.text.trim() && new Date(x.time || 0).getTime() >= since)) return true
  if (e.status !== 'steered') return false
  let i = h.length - 1
  while (i >= 0 && h[i].role !== 'assistant') i--
  return h.slice(i + 1).some(x => x.role === 'user' && x.text.trim() === e.text.trim())
}
// Running / steered relay entries the thread history has not echoed yet (e.g. right after a refresh).
const inflight = computed<{ id: string; entry: HistoryEntry; steered: boolean }[]>(() => state.queue
  .filter(e => e.status !== 'queued')
  .filter(e => !echoedInHistory(e))
  .filter(e => !(pending.value && pending.value.message === e.text))
  .map(e => ({ id: e.id, steered: e.status === 'steered', entry: { role: 'user' as const, text: e.text, source: e.source, time: e.created_at, attachments: e.attachments } })))
// Steered messages the thread already echoed: tag them in place (once) while their turn is still running.
const steeredKeys = computed(() => {
  const keys = new Set<string>()
  if (!liveShown.value) return keys
  const list = items.value
  for (let i = list.length - 1; i >= 0 && list[i].entry.role !== 'assistant'; i--) {
    if (list[i].entry.role === 'user' && list[i].entry.mode === 'steer') keys.add(list[i].key)
  }
  return keys
})
const elapsed = computed(() => (pending.value ? Math.max(0, Math.floor((state.now - pending.value.started) / 1000)) : 0))
// One placeholder for the whole turn (thinking -> working -> answer) so nothing swaps or remounts.
// threadRunning comes from the stream/history (authoritative); the sessions poll lags and would
// otherwise re-show a 思考中 placeholder under the finished answer for a few seconds.
const liveShown = computed(() => !!pending.value || !!state.live || state.threadRunning || state.queue.some(e => e.status === 'running'))
// One clock for the whole turn: from the send click (or the relay's start) until Codex reports its own start,
// so the 「正在思考 N秒」 head never drops its number while the request is being accepted.
const turnStart = ref(0)
watch(() => pending.value?.started, t => { if (t) turnStart.value = t })
watch(liveShown, shown => { if (!shown) turnStart.value = 0 })
const liveElapsed = computed(() => {
  const running = state.queue.find(e => e.status === 'running')
  const start = state.live?.startedAt ? Date.parse(state.live.startedAt) : turnStart.value || (running ? Date.parse(running.started_at || running.created_at) : 0)
  return start ? Math.max(0, Math.floor((state.now - start) / 1000)) : undefined
})

/* ---- scroll: stick to bottom only when already near it; never jump otherwise ---- */
let stick = true
// Older pages are prepended: keep the first visible message where it was instead of sticking or jumping.
let anchor: { el: Element; top: number } | null = null
const promptCount = computed(() => state.prompts.length)
watch([items, optimistic, running, inflight, () => state.live, promptCount], () => {
  const el = scroller.value; if (!el) return
  stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  anchor = null
  if (!stick) {
    const box = el.getBoundingClientRect()
    const first = [...el.querySelectorAll('.messages-inner > .msg, .messages-inner > .inflight')].find(m => m.getBoundingClientRect().bottom > box.top)
    if (first) anchor = { el: first, top: first.getBoundingClientRect().top }
  }
}, { flush: 'pre' })
watch([items, optimistic, running, inflight, () => state.live, promptCount], () => {
  const el = scroller.value; if (!el) return
  if (stick || pending.value) { el.scrollTop = el.scrollHeight; return }
  if (anchor && anchor.el.isConnected) el.scrollTop += anchor.el.getBoundingClientRect().top - anchor.top
  anchor = null
  void nextTick(fillViewport)
}, { flush: 'post' })
/* ---- pagination: near the top -> fetch the page before the oldest message ---- */
let quietUntil = 0
function onScroll() {
  const el = scroller.value
  if (!el || Date.now() < quietUntil || !state.hasMore || state.loadingOlder) return
  if (el.scrollTop < 80) void loadOlder()
}
// A short first page that does not fill the screen cannot be scrolled: load more until it does.
function fillViewport() {
  const el = scroller.value
  if (el && state.hasMore && !state.loadingOlder && items.value.length && el.scrollHeight <= el.clientHeight + 80) void loadOlder()
}
watch(() => state.hasMore, more => { if (more) void nextTick(fillViewport) })

watch(() => state.selected, async (key, prev) => {
  if (prev !== undefined) textDrafts.set(prev, text.value)
  text.value = textDrafts.get(key) || ''
  stick = true
  quietUntil = Date.now() + 600
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
  [e.fallback === 'steer_rejected' ? '引导被拒绝，已改为队首排队' : e.mode === 'steer' ? '引导' : '排队', e.user ? `来自 ${e.user}` : ''].filter(Boolean).join(' · ')
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
// Codex-style: while a turn runs and nothing is typed, the send button becomes the stop button.
const canStop = computed(() => (busy.value || !!pending.value) && !selectedSession.value?.draft && !text.value.trim() && !drafts.value.length)
// Switching sessions cross-fades the conversation: the old one fades out quickly, the new one (from cache when
// visited before, otherwise skeleton then content) fades in with a small rise, already scrolled to the bottom.
const viewKey = computed(() => !state.selected ? 'home' : `${state.selected}:${items.value.length || !state.historyLoading ? 'ready' : 'loading'}`)
function toBottom() { stick = true; const el = scroller.value; if (el) el.scrollTop = el.scrollHeight }
const sendLabel = computed(() => (busy.value ? '排队发送' : '发送') + ' (Enter)')
</script>
<template>
  <section class="chat" :class="{ dragging, fresh }" @dragenter="dragEnter" @dragover="dragOver" @dragleave="dragLeave" @drop="drop">
    <header class="chat-head">
      <button class="btn ghost icon-only bar-toggle" :class="{ show: sidebarCollapsed }" data-tip="展开侧边栏" aria-label="展开侧边栏" :aria-expanded="state.drawer" @click="toggleSidebar"><Icon name="panel-open" /></button>
      <template v-if="state.selected">
        <div class="chat-title">
          <SessionAvatar :session="selectedSession" :name="selectedSession?.name || state.selected" :size="22" />
          <span class="title-key" :title="state.selected">{{ selectedSession?.name || state.selected }}</span>
          <button v-if="selectedSession?.codex_session_id" class="id-pill mono" data-tip="复制会话 ID" @click="copy(selectedSession.codex_session_id!)"><span>{{ selectedSession.codex_session_id }}</span><Icon name="copy" :size="11" /></button>
          <span v-else class="id-pill mono muted">{{ selectedSession?.draft ? '首条消息后创建' : '未绑定' }}</span>
        </div>
        <span class="spacer" />
        <ModelPicker v-if="isAdmin && selectedSession && !selectedSession.draft" :session="selectedSession" :editable="true" />
        <span v-if="state.historySource === 'local'" class="src-pill" data-tip="ディランボット 三代目 未连接，显示本地记录">本地记录</span>
        <button v-if="canCreate && selectedSession && !selectedSession.draft" class="btn ghost icon-only" data-tip="Webhook" aria-label="Webhook" aria-haspopup="dialog" @click="openWebhook(selectedSession)"><Icon name="webhook" /></button>
        <button v-if="canCreate && selectedSession && !selectedSession.draft" class="btn ghost icon-only" data-tip="编辑名称和头像" aria-label="编辑会话" @click="editSession(selectedSession)"><Icon name="pencil" /></button>
        <button v-if="canCreate" class="btn ghost icon-only danger-hover" data-tip="删除会话" aria-label="删除会话" @click="emit('delete')"><Icon name="trash" /></button>
      </template>
      <span v-else class="spacer" />
    </header>

    <div ref="scroller" class="messages" @scroll.passive="onScroll">
      <Transition name="conv" mode="out-in" @enter="toBottom">
      <div :key="viewKey" class="messages-inner" :class="{ 'is-loading': viewKey.endsWith(':loading') }">
        <div v-if="!state.selected" class="welcome">
          <div class="welcome-mark"><Icon name="sparkles" :size="26" :stroke="1.5" /></div>
          <h1 class="display">{{ greeting }}<template v-if="who">，{{ who }}</template></h1>
          <p class="muted">从左侧选择一个会话继续对话{{ canCreate ? '，或关联一个会话' : '' }}。</p>
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
            <p class="muted">消息会进入 <span class="mono">{{ state.selected }}</span> 对应的会话。</p>
          </div>
          <div v-if="items.length && (state.hasMore || state.loadingOlder)" key="__older" class="older-row" aria-live="polite">
            <template v-if="state.loadingOlder"><Icon name="loader" :size="12" class="spin" />加载更早的消息…</template>
            <button v-else type="button" @click="loadOlder"><Icon name="chevron-up" :size="12" /> 加载更早的消息</button>
          </div>
          <template v-for="item in items" :key="item.key">
            <div v-if="steeredKeys.has(item.key)" class="inflight steered">
              <MessageItem :entry="item.entry" />
              <span class="inflight-tag"><Icon name="steer" :size="11" />已引导到当前回合</span>
            </div>
            <MessageItem v-else :entry="item.entry" />
          </template>
          <div v-for="f in inflight" :key="'q-' + f.id" class="inflight" :class="{ steered: f.steered }">
            <MessageItem :entry="f.entry" :optimistic="!f.steered" />
            <span v-if="f.steered" class="inflight-tag"><Icon name="steer" :size="11" />已引导到当前回合</span>
          </div>
          <MessageItem v-if="optimistic" key="__optimistic" :entry="optimistic" optimistic />
          <LiveTurn v-if="liveShown" :turn="state.live" :elapsed="liveElapsed" />
          <PromptCard v-for="p in state.prompts" :key="p.id" :prompt="p" />
        </template>
      </div>
      </Transition>
    </div>

    <form v-if="state.selected" class="composer" @submit.prevent="submit" @paste="onPaste">
      <TransitionGroup v-if="queued.length" tag="ul" name="list" class="queue-stack" aria-label="排队中的消息">
        <li v-for="(q, i) in queued" :key="q.id" class="queue-card" :title="queueTitle(q)">
          <Icon name="list-end" :size="15" class="queue-ico" />
          <span class="queue-text">{{ q.text || (q.attachments.length ? `${q.attachments.length} 个附件` : '') }}</span>
          <span v-if="q.attachments.length && q.text" class="queue-meta"><Icon name="paperclip" :size="11" />{{ q.attachments.length }}</span>
          <span v-if="q.fallback === 'steer_rejected'" class="queue-meta warn">引导未生效</span>
          <span v-if="q.user && q.user !== state.me?.user?.username" class="queue-meta">{{ q.user }}</span>
          <template v-if="canWithdraw(q)">
            <button v-if="busy" type="button" class="queue-act" data-tip="引导：插入正在运行的回合" @click="steerQueued(q.id)"><Icon name="steer-to" :size="14" />引导</button>
            <button type="button" class="queue-act icon" :aria-label="`撤回排队消息 ${i + 1}`" data-tip="撤回（尚未发送）" @click="cancelQueued(q.id)"><Icon name="trash" :size="14" /></button>
          </template>
        </li>
      </TransitionGroup>
      <div class="composer-card">
        <TransitionGroup v-if="drafts.length" tag="div" name="list" class="draft-files">
          <span v-for="f in drafts" :key="f.id" class="chip draft" :title="f.name">
            <img v-if="f.preview" :src="f.preview" alt=""><span v-else class="chip-icon"><Icon name="file-text" :size="15" /></span>
            <span class="chip-text"><span class="chip-name">{{ f.name }}</span><span class="chip-size">{{ fileSize(f.size) }}</span></span>
            <button type="button" class="chip-x" :aria-label="`移除 ${f.name}`" data-tip="移除" @click="removeFile(state.selected, f.id)"><Icon name="x" :size="12" /></button>
          </span>
        </TransitionGroup>
        <textarea ref="textarea" v-model="text" rows="1" aria-label="消息" placeholder="给三代目发消息…" @input="grow" @keydown="onKey" />
        <div class="composer-tools">
          <input ref="fileInput" type="file" multiple hidden @change="onPick">
          <button type="button" class="tool-btn" :data-tip="`添加附件 · 任意类型，最多 ${limits.files} 个，每个 ≤ ${fileSize(limits.fileBytes)}`" aria-label="添加附件" :disabled="drafts.length >= limits.files" @click="fileInput?.click()"><Icon name="plus" :size="17" /></button>
          <span v-if="drafts.length" class="tool-count">{{ drafts.length }}/{{ limits.files }}</span>
          <AccessPicker v-if="isAdmin && selectedSession && !selectedSession.draft" :session="selectedSession" />
          <span class="spacer" />
          <button v-if="canStop" key="stop" type="button" class="send stop" :data-tip="state.stopping ? '正在停止…' : '停止当前回合'" aria-label="停止当前回合" :disabled="state.stopping" @click="pending || stopTurn()"><span class="stop-square" /></button>
          <button v-else key="send" class="send" :data-tip="sendLabel" :aria-label="sendLabel" :disabled="!text.trim() && !drafts.length"><Icon name="send" :size="16" :stroke="2.2" /></button>
        </div>
      </div>
    </form>
    <Transition name="fade">
      <div v-if="dragging" class="drop-overlay"><div class="drop-card"><Icon name="upload" :size="26" /><strong>松开以添加附件</strong><span>任意类型 · 最多 {{ limits.files }} 个</span></div></div>
    </Transition>
  </section>
</template>
