import { reactive, ref, computed, watch } from 'vue'
import { fileSize } from './lib/format'
import type { UsageSnapshot,  Session, HistoryEntry, HistoryResponse, PendingSend, DraftFile, Stats, RequestRow, Me, User, LiveTurn, LiveItem, CodexThread, QueueEntry, SendMode, Prompt, FeishuSettings } from './lib/types'

export const keyPattern = /^[A-Za-z0-9_.:-]{1,128}$/
// Upload limits come from the server (/api/whoami); these are the fallbacks.
export const limits = computed(() => ({ files: state.me?.limits?.max_files || 10, fileBytes: state.me?.limits?.max_file_bytes || 50 * 1024 * 1024, totalBytes: state.me?.limits?.max_total_bytes || 100 * 1024 * 1024 }))
// Browsers normalize dot-only URL segments, even with a single percent encoding.
export const keyPath = (key: string) => (key === '.' || key === '..' ? key.replace(/\./g, '%252E') : encodeURIComponent(key))

type Tab = 'sessions' | 'logs' | 'docs' | 'users'
export const state = reactive({
  token: '',
  authed: false,
  me: null as Me | null,
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
  /** In-progress turn of the selected session (streamed deltas, or the history snapshot as fallback). */
  live: null as LiveTurn | null,
  streaming: false,
  lightbox: null as { src: string; alt: string } | null,
  /** Relay queue of the selected session (steered / running / queued messages). */
  queue: [] as QueueEntry[],
  /** Send mode while a turn is running: 排队 (default) or 引导. */
  sendMode: 'queue' as SendMode,
  stopping: false,
  /** Pending approval / question cards of the selected session. */
  prompts: [] as Prompt[],
  /** Older history exists above the loaded messages; loadOlder() fetches the next page. */
  hasMore: false,
  loadingOlder: false,
  /** Bumped to ask SessionsView to open the 关联会话 dialog (from the sidebar). */
  linkRequest: 0,
  /** Bumped to ask SessionsView to open the 删除会话 dialog (from the sidebar). */
  deleteRequest: 0,
  deleteKey: '',
})

/* ---------- sidebar (desktop collapse, persisted) ---------- */
export const sidebarCollapsed = ref((() => { try { return localStorage.getItem('relay-sidebar') === 'collapsed' } catch { return false } })())
watch(sidebarCollapsed, v => { try { v ? localStorage.setItem('relay-sidebar', 'collapsed') : localStorage.removeItem('relay-sidebar') } catch { /* ignore */ } })
export function toggleSidebar() {
  if (matchMedia('(max-width: 767px)').matches) state.drawer = !state.drawer
  else sidebarCollapsed.value = !sidebarCollapsed.value
}
export function requestLink() { state.tab = 'sessions'; state.drawer = false; state.linkRequest++ }
export function requestDelete(key: string) {
  if (!key) return
  state.deleteKey = key
  state.tab = 'sessions'
  state.drawer = false
  state.deleteRequest++
}

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
export async function api<T = any>(route: string, options: RequestInit = {}, auth = true): Promise<T> {
  const isForm = options.body instanceof FormData || options.body instanceof Blob
  const response = await fetch(route, { ...options, cache: 'no-store', headers: { ...(isForm || !options.body ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Authorization: `Bearer ${state.token}` } : {}) } })
  let data: any = {}
  try { data = await response.json() } catch { /* empty body */ }
  if (!response.ok) {
    if (response.status === 401 && state.authed && auth) { logout(false); toast('登录已失效，请重新登录') }
    throw new ApiError(data.error || `请求失败 ${response.status}`, response.status)
  }
  return data as T
}


export const FEISHU_ERRORS: Record<string, string> = {
  no_permission: '你的飞书账号不在本应用的可用范围内，请联系管理员添加',
  wrong_tenant: '非本企业飞书账号，无法登录',
  denied: '该飞书账号已被禁止登录',
  expired: '授权已过期，请重新登录',
  state: '登录请求无效或已过期，请重新点击「使用飞书登录」',
  cancelled: '你取消了飞书授权',
  tenant_unset: '企业校验尚未完成，请先由应用管理员登录一次',
  disabled: '飞书登录尚未配置',
  network: '连接飞书超时，请稍后重试',
  pkce: '飞书授权校验失败（PKCE），请重新点击「使用飞书登录」',
  redirect_mismatch: '回调地址与飞书应用配置不一致，请联系管理员',
  app_secret: '飞书应用凭证无效，请联系管理员',
  not_installed: '飞书应用未启用或未安装到本企业',
  user_invalid: '该飞书账号状态异常（已停用或不存在）',
  userinfo_failed: '已授权，但读取飞书用户信息失败，请重试',
  token_failed: '飞书授权换取失败，请重试',
  account_disabled: '账号已停用，请联系管理员',
}
export const FEISHU_ERROR_DEFAULT = '飞书登录失败，请稍后重试'
export const loginBanner = ref('')
export function clearLoginBanner() { loginBanner.value = '' }

