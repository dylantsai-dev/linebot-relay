<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { state, keyPattern, deleteSession, toast, isAdmin, listCodexThreads, linkSession } from '../store'
import type { CodexThread } from '../lib/types'
import { time } from '../lib/format'
import ChatView from './ChatView.vue'
import Icon from './Icon.vue'

const newDialog = ref<HTMLDialogElement>(), deleteDialog = ref<HTMLDialogElement>(), keyInput = ref<HTMLInputElement>()
const newKey = ref(''), newId = ref(''), deleting = ref(false), toDelete = ref('')
// The console never creates Codex threads: the admin can only link an existing thread.
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
const canSubmit = computed(() => isAdmin.value && keyPattern.test(newKey.value) && idPattern.test(newId.value) && !linking.value)

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
  if (!newKey.value || newKey.value === autoKey) newKey.value = autoKey = suggestKey(thread)
}
// Suggest a key from the thread's working directory name (e.g. work/<key>), else codex-<id tail>.
// Titles are usually Chinese prose, so they make poor keys.
let autoKey = ''
function suggestKey(thread: CodexThread) {
  const taken = new Set(state.sessions.map(s => s.key))
  const base = (thread.cwd || '').split('/').filter(Boolean).pop() || ''
  if (base && keyPattern.test(base) && !taken.has(base) && !/^(root|home|tmp|codex|work)$/i.test(base)) return base
  return `codex-${thread.id.slice(-8)}`
}
function openNew() {
  newKey.value = ''; autoKey = ''; newId.value = ''; query.value = ''; linkError.value = ''
  if (!isAdmin.value) return
  newDialog.value?.showModal(); setTimeout(() => keyInput.value?.focus())
  void loadThreads()
}
watch(() => state.linkRequest, () => openNew())
async function create() {
  if (!canSubmit.value) return
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
    <ChatView @delete="openDelete" />

    <dialog ref="newDialog" class="dialog new-dialog" @click.self="newDialog?.close()">
      <form @submit.prevent="create">
        <div class="dialog-head">
          <h2><span class="title-icon"><Icon name="link" :size="16" /></span>关联 Codex 会话</h2>
          <button type="button" class="btn ghost icon-only sm" aria-label="关闭" data-tip="关闭 (Esc)" @click="newDialog?.close()"><Icon name="x" :size="15" /></button>
        </div>
        <p class="muted dialog-sub">选择 Codex 里已有的对话，再给它起一个 key。外部系统通过 key 把消息投递进来。</p>

        <template v-if="isAdmin">
          <div class="picker-search">
            <Icon name="search" :size="13" />
            <input v-model="query" class="input" placeholder="搜索 Codex 会话（标题 / 内容）" autocomplete="off" @input="onSearch">
            <button type="button" class="btn ghost icon-only sm" data-tip="刷新列表" aria-label="刷新" @click="loadThreads()"><Icon name="refresh" :size="13" /></button>
          </div>
          <div class="picker" role="listbox" aria-label="Codex 会话">
            <div v-if="threadsError" class="picker-empty error">{{ threadsError }}</div>
            <div v-else-if="loadingThreads && !threads.length" class="picker-empty"><span class="spinner sm" /> 读取 Codex 会话…</div>
            <div v-else-if="!threads.length" class="picker-empty"><Icon name="inbox" :size="20" />没有找到 Codex 会话</div>
            <button v-for="t in threads" :key="t.id" type="button" role="option" class="thread-row" :aria-selected="newId === t.id" :class="{ on: newId === t.id }" @click="pick(t)" @dblclick="pick(t); create()">
              <span class="t-main">
                <span class="t-title">{{ t.title }}</span>
                <span class="t-time">{{ relative(t.updated_at) }}</span>
              </span>
              <span v-if="t.preview && t.preview !== t.title" class="t-preview">{{ t.preview }}</span>
              <span class="t-meta mono">
                <span v-if="t.cwd" class="t-cwd" :title="t.cwd"><Icon name="terminal" :size="11" />{{ shortCwd(t.cwd) }}</span>
                <span v-if="t.status === 'active'" class="t-badge run"><span class="dot running" />运行中</span>
                <span v-for="k in t.linked" :key="k" class="t-badge" :title="`已被会话 ${k} 关联`"><Icon name="link" :size="10" />{{ k }}</span>
              </span>
            </button>
            <button v-if="nextCursor" type="button" class="btn sm picker-more" :disabled="loadingThreads" @click="loadThreads(true)">{{ loadingThreads ? '加载中…' : '加载更多' }}</button>
          </div>
          <label class="field-label" for="new-id">Codex 会话 ID</label>
          <input id="new-id" v-model.trim="newId" class="input mono" autocomplete="off" placeholder="从上面选择，或粘贴会话 ID（UUID）" @input="linkError = ''">
          <small class="field-hint" :class="{ error: (newId && !idPattern.test(newId)) || linkError }">{{ linkError || (newId && !idPattern.test(newId) ? 'Codex 会话 ID 应为 UUID，例如 01a1a610-8626-7623-aba8-66d060441079' : selectedThread ? `将关联：${selectedThread.title}` : '服务端会校验该会话在 Codex 中确实存在。') }}</small>
        </template>

        <label class="field-label" for="new-key">会话 key</label>
        <input id="new-key" ref="keyInput" v-model.trim="newKey" class="input mono" maxlength="128" autocomplete="off" placeholder="例如 line:U123">
        <small class="field-hint" :class="{ error: newKey && !keyPattern.test(newKey) }">1–128 个字符，仅限 A–Z a–z 0–9 _ . : -</small>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="newDialog?.close()">取消</button>
          <button class="btn primary" :disabled="!canSubmit"><span v-if="linking" class="spinner sm inv" /><Icon v-else name="link" :size="14" />{{ linking ? '校验中…' : '关联会话' }}</button>
        </div>
      </form>
    </dialog>

    <dialog ref="deleteDialog" class="dialog" @click.self="deleteDialog?.close()">
      <div class="dialog-head">
        <h2><span class="title-icon danger"><Icon name="trash" :size="16" /></span>删除会话</h2>
        <button type="button" class="btn ghost icon-only sm" aria-label="关闭" data-tip="关闭 (Esc)" @click="deleteDialog?.close()"><Icon name="x" :size="15" /></button>
      </div>
      <p class="mono del-key">{{ toDelete }}</p>
      <p class="muted">只删除会话映射和消息历史，Codex 文件和工作目录会保留。此操作无法撤销。</p>
      <div class="dialog-actions">
        <button class="btn" @click="deleteDialog?.close()">取消</button>
        <button class="btn danger-solid" :disabled="deleting" @click="confirmDelete"><span v-if="deleting" class="spinner sm inv" />{{ deleting ? '删除中…' : '删除' }}</button>
      </div>
    </dialog>
  </div>
</template>
