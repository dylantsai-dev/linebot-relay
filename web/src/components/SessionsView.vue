<script setup lang="ts">
import { ref, computed } from 'vue'
import { state, keyPattern, createSession, deleteSession, toast, isAdmin, listCodexThreads, linkSession } from '../store'
import type { CodexThread } from '../lib/types'
import { time } from '../lib/format'
import SessionList from './SessionList.vue'
import ChatView from './ChatView.vue'
import Icon from './Icon.vue'

const newDialog = ref<HTMLDialogElement>(), deleteDialog = ref<HTMLDialogElement>(), keyInput = ref<HTMLInputElement>()
const newKey = ref(''), newId = ref(''), deleting = ref(false), toDelete = ref('')
// The sidebar links existing Codex sessions: "link" is the primary path; "blank" starts a new thread on first send.
const mode = ref<'link' | 'blank'>('link')
const idPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const threads = ref<CodexThread[]>([]), nextCursor = ref<string | null>(null), loadingThreads = ref(false), threadsError = ref('')
const query = ref(''), linkError = ref(''), linking = ref(false)
let searchTimer: number | undefined, searchSeq = 0

const relative = (iso: string | null) => {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  return s < 60 ? '刚刚' : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : s < 86400 * 30 ? `${Math.floor(s / 86400)} 天前` : time(iso).slice(0, 10)
}
const shortCwd = (cwd: string | null) => (cwd ? cwd.replace(/^\/root(?=\/|$)/, '~') : '')
const selectedThread = computed(() => threads.value.find(t => t.id === newId.value))
const canSubmit = computed(() => keyPattern.test(newKey.value) && (mode.value === 'blank' || !isAdmin.value || idPattern.test(newId.value)) && !linking.value)

