import { reactive, ref, computed, watch } from 'vue'
import type { Session, HistoryEntry, HistoryResponse, PendingSend, DraftFile, Stats, RequestRow } from './lib/types'

export const keyPattern = /^[A-Za-z0-9_.:-]{1,128}$/
export const MAX_FILES = 5
export const MAX_FILE_BYTES = 20 * 1024 * 1024
// Browsers normalize dot-only URL segments, even with a single percent encoding.
export const keyPath = (key: string) => (key === '.' || key === '..' ? key.replace(/\./g, '%252E') : encodeURIComponent(key))

type Tab = 'sessions' | 'logs' | 'docs'
export const state = reactive({
  token: '',
  authed: false,
  booting: true,
  tab: 'sessions' as Tab,
  sessions: [] as Session[],
  sessionsLoaded: false,
  sessionsError: '',
  selected: '',
  history: [] as HistoryEntry[],
  historyLoading: false,
  historyError: '',
  threadRunning: false,
  historySource: '' as '' | 'thread' | 'local',
  /** Local-only sessions created in the "新建会话" dialog: key -> optional codex id. */
  drafts: new Map<string, string | null>(),
  pending: new Map<string, PendingSend>(),
  attachments: new Map<string, DraftFile[]>(),
  drawer: false,
  now: Date.now(),
})

/* ---------- toast ---------- */
export const toastState = reactive({ text: '', ok: false, visible: false, id: 0 })
let toastTimer: number | undefined
export function toast(text: string, ok = false) {
  Object.assign(toastState, { text, ok, visible: true, id: toastState.id + 1 })
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toastState.visible = false), 3200)
}

/* ---------- theme ---------- */
const media = matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(media.matches)
media.addEventListener('change', e => (systemDark.value = e.matches))
const storedTheme = (() => { try { return localStorage.getItem('relay-theme') } catch { return null } })()
export const themeChoice = ref<'light' | 'dark' | ''>(storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : '')
export const isDark = computed(() => (themeChoice.value || (systemDark.value ? 'dark' : 'light')) === 'dark')
watch(themeChoice, value => {
  if (value) document.documentElement.dataset.theme = value
  else delete document.documentElement.dataset.theme
  try { value ? localStorage.setItem('relay-theme', value) : localStorage.removeItem('relay-theme') } catch { /* ignore */ }
}, { immediate: true })
export function toggleTheme() { themeChoice.value = isDark.value ? 'light' : 'dark' }