const TOKEN_KEY = 'relay-token'
function storageGet(store: Storage, key: string) { try { return store.getItem(key) } catch { return null } }
function clearTokens() { for (const store of [localStorage, sessionStorage]) try { store.removeItem(TOKEN_KEY) } catch { /* ignore */ } }

/** Enter the console with a bearer token: the WEBHOOK_TOKEN (super-admin) or a user login token. */
export async function login(value: string, remember: boolean) {
  state.token = value
  let me: Me
  try {
    me = await api<Me>('/api/whoami')
  } catch (error) {
    clearTokens(); state.token = ''
    const e = error as ApiError
    throw new Error(e.status === 401 ? (value.startsWith('rs_') ? '登录已失效，请重新登录' : 'Token 不正确') : `连接失败：${e.message}`)
  }
  state.me = me
  if (state.tab === 'users' && me.role !== 'admin') state.tab = 'sessions'
  clearTokens()
  try { (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, value) } catch { toast('浏览器未允许保存 Token') }
  state.authed = true
  epoch++
  await refreshSessions().catch(e => { state.sessionsError = e.message })
  startPolling()
  // Reopen the session from the URL (#s=key) so a refresh lands back on the running turn.
  const linked = hashSession()
  if (linked && !state.selected && state.sessions.some(s => s.key === linked)) void selectSession(linked)
}
function hashSession() { try { return new URLSearchParams(location.hash.slice(1)).get('s') || '' } catch { return '' } }
function setHashSession(key: string) {
  try { history.replaceState(history.state, '', key ? `#s=${encodeURIComponent(key)}` : location.pathname + location.search) } catch { /* ignore */ }
}

export async function loginPassword(username: string, password: string, remember: boolean) {
  let data: { token: string }
  try { data = await api<{ token: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }, false) }
  catch (error) { const e = error as ApiError; throw new Error(e.status && e.status < 500 ? e.message : `连接失败：${e.message}`) }
  await login(data.token, remember)
}
export const isAdmin = computed(() => state.me?.role === 'admin')
// Only admins (and the access token) can create or delete sessions.
export const canCreate = computed(() => state.me?.role === 'admin')
export const rememberChoice = () => !!storageGet(localStorage, TOKEN_KEY)

/** Server-side logout revokes a user token; the webhook token cannot be revoked. */
export function logout(revoke = true) {
  if (revoke && state.me?.auth === 'user') void fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }).catch(() => {})
  users.list = []; users.loaded = false
  epoch++
  stopPolling()
  for (const key of [...state.attachments.keys()]) discardAttachments(key)
  for (const job of state.pending.values()) for (const f of job.attachments) if (f.preview) URL.revokeObjectURL(f.preview)
  revokeBlobs()
  clearTokens()
  stopStream()
  if (state.selected) setHashSession('')
  historyCache.clear()
  Object.assign(state, { token: '', authed: false, me: null, sessions: [], sessionsLoaded: false, sessionsError: '', selected: '', history: [], threadRunning: false, historyError: '', drawer: false, live: null, lightbox: null, queue: [], sendMode: 'queue', stopping: false, prompts: [], hasMore: false, loadingOlder: false })
  state.drafts.clear(); state.pending.clear()
  historySig = ''
}