async function loadThreads(more = false) {
  const seq = ++searchSeq
  loadingThreads.value = true; threadsError.value = ''
  try {
    const data = await listCodexThreads(query.value.trim(), more ? nextCursor.value || '' : '')
    if (seq !== searchSeq) return
    threads.value = more ? [...threads.value, ...data.threads] : data.threads
    nextCursor.value = data.next_cursor
  } catch (e) { if (seq === searchSeq) threadsError.value = (e as Error).message }
  finally { if (seq === searchSeq) loadingThreads.value = false }
}
function onSearch() { clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void loadThreads(), 300) }
function pick(thread: CodexThread) {
  newId.value = thread.id; linkError.value = ''
  if (!newKey.value) newKey.value = suggestKey(thread)
}
function suggestKey(thread: CodexThread) {
  const base = (thread.title || '').normalize('NFKD').replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase()
  return base && keyPattern.test(base) ? base : `codex-${thread.id.slice(-8)}`
}
function openNew() {
  newKey.value = ''; newId.value = ''; query.value = ''; linkError.value = ''
  mode.value = isAdmin.value ? 'link' : 'blank'
  newDialog.value?.showModal(); setTimeout(() => keyInput.value?.focus())
  if (isAdmin.value) void loadThreads()
}
async function create() {
  if (!canSubmit.value) return
  if (mode.value === 'blank' || !isAdmin.value) { newDialog.value?.close(); createSession(newKey.value, null); return }
  linking.value = true; linkError.value = ''
  try {
    await linkSession(newKey.value, newId.value)
    newDialog.value?.close()
    toast('已关联 Codex 会话', true)
  } catch (e) { linkError.value = (e as Error).message }
  finally { linking.value = false }
}
function openDelete() { toDelete.value = state.selected; deleteDialog.value?.showModal() }
async function confirmDelete() {
  deleting.value = true
  try { await deleteSession(toDelete.value); deleteDialog.value?.close(); toast('会话已删除', true) }
  catch (e) { toast((e as Error).message) }
  finally { deleting.value = false }
}
</script>
<template>
  <div class="workspace">
    <Transition name="fade"><div v-if="state.drawer" class="backdrop only-mobile" @click="state.drawer = false" /></Transition>
    <SessionList @create="openNew" />
    <ChatView @delete="openDelete" />

    <dialog ref="newDialog" class="dialog new-dialog" @click.self="newDialog?.close()">
      <form @submit.prevent="create">
        <h2>新建会话</h2>
        <div v-if="isAdmin" class="seg" role="tablist">
          <button type="button" role="tab" :aria-selected="mode === 'link'" :class="{ on: mode === 'link' }" @click="mode = 'link'"><Icon name="link" :size="13" />关联已有 Codex 会话</button>
          <button type="button" role="tab" :aria-selected="mode === 'blank'" :class="{ on: mode === 'blank' }" @click="mode = 'blank'"><Icon name="plus" :size="13" />新建空白会话</button>
        </div>

        <template v-if="isAdmin && mode === 'link'">
          <div class="picker-search">
            <Icon name="search" :size="13" />
            <input v-model="query" class="input" placeholder="搜索 Codex 会话（标题 / 内容）" autocomplete="off" @input="onSearch">
            <button type="button" class="btn ghost icon-only sm" title="刷新" aria-label="刷新" @click="loadThreads()"><Icon name="refresh" :size="13" /></button>
          </div>
          <div class="picker" role="listbox" aria-label="Codex 会话">
            <div v-if="threadsError" class="picker-empty error">{{ threadsError }}</div>
            <div v-else-if="loadingThreads && !threads.length" class="picker-empty"><span class="spinner sm" /> 读取 Codex 会话…</div>
            <div v-else-if="!threads.length" class="picker-empty">没有找到 Codex 会话</div>
            <button v-for="t in threads" :key="t.id" type="button" role="option" class="thread-row" :aria-selected="newId === t.id" :class="{ on: newId === t.id }" @click="pick(t)" @dblclick="pick(t); create()">
              <span class="t-main">
                <span class="t-title">{{ t.title }}</span>
                <span class="t-time">{{ relative(t.updated_at) }}</span>
              </span>
              <span v-if="t.preview && t.preview !== t.title" class="t-preview">{{ t.preview }}</span>
              <span class="t-meta mono">
                <span v-if="t.cwd" class="t-cwd" :title="t.cwd">{{ shortCwd(t.cwd) }}</span>
                <span v-if="t.status === 'active'" class="t-badge run">运行中</span>
                <span v-for="k in t.linked" :key="k" class="t-badge" :title="`已被会话 ${k} 关联`">↔ {{ k }}</span>
              </span>
            </button>
            <button v-if="nextCursor" type="button" class="btn sm picker-more" :disabled="loadingThreads" @click="loadThreads(true)">{{ loadingThreads ? '加载中…' : '加载更多' }}</button>
          </div>
          <label class="field-label" for="new-id">Codex 会话 ID</label>
          <input id="new-id" v-model.trim="newId" class="input mono" autocomplete="off" placeholder="从上面选择，或粘贴会话 ID（UUID）" @input="linkError = ''">
          <small class="field-hint" :class="{ error: (newId && !idPattern.test(newId)) || linkError }">{{ linkError || (newId && !idPattern.test(newId) ? 'Codex 会话 ID 应为 UUID，例如 01a1a610-8626-7623-aba8-66d060441079' : selectedThread ? `将关联：${selectedThread.title}` : '服务端会校验该会话在 Codex 中确实存在。') }}</small>
        </template>
        <small v-else-if="isAdmin" class="field-hint blank-hint">新建空白 Codex 会话：发送首条消息时才会在 Codex 中创建新线程。</small>

        <label class="field-label" for="new-key">会话 key</label>
        <input id="new-key" ref="keyInput" v-model.trim="newKey" class="input mono" maxlength="128" autocomplete="off" placeholder="例如 line:U123">
        <small class="field-hint" :class="{ error: newKey && !keyPattern.test(newKey) }">1–128 个字符，仅限 A–Z a–z 0–9 _ . : -</small>
        <small v-if="!isAdmin" class="field-hint">发送第一条消息后创建，并自动授权给你。</small>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="newDialog?.close()">取消</button>
          <button class="btn primary" :disabled="!canSubmit">{{ linking ? '校验中…' : isAdmin && mode === 'link' ? '关联' : '创建' }}</button>
        </div>
      </form>
    </dialog>

    <dialog ref="deleteDialog" class="dialog" @click.self="deleteDialog?.close()">
      <h2>删除会话</h2>
      <p class="mono del-key">{{ toDelete }}</p>
      <p class="muted">只删除会话映射和消息历史，Codex 文件和工作目录会保留。此操作无法撤销。</p>
      <div class="dialog-actions">
        <button class="btn" @click="deleteDialog?.close()">取消</button>
        <button class="btn danger-solid" :disabled="deleting" @click="confirmDelete">{{ deleting ? '删除中…' : '删除' }}</button>
      </div>
    </dialog>
  </div>
</template>