/* ---------- api ---------- */
let epoch = 0
export class ApiError extends Error { constructor(message: string, public status: number) { super(message) } }
export async function api<T = any>(route: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData
  const response = await fetch(route, { ...options, cache: 'no-store', headers: { ...(isForm || !options.body ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${state.token}` } })
  let data: any = {}
  try { data = await response.json() } catch { /* empty body */ }
  if (!response.ok) {
    if (response.status === 401 && state.authed) { logout(); toast('登录已失效，请重新输入 Token') }
    throw new ApiError(data.error || `请求失败 ${response.status}`, response.status)
  }
  return data as T
}

const TOKEN_KEY = 'relay-token'
function storageGet(store: Storage, key: string) { try { return store.getItem(key) } catch { return null } }
function clearTokens() { for (const store of [localStorage, sessionStorage]) try { store.removeItem(TOKEN_KEY) } catch { /* ignore */ } }

export async function login(value: string, remember: boolean) {
  state.token = value
  try {
    await api('/api/whoami')
  } catch (error) {
    clearTokens(); state.token = ''
    const e = error as ApiError
    throw new Error(e.status === 401 ? 'Token 不正确' : `连接失败：${e.message}`)
  }
  clearTokens()
  try { (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, value) } catch { toast('浏览器未允许保存 Token') }
  state.authed = true
  epoch++
  await refreshSessions().catch(e => { state.sessionsError = e.message })
  startPolling()
}

export function logout() {
  epoch++
  stopPolling()
  for (const key of [...state.attachments.keys()]) discardAttachments(key)
  for (const job of state.pending.values()) for (const f of job.attachments) if (f.preview) URL.revokeObjectURL(f.preview)
  revokeBlobs()
  clearTokens()
  Object.assign(state, { token: '', authed: false, sessions: [], sessionsLoaded: false, sessionsError: '', selected: '', history: [], threadRunning: false, historyError: '', drawer: false })
  state.drafts.clear(); state.pending.clear()
  historySig = ''
}

export async function restoreLogin() {
  const saved = storageGet(localStorage, TOKEN_KEY) || storageGet(sessionStorage, TOKEN_KEY)
  if (saved) await login(saved, !!storageGet(localStorage, TOKEN_KEY)).catch(() => {})
  state.booting = false
}

/* ---------- sessions ---------- */
export const allSessions = computed<Session[]>(() => [
  ...state.sessions,
  ...[...state.drafts.keys()].filter(key => !state.sessions.some(s => s.key === key))
    .map(key => ({ key, messages: 0, status: 'idle' as const, queued: 0, codex_session_id: state.drafts.get(key) || null, draft: true })),
])
export const selectedSession = computed(() => allSessions.value.find(s => s.key === state.selected))

let sessionsSig = ''
export async function refreshSessions() {
  const own = epoch
  const data = await api<{ sessions: Session[] }>('/api/sessions')
  if (own !== epoch) return
  state.sessionsLoaded = true
  state.sessionsError = ''
  const sig = JSON.stringify(data.sessions)
  if (sig !== sessionsSig) { sessionsSig = sig; state.sessions = data.sessions }
}

export async function selectSession(key: string) {
  if (state.selected !== key) {
    state.selected = key
    state.history = []
    state.threadRunning = false
    state.historyError = ''
    historySig = ''
  }
  state.drawer = false
  state.historyLoading = true
  await refreshHistory(key).catch(e => { state.historyError = e.message })
  if (state.selected === key) state.historyLoading = false
}

let historySig = ''
export async function refreshHistory(key: string) {
  const own = epoch
  const data = await api<HistoryResponse>(`/api/sessions/${keyPath(key)}/history?limit=200`)
  if (state.selected !== key || own !== epoch) return
  state.historyError = ''
  state.historySource = data.source
  // Diff by signature: identical polls leave reactive state (and the DOM) untouched.
  const sig = JSON.stringify([data.history, !!data.running])
  if (sig === historySig) return
  historySig = sig
  state.history = data.history
  state.threadRunning = !!data.running
}

export function createSession(key: string, codexId: string | null) {
  if (!state.sessions.some(s => s.key === key)) state.drafts.set(key, codexId)
  void selectSession(key)
}

export async function deleteSession(key: string) {
  if (state.sessions.some(s => s.key === key) || state.pending.has(key)) await api(`/api/sessions/${keyPath(key)}`, { method: 'DELETE' })
  state.drafts.delete(key)
  discardAttachments(key)
  if (state.selected === key) { state.selected = ''; state.history = []; state.threadRunning = false; historySig = '' }
  await refreshSessions()
}

/* ---------- attachments ---------- */
let fileId = 0
export function addFiles(files: Iterable<File>) {
  const key = state.selected
  if (!key) { toast('请先选择会话'); return }
  const entries = [...(state.attachments.get(key) || [])]
  for (const file of files) {
    if (entries.length >= MAX_FILES) { toast(`最多添加 ${MAX_FILES} 个文件`); break }
    if (file.size > MAX_FILE_BYTES) { toast(`${file.name} 超过 20 MiB`); continue }
    const image = /^image\/(png|jpeg|gif|webp)$/.test(file.type)
    entries.push({ id: ++fileId, file, name: file.name, size: file.size, mime: file.type, kind: image ? 'image' : 'file', preview: image ? URL.createObjectURL(file) : null })
  }
  state.attachments.set(key, entries)
}
export function removeFile(key: string, id: number) {
  const entries = state.attachments.get(key) || []
  const entry = entries.find(e => e.id === id)
  if (entry?.preview) URL.revokeObjectURL(entry.preview)
  state.attachments.set(key, entries.filter(e => e.id !== id))
}
export function discardAttachments(key: string) {
  for (const entry of state.attachments.get(key) || []) if (entry.preview) URL.revokeObjectURL(entry.preview)
  state.attachments.delete(key)
}

const blobs = new Map<string, Promise<string>>()
export function attachmentBlob(path: string): Promise<string> {
  if (!blobs.has(path)) {
    const own = epoch
    const job = fetch(`/api/files?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${state.token}` } }).then(async response => {
      if (!response.ok) throw new Error(`附件读取失败 ${response.status}`)
      const blob = await response.blob()
      if (own !== epoch) throw new Error('登录已失效')
      return URL.createObjectURL(blob)
    })
    blobs.set(path, job)
    job.catch(() => { if (blobs.get(path) === job) blobs.delete(path) })
  }
  return blobs.get(path)!
}
function revokeBlobs() { for (const job of blobs.values()) job.then(url => URL.revokeObjectURL(url)).catch(() => {}); blobs.clear() }

/* ---------- send ---------- */
export async function sendMessage(text: string): Promise<boolean> {
  const key = state.selected
  const files = state.attachments.get(key) || []
  if (!key || (!text.trim() && !files.length) || state.pending.has(key)) return false
  const own = epoch
  const body: Record<string, string> = { session: key, message: text }
  const draftId = state.drafts.get(key)
  if (draftId) body.codex_session_id = draftId
  let payload: string | FormData = JSON.stringify(body)
  if (files.length) {
    payload = new FormData()
    for (const [k, v] of Object.entries(body)) payload.append(k, v)
    for (const entry of files) payload.append('file', entry.file, entry.name)
  }
  state.pending.set(key, { message: text.trim() ? text : '请查看附件。', attachments: files, started: Date.now() })
  state.attachments.delete(key)
  let restored = false, ok = false
  try {
    await api('/api/send', { method: 'POST', body: payload })
    if (own !== epoch) return true
    state.drafts.delete(key)
    ok = true
  } catch (error) {
    if (own === epoch) {
      toast((error as Error).message)
      if (files.length) { state.attachments.set(key, [...files, ...(state.attachments.get(key) || [])]); restored = true }
    }
  } finally {
    if (own === epoch) {
      state.pending.delete(key)
      if (!restored) files.forEach(f => f.preview && URL.revokeObjectURL(f.preview))
      historySig = ''
      await refreshSessions().catch(e => toast(e.message))
      if (state.selected === key) await refreshHistory(key).catch(() => {})
    }
  }
  return ok
}

/* ---------- logs ---------- */
export const logs = reactive({ stats: null as Stats | null, requests: [] as RequestRow[], loaded: false, loading: false, error: '', auto: true })
export async function refreshLogs() {
  const own = epoch
  logs.loading = true
  try {
    const [stats, data] = await Promise.all([api<Stats>('/api/stats'), api<{ requests: RequestRow[] }>('/api/requests?limit=100')])
    if (own !== epoch) return
    logs.stats = stats; logs.requests = data.requests; logs.loaded = true; logs.error = ''
  } catch (error) { if (own === epoch) logs.error = (error as Error).message }
  finally { logs.loading = false }
}

/* ---------- polling: sessions 5s, history 3s, pending clock 1s ---------- */
const timers: number[] = []
function startPolling() {
  stopPolling()
  timers.push(window.setInterval(() => {
    if (document.hidden) return
    refreshSessions().catch(e => (state.sessionsError = e.message))
    if (state.tab === 'logs' && logs.auto) void refreshLogs()
  }, 5000))
  timers.push(window.setInterval(() => {
    if (state.token && state.selected && !document.hidden) refreshHistory(state.selected).catch(e => (state.historyError = e.message))
  }, 3000))
  timers.push(window.setInterval(() => { if (state.pending.size && !document.hidden) state.now = Date.now() }, 1000))
}
function stopPolling() { while (timers.length) clearInterval(timers.pop()) }