export async function restoreLogin() {
  try {
    const url = new URL(location.href)
    const authToken = url.searchParams.get('auth_token')
    const feishuError = url.searchParams.get('feishu_error')
    if (authToken || feishuError !== null) {
      url.searchParams.delete('auth_token')
      url.searchParams.delete('feishu_error')
      const q = url.searchParams.toString()
      history.replaceState(history.state, '', url.pathname + (q ? `?${q}` : '') + url.hash)
    }
    if (feishuError) loginBanner.value = FEISHU_ERRORS[feishuError] || FEISHU_ERROR_DEFAULT
    if (authToken) {
      await login(authToken, true).catch((e: Error) => { loginBanner.value = e.message || FEISHU_ERROR_DEFAULT })
      state.booting = false
      return
    }
  } catch { /* ignore bad URL */ }
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

// Last history seen per session, so switching back shows it at once (then refreshes) instead of a skeleton.
const historyCache = new Map<string, { history: HistoryEntry[]; running: boolean; sig: string; hasMore: boolean; olderMore: boolean | null }>()
const HISTORY_PAGE = 50
const HISTORY_CACHE_MAX = 12
const HISTORY_KEEP_MAX = 400
function putHistoryCache(key: string, value: { history: HistoryEntry[]; running: boolean; sig: string; hasMore: boolean; olderMore: boolean | null }) {
  if (historyCache.has(key)) historyCache.delete(key)
  historyCache.set(key, value)
  while (historyCache.size > HISTORY_CACHE_MAX) {
    const oldest = historyCache.keys().next().value
    if (oldest === undefined) break
    historyCache.delete(oldest)
  }
}
/** has_more of the last older page fetched for the selected session (null: only the newest page is loaded). */
let olderMore: boolean | null = null
const timeOf = (entry?: HistoryEntry) => { const t = Date.parse(entry?.time || ''); return Number.isFinite(t) ? t : -Infinity }
export async function selectSession(key: string) {
  if (state.selected !== key) {
    const cached = historyCache.get(key)
    state.selected = key
    setHashSession(key)
    state.history = cached?.history || []
    state.threadRunning = cached?.running || false
    state.hasMore = cached?.hasMore || false
    state.loadingOlder = false
    state.prompts = []
    olderMore = cached?.olderMore ?? null
    state.historyError = ''
    // Drop the previous session's live buffer too (and its pending 100 ms commit): otherwise the old turn's
    // process / answer is painted back into this session, or this session's events append under it.
    setLive(null)
    state.queue = []
    state.sendMode = 'queue'
    historySig = cached?.sig || ''
    startStream(key)
  }
  state.drawer = false
  state.historyLoading = true
  await refreshHistory(key).catch(e => { state.historyError = e.message })
  if (state.selected === key) state.historyLoading = false
}
/** A draft session does not exist on the server yet; non-admins get 404 for it until the first send. */
function draftMissing(key: string, error: unknown) {
  return state.drafts.has(key) && (error as ApiError).status === 404
}

let historySig = ''
export async function refreshHistory(key: string) {
  const own = epoch
  let data: HistoryResponse
  try { data = await api<HistoryResponse>(`/api/sessions/${keyPath(key)}/history?limit=${HISTORY_PAGE}`) }
  catch (error) { if (draftMissing(key, error)) { data = { key, session: key, history: [], source: 'local', running: false } } else throw error }
  if (state.selected !== key || own !== epoch) return
  state.historyError = ''
  state.historySource = data.source
  setQueue(data.queue || [])
  setPrompts(data.prompts || [])
  // Polling fallback for the live turn when the stream is not connected.
  if (!state.streaming) setLive(data.running && data.live ? data.live : null)
  else if (!data.running && state.live && Date.now() - streamTouched > 5000) setLive(null)
  // Diff by signature: identical polls leave reactive state (and the DOM) untouched.
  const sig = JSON.stringify([data.history, !!data.running, !!data.has_more])
  if (sig === historySig) return
  historySig = sig
  // Keep older pages the user already scrolled up to: everything strictly older than the newest page,
  // as long as what is shown still overlaps it (otherwise there could be a gap; start over).
  const first = timeOf(data.history[0])
  const overlaps = data.history.length > 0 && state.history.some(e => timeOf(e) >= first)
  const kept = overlaps && olderMore !== null ? state.history.filter(e => timeOf(e) < first) : []
  if (!kept.length) olderMore = null
  state.history = kept.length ? [...kept, ...data.history] : data.history
  state.hasMore = olderMore ?? !!data.has_more
  state.threadRunning = !!data.running
  putHistoryCache(key, { history: state.history, running: !!data.running, sig, hasMore: state.hasMore, olderMore })
}
/** Fetch the page of history just before the oldest loaded message and prepend it. */
export async function loadOlder() {
  const key = state.selected, oldest = state.history[0]
  if (!key || !oldest?.time || !state.hasMore || state.loadingOlder) return
  const own = epoch
  state.loadingOlder = true
  try {
    const data = await api<HistoryResponse>(`/api/sessions/${keyPath(key)}/history?limit=${HISTORY_PAGE}&before=${encodeURIComponent(oldest.time)}`)
    if (state.selected !== key || own !== epoch || state.history[0] !== oldest) return
    const older = data.history.filter(e => timeOf(e) < timeOf(oldest))
    olderMore = !!data.has_more
    state.history = [...older, ...state.history]
    state.hasMore = olderMore
    const cached = historyCache.get(key)
    // Bound how much older history a single tab keeps (load-more can otherwise grow without limit).
    if (state.history.length > HISTORY_KEEP_MAX) {
      state.history = state.history.slice(-HISTORY_KEEP_MAX)
      state.hasMore = true
      olderMore = true
    }
    if (cached) putHistoryCache(key, { ...cached, history: state.history, hasMore: state.hasMore, olderMore })
  } catch (e) {
    if (state.selected === key) toast((e as Error).message || '加载失败')
  } finally {
    if (state.selected === key) state.loadingOlder = false
  }
}

/* ---------- approval / question cards ---------- */
let promptsSig = ''
/** Cards answered here: an in-flight poll must not bring them back. */
const answeredPrompts = new Set<string>()
const ANSWERED_PROMPTS_MAX = 200
function rememberAnswered(id: string) {
  answeredPrompts.add(id)
  if (answeredPrompts.size > ANSWERED_PROMPTS_MAX) {
    const drop = [...answeredPrompts].slice(0, answeredPrompts.size - ANSWERED_PROMPTS_MAX)
    for (const key of drop) answeredPrompts.delete(key)
  }
}
function setPrompts(prompts: Prompt[]) {
  prompts = prompts.filter(p => !answeredPrompts.has(p.id))
  const sig = JSON.stringify(prompts)
  if (sig === promptsSig && state.prompts.length === prompts.length) return
  promptsSig = sig
  state.prompts = prompts
}
function dropPrompt(id: string) {
  if (state.prompts.some(p => p.id === id)) setPrompts(state.prompts.filter(p => p.id !== id))
}
/** Answer a card: { decision } for approvals, { answers } for questions. Resolves true when it went through. */
export async function answerPrompt(id: string, body: { decision?: string; answers?: Record<string, string | string[]> }) {
  const key = state.selected
  if (!key) return false
  try {
    await api(`/api/sessions/${keyPath(key)}/prompts/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(body) })
    rememberAnswered(id)
    if (state.selected === key) dropPrompt(id)
    return true
  } catch (e) {
    const status = (e as ApiError).status
    if (status === 404 || status === 409) { rememberAnswered(id); if (state.selected === key) dropPrompt(id); toast('该请求已处理或已失效') }
    else toast((e as Error).message || '提交失败')
    return false
  }
}

/* ---------- Codex threads: the sidebar links existing Codex sessions ---------- */
export async function listCodexThreads(q = '', cursor = ''): Promise<{ threads: CodexThread[]; next_cursor: string | null }> {
  const params = new URLSearchParams({ limit: '40' })
  if (q) params.set('q', q)
  if (cursor) params.set('cursor', cursor)
  return api(`/api/codex/threads?${params}`)
}
/** Bind a key to an existing Codex thread (server verifies the thread exists). */
export async function linkSession(key: string, codexId: string) {
  await api(`/api/sessions/${keyPath(key)}`, { method: 'PUT', body: JSON.stringify({ codex_session_id: codexId }) })
  state.drafts.delete(key)
  await refreshSessions()
  historySig = ''
  if (state.selected === key) await refreshHistory(key).catch(() => {})
  else await selectSession(key)
}

/** Link many threads at once (全选关联): one PUT each, one sessions refresh, then open the first. */
export async function linkSessions(pairs: { key: string; id: string }[]) {
  const failed: { key: string; error: string }[] = []
  for (const { key, id } of pairs) {
    try { await api(`/api/sessions/${keyPath(key)}`, { method: 'PUT', body: JSON.stringify({ codex_session_id: id }) }); state.drafts.delete(key) }
    catch (e) { failed.push({ key, error: (e as Error).message }) }
  }
  await refreshSessions().catch(() => {})
  const first = pairs.find(p => !failed.some(f => f.key === p.key))
  if (first && state.selected !== first.key) await selectSession(first.key)
  return failed
}

/** The edit dialog registers its opener here so the sidebar and the header can both open it. */
let sessionEditor: ((s: Session) => void) | null = null
export function registerSessionEditor(fn: (s: Session) => void) { sessionEditor = fn }
export function editSession(s: Session) { sessionEditor?.(s) }
/** Display name: the admin-set name, else the key. */
export function sessionName(s?: Session | null, key = '') { return s?.name || s?.key || key }
function patchSession(updated: Session) {
  const i = state.sessions.findIndex(s => s.key === updated.key)
  if (i >= 0) state.sessions[i] = { ...state.sessions[i], name: updated.name, avatar_url: updated.avatar_url, paused: updated.paused, paused_at: updated.paused_at, model: updated.model, effort: updated.effort, service_tier: updated.service_tier }
}
export async function renameSession(key: string, name: string) {
  const data = await api<{ session: Session }>(`/api/sessions/${keyPath(key)}`, { method: 'PATCH', body: JSON.stringify({ name }) })
  patchSession(data.session)
}
/** Admin: pause (webhook messages are rejected with 「已暂停接收」) or resume receiving. */
export async function setSessionPaused(key: string, paused: boolean) {
  const data = await api<{ session: Session }>(`/api/sessions/${keyPath(key)}`, { method: 'PATCH', body: JSON.stringify({ paused }) })
  patchSession(data.session)
  toast(paused ? '已暂停接收，Webhook 消息会被拒绝' : '已恢复接收', true)
}
/** Admin: choose the model for this session (null = default). */
export async function setSessionModel(key: string, model: string | null) { return setSessionTuning(key, { model }) }
/** Admin: set model / effort / service_tier together (null clears a field). */
export async function setSessionTuning(key: string, patch: { model?: string | null; effort?: string | null; service_tier?: string | null; approval_mode?: import('./lib/types').ApprovalMode | null }, note = '已更新') {
  const data = await api<{ session: Session }>(`/api/sessions/${keyPath(key)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  patchSession(data.session)
  toast(note, true)
}
let modelsAt = 0
export const models = ref<import('./lib/types').ModelInfo[]>([])
/** Admin: available models, cached for a minute. */
export async function fetchModels(force = false) {
  if (!force && models.value.length && Date.now() - modelsAt < 60000) return models.value
  const data = await api<{ models: import('./lib/types').ModelInfo[] }>('/api/models')
  models.value = data.models; modelsAt = Date.now()
  return models.value
}
export async function setSessionAvatar(key: string, image: Blob | null) {
  const data = await api<{ session: Session }>(`/api/sessions/${keyPath(key)}/avatar`, image ? { method: 'PUT', body: image } : { method: 'DELETE' })
  patchSession(data.session)
}
export async function deleteSession(key: string) {
  if (state.sessions.some(s => s.key === key) || state.pending.has(key)) await api(`/api/sessions/${keyPath(key)}`, { method: 'DELETE' })
  state.drafts.delete(key)
  discardAttachments(key)
  if (state.selected === key) { setHashSession(''); state.selected = ''; state.history = []; state.threadRunning = false; state.live = null; state.queue = []; state.prompts = []; state.hasMore = false; historySig = ''; stopStream() }
  await refreshSessions()
}

/* ---------- attachments ---------- */
let fileId = 0
export function addFiles(files: Iterable<File>) {
  const key = state.selected
  if (!key) { toast('请先选择会话'); return }
  const entries = [...(state.attachments.get(key) || [])]
  const { files: maxFiles, fileBytes, totalBytes } = limits.value
  let total = entries.reduce((sum, e) => sum + e.size, 0)
  for (const file of files) {
    if (entries.length >= maxFiles) { toast(`最多添加 ${maxFiles} 个文件`); break }
    if (file.size > fileBytes) { toast(`${file.name} 超过 ${fileSize(fileBytes)}`); continue }
    if (total + file.size > totalBytes) { toast(`附件总大小超过 ${fileSize(totalBytes)}`); continue }
    total += file.size
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

/* ---------- send / queue / stop ---------- */
let queueSig = ''
function setQueue(queue: QueueEntry[]) {
  const sig = JSON.stringify(queue)
  if (sig === queueSig) return
  queueSig = sig
  state.queue = queue
}
/**
 * Messages are accepted asynchronously (202): the relay queues them behind the running turn (排队)
 * or steers them into it (引导, turn/steer). Progress then arrives over the stream and history.
 */
export async function sendMessage(text: string, mode: SendMode = 'queue'): Promise<boolean> {
  const key = state.selected
  const files = state.attachments.get(key) || []
  if (!key || (!text.trim() && !files.length) || state.pending.has(key)) return false
  const own = epoch
  const body: Record<string, string> = { session: key, message: text, mode, async: '1' }
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
    const result = await api<{ status: string; position?: number; steer_fallback?: string }>('/api/send', { method: 'POST', body: payload })
    if (own !== epoch) return true
    state.drafts.delete(key)
    ok = true
    if (result.status === 'queued') toast(result.steer_fallback ? '无法引导当前回合，已排在队首' : `已排队（第 ${result.position || 1} 位）`, true)
    else if (result.status === 'steered') toast('已引导到当前回合', true)
    else if (mode === 'steer' && result.steer_fallback === 'no_active_turn') toast('当前没有运行中的回合，已直接发送', true)
  } catch (error) {
    if (own === epoch) {
      toast((error as Error).message)
      if (files.length) { state.attachments.set(key, [...files, ...(state.attachments.get(key) || [])]); restored = true }
    }
  } finally {
    if (own === epoch) {
      // Keep the pending message on screen until the history / queue that replaces it has arrived;
      // dropping it first left a gap of one round trip where the bubble and the turn vanished and came back.
      if (!ok) state.pending.delete(key)
      historySig = ''
      await refreshSessions().catch(e => toast(e.message))
      if (state.selected === key) await refreshHistory(key).catch(() => {})
      state.pending.delete(key)
      if (!restored) files.forEach(f => f.preview && URL.revokeObjectURL(f.preview))
    }
  }
  return ok
}
/** Remove a queued message before it is sent. */
export async function cancelQueued(id: string) {
  const key = state.selected
  try {
    await api(`/api/sessions/${keyPath(key)}/queue/${id}`, { method: 'DELETE' })
    setQueue(state.queue.filter(e => e.id !== id))
    toast('已撤回', true)
  } catch (error) { toast((error as Error).message) }
  void refreshSessions().catch(() => {})
}
/** Turn a queued message into a steer of the running turn (the queue card's 引导 button). */
export async function steerQueued(id: string) {
  const key = state.selected
  try {
    const r = await api<{ status: string; steer_fallback?: string }>(`/api/sessions/${keyPath(key)}/queue/${id}/steer`, { method: 'POST' })
    toast(r.status === 'steered' ? '已引导到当前回合' : r.steer_fallback === 'no_active_turn' ? '当前没有运行中的回合，仍在排队' : '无法引导当前回合，仍在队首排队', r.status === 'steered')
  } catch (error) { toast((error as Error).message) }
  void refreshSessions().catch(() => {})
}
/** Stop the running turn (turn/interrupt); queued messages then continue. */
export async function stopTurn() {
  const key = state.selected
  if (!key || state.stopping) return
  state.stopping = true
  try { await api(`/api/sessions/${keyPath(key)}/interrupt`, { method: 'POST' }); toast('已发送停止请求', true) }
  catch (error) { toast((error as Error).message) }
  finally { state.stopping = false }
  historySig = ''
  if (state.selected === key) void refreshHistory(key).catch(() => {})
}

/* ---------- logs ---------- */
export const logs = reactive({ stats: null as Stats | null, requests: [] as RequestRow[], usage: null as UsageSnapshot | null, usageError: '', loaded: false, loading: false, error: '', auto: true })
export async function refreshLogs() {
  const own = epoch
  logs.loading = true
  try {
    const tasks: Promise<unknown>[] = [api<Stats>('/api/stats'), api<{ requests: RequestRow[] }>('/api/requests?limit=100')]
    if (isAdmin.value) tasks.push(api<{ usage: UsageSnapshot }>('/api/usage'))
    const results = await Promise.allSettled(tasks)
    if (own !== epoch) return
    const statsR = results[0], reqR = results[1]
    if (statsR.status === 'rejected' || reqR.status === 'rejected') {
      const err = (statsR.status === 'rejected' ? statsR.reason : (reqR as PromiseRejectedResult).reason) as Error
      logs.error = err.message
    } else {
      logs.stats = statsR.value as Stats
      logs.requests = (reqR.value as { requests: RequestRow[] }).requests
      logs.loaded = true
      logs.error = ''
    }
    if (isAdmin.value) {
      const usageR = results[2]
      if (usageR && usageR.status === 'fulfilled') {
        logs.usage = (usageR.value as { usage: UsageSnapshot }).usage
        logs.usageError = ''
      } else if (usageR && usageR.status === 'rejected') {
        logs.usageError = (usageR.reason as Error).message
      }
    } else {
      logs.usage = null
      logs.usageError = ''
    }
  } catch (error) { if (own === epoch) logs.error = (error as Error).message }
  finally { logs.loading = false }
}

/* ---------- live stream: SSE over fetch (Authorization header), reconnects with backoff ---------- */
let streamAbort: AbortController | null = null, streamKey = '', streamTouched = 0, streamRetry: number | undefined
let liveBuf: LiveTurn | null = null, liveTimer: number | undefined
function setLive(turn: LiveTurn | null) {
  liveBuf = turn ? { ...turn, items: turn.items.map(item => ({ ...item })) } : null
  clearTimeout(liveTimer); liveTimer = undefined
  state.live = liveBuf ? { ...liveBuf, items: liveBuf.items.map(item => ({ ...item })) } : null
}
// Deltas arrive many times a second; copy the buffer into reactive state at most every 100 ms.
function commitLive() {
  if (liveTimer !== undefined) return
  liveTimer = window.setTimeout(() => {
    liveTimer = undefined
    state.live = liveBuf ? { ...liveBuf, items: liveBuf.items.map(item => ({ ...item })) } : null
  }, 100)
}
function liveItem(id: string, init: Partial<LiveItem>, turnId?: string | null): LiveItem {
  // An event of another turn never appends under the buffered one (that mashed an old turn into the new one).
  if (liveBuf && turnId && liveBuf.turnId && liveBuf.turnId !== turnId) liveBuf = null
  if (!liveBuf) liveBuf = { turnId: turnId || '', startedAt: new Date().toISOString(), items: [] }
  else if (turnId && !liveBuf.turnId) liveBuf.turnId = turnId
  let item = liveBuf.items.find(i => i.id === id)
  if (!item) {
    item = { id, kind: 'other', ...init } as LiveItem
    liveBuf.items.push(item)
    if (liveBuf.items.length > 300) liveBuf.items.splice(0, liveBuf.items.length - 300)
  }
  return item
}
function onStreamEvent(key: string, name: string, data: any) {
  if (state.selected !== key) return
  streamTouched = Date.now()
  if (name === 'snapshot') {
    setLive(data.live || null)
    if (data.queue) setQueue(data.queue)
    if (Array.isArray(data.prompts)) setPrompts(data.prompts)
    if (data.running) state.threadRunning = true
  } else if (name === 'prompt') {
    if (data.prompt?.id) setPrompts([...state.prompts.filter(p => p.id !== data.prompt.id), data.prompt])
  } else if (name === 'prompt_resolved') {
    dropPrompt(data.id)
  } else if (name === 'turn') {
    if (data.status === 'started') {
      setLive({ turnId: data.turnId || '', startedAt: new Date().toISOString(), items: [] }); state.threadRunning = true
      historySig = ''
      void refreshHistory(key).catch(() => {})
    }
    else {
      // Keep the live answer on screen until the final message is in history: swapping in the same
      // tick avoids the blank gap + fade-in flash at the end of a turn.
      const ended = liveBuf
      setPrompts([])
      historySig = ''
      void refreshHistory(key).catch(() => {}).finally(() => { if (state.selected === key && liveBuf === ended) setLive(null) })
      void refreshSessions().catch(() => {})
    }
  } else if (name === 'queue') {
    setQueue(data.queue || [])
    if (data.running) state.threadRunning = true
    void refreshSessions().catch(() => {})
  } else if (name === 'item') {
    const item = liveItem(data.item.id, data.item, data.turnId)
    Object.assign(item, data.item)
    state.threadRunning = true
    commitLive()
  } else if (name === 'delta') {
    const item = liveItem(data.id, { kind: data.kind, text: '' }, data.turnId) as any
    item[data.field] = (item[data.field] || '') + data.delta
    const cap = data.field === 'output' ? 4000 : 400000
    if (typeof item[data.field] === 'string' && item[data.field].length > cap) item[data.field] = item[data.field].slice(-cap)
    commitLive()
  }
}
export function stopStream() {
  clearTimeout(streamRetry); streamRetry = undefined
  streamAbort?.abort(); streamAbort = null; streamKey = ''
  state.streaming = false
}
function startStream(key: string, attempt = 0) {
  stopStream()
  if (!key || !state.token) return
  const own = epoch, abort = new AbortController()
  streamAbort = abort; streamKey = key
  const retry = () => {
    if (abort.signal.aborted || own !== epoch || state.selected !== key) return
    state.streaming = false
    streamRetry = window.setTimeout(() => startStream(key, attempt + 1), Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)))
  }
  void (async () => {
    try {
      const response = await fetch(`/api/sessions/${keyPath(key)}/stream`, { headers: { Authorization: `Bearer ${state.token}`, Accept: 'text/event-stream' }, cache: 'no-store', signal: abort.signal })
      if (!response.ok || !response.body) { if (response.status === 401 && state.authed) { logout(false); toast('登录已失效，请重新登录'); return } retry(); return }
      state.streaming = true
      attempt = 0
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        let cut
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2)
          let name = 'message', data = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          if (block.startsWith(':')) { streamTouched = Date.now(); continue }
          if (data) { try { onStreamEvent(key, name, JSON.parse(data)) } catch { /* ignore malformed */ } }
        }
      }
      retry()
    } catch { retry() }
  })()
}
// A stream silently stalled by a proxy: no heartbeat for 45 s -> reconnect.
function checkStream() {
  if (state.selected && state.authed && (!streamAbort || streamKey !== state.selected)) startStream(state.selected)
  else if (state.streaming && Date.now() - streamTouched > 45000) startStream(state.selected)
}

/* ---------- polling: sessions 5s, history 3s (15s while streaming), pending clock 1s ---------- */
const timers: number[] = []
function startPolling() {
  stopPolling()
  timers.push(window.setInterval(() => {
    if (document.hidden) return
    refreshSessions().catch(e => (state.sessionsError = e.message))
    if (state.tab === 'logs' && logs.auto) void refreshLogs()
  }, 5000))
  let ticks = 0
  timers.push(window.setInterval(() => {
    if (!state.token || !state.selected || document.hidden) return
    checkStream()
    if (state.streaming && ++ticks % 5) return
    refreshHistory(state.selected).catch(e => (state.historyError = e.message))
  }, 3000))
  timers.push(window.setInterval(() => { if ((state.pending.size || state.live) && !document.hidden) state.now = Date.now() }, 1000))
}
function stopPolling() { while (timers.length) clearInterval(timers.pop()) }

/* ---------- per-session webhook (admin) ---------- */
export interface SessionWebhook { path: string; secret: string; created_at: string }
let webhookViewer: ((s: Session) => void) | null = null
export function registerWebhookViewer(fn: (s: Session) => void) { webhookViewer = fn }
export function openWebhook(s: Session) { webhookViewer?.(s) }
/** Created on first view; each session has its own URL and key. */
export async function sessionWebhook(key: string) { return (await api<{ webhook: SessionWebhook }>(`/api/sessions/${keyPath(key)}/webhook`)).webhook }
/** Replaces the key; the old one stops working immediately. The URL stays the same. */
export async function rotateWebhook(key: string) { return (await api<{ webhook: SessionWebhook }>(`/api/sessions/${keyPath(key)}/webhook/rotate`, { method: 'POST' })).webhook }


/* ---------- session → users (admin share) ---------- */
export interface SessionUsersPayload { session: string; users: User[]; assigned: number[] }
let sessionAssigner: ((s: Session) => void) | null = null
export function registerSessionAssigner(fn: (s: Session) => void) { sessionAssigner = fn }
export function assignSession(s: Session) { sessionAssigner?.(s) }
export async function fetchSessionUsers(key: string) {
  return api<SessionUsersPayload>(`/api/sessions/${keyPath(key)}/users`)
}
export async function setSessionUsers(key: string, userIds: number[]) {
  return api<{ session: string; assigned: number[]; users: User[] }>(`/api/sessions/${keyPath(key)}/users`, { method: 'PUT', body: JSON.stringify({ user_ids: userIds }) })
}

/* ---------- users (admin) ---------- */
export const users = reactive({ list: [] as User[], loaded: false, loading: false, error: '' })
export async function refreshUsers() {
  const own = epoch
  users.loading = true
  try {
    const data = await api<{ users: User[] }>('/api/users')
    if (own !== epoch) return
    users.list = data.users; users.loaded = true; users.error = ''
  } catch (error) { if (own === epoch) users.error = (error as Error).message }
  finally { users.loading = false }
}
export interface UserInput { username?: string; password?: string; role?: 'admin' | 'user'; disabled?: boolean; sessions?: string[] }
export async function createUser(input: UserInput) {
  const data = await api<{ user: User }>('/api/users', { method: 'POST', body: JSON.stringify(input) })
  await refreshUsers(); return data.user
}
export async function updateUser(id: number, input: UserInput) {
  const data = await api<{ user: User }>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(input) })
  await refreshUsers()
  if (state.me?.user?.id === id) state.me = await api<Me>('/api/whoami')
  return data.user
}
export async function resetPassword(id: number, password: string) { await api(`/api/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }) }
export async function deleteUser(id: number) { await api(`/api/users/${id}`, { method: 'DELETE' }); await refreshUsers() }

export async function fetchFeishuSettings() { return api<FeishuSettings>('/api/settings/feishu') }
export async function saveFeishuSettings(input: { app_id?: string; app_secret?: string; redirect_uri?: string; enabled?: boolean }) {
  return api<FeishuSettings>('/api/settings/feishu', { method: 'PUT', body: JSON.stringify(input) })
}
export async function changeOwnPassword(current: string, next: string) { await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ current_password: current, new_password: next }) }) }
/** First-run: create the first admin while signed in with the webhook token, then switch to that account. */
export async function setupAdmin(username: string, password: string) {
  const data = await api<{ token: string }>('/api/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) })
  await login(data.token, rememberChoice())
}
