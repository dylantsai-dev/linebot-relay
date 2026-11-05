export type SessionStatus = 'idle' | 'running' | 'queued'
export interface Session {
  key: string
  codex_session_id: string | null
  messages: number
  created_at?: string
  updated_at?: string
  status: SessionStatus
  queued: number
  draft?: boolean
  name?: string
  avatar_url?: string
  /** Admin paused it: webhook messages are rejected (423); the console still sends. */
  paused?: boolean
  /** Admin-chosen model id for this session; unset means the default. */
  model?: string
  effort?: string
  service_tier?: string
  paused_at?: string
}
export interface Attachment {
  name?: string
  path?: string
  url?: string
  mime?: string
  size?: number
  kind?: 'image' | 'file'
  preview?: string | null
}
export interface HistoryEntry {
  role: 'user' | 'assistant' | 'error'
  text: string
  time?: string
  source?: string
  duration_ms?: number
  codex_session_id?: string
  attachments?: Attachment[]
  /** Images produced by thread items (image generation, image views, tool output): signed URLs. */
  images?: MediaImage[]
  /** The turn's process (commentary, commands, edits, searches, tools) in order. */
  steps?: LiveItem[]
}
export interface MediaImage { name: string; kind?: 'image'; url: string; source?: 'generated' | 'view' | 'tool'; prompt?: string }
export type LiveKind = 'text' | 'reasoning' | 'plan' | 'command' | 'tool' | 'search' | 'file' | 'image' | 'other'
export interface LiveItem { id: string; kind: LiveKind; done?: boolean; text?: string; title?: string; status?: string; exitCode?: number | null; output?: string; url?: string; phase?: string }
export interface LiveTurn { turnId: string; startedAt: string; items: LiveItem[] }
export type SendMode = 'queue' | 'steer'
/** Relay-side queue entry: steered into the running turn, running, or waiting (排队). */
export interface QueueEntry { id: string; text: string; mode: SendMode; status: 'steered' | 'running' | 'queued'; source: string; user: string | null; created_at: string; started_at?: string; fallback?: 'no_active_turn' | 'steer_rejected'; attachments: Attachment[] }
export interface HistoryResponse { key: string; session: string; history: HistoryEntry[]; source: 'thread' | 'local'; running: boolean; revision?: number; live?: LiveTurn; queue?: QueueEntry[]; has_more?: boolean; prompts?: Prompt[] }
/** A pending approval / question from the running turn, answered from the console. */
export type PromptDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
export interface PromptQuestion { id: string; header: string; question: string; options: { label: string; description: string }[]; isOther: boolean; isSecret: boolean }
export interface Prompt {
  id: string; kind: 'command' | 'file' | 'input' | 'permissions'; title: string; reason: string | null; created_at: string
  turnId?: string | null; command?: string | null; cwd?: string | null; files?: { path: string; type: string }[]; grant_root?: string | null
  summary?: string[]; questions?: PromptQuestion[]; decisions?: PromptDecision[]
}
export interface CodexThread { id: string; title: string; preview: string; updated_at: string | null; created_at: string | null; cwd: string | null; status: string | null; source: string | null; linked: string[] }
export interface Stats { today: { calls: number; failures: number; avg_duration_ms: number }; total_sessions: number; running: number; queued: number; uptime_s: number; scope?: 'granted' }
export interface RequestRow { time: string; request_id: string; session: string | null; source: string; method: string; path: string; status: number | string; ok: boolean; duration_ms: number; error: string | null }
export interface DraftFile { id: number; file: File; name: string; size: number; mime: string; kind: 'image' | 'file'; preview: string | null }
export interface PendingSend { message: string; attachments: DraftFile[]; started: number }
export interface User { id: number; username: string; role: 'admin' | 'user'; disabled: boolean; created_at: string; updated_at: string; last_login_at: string | null; sessions: string[]; avatar_url?: string; display_name?: string; auth_provider?: 'password' | 'feishu'; has_password?: boolean; feishu_open_id?: string | null }
export interface Limits { max_file_bytes: number; max_files: number; max_total_bytes: number }
export interface Me { ok: true; auth: 'token' | 'user'; role: 'admin' | 'user'; needs_setup: boolean; limits?: Limits; user: { id: number; username: string; role: 'admin' | 'user'; last_login_at: string | null; avatar_url?: string; display_name?: string; auth_provider?: 'password' | 'feishu'; has_password?: boolean } | null }

export interface ModelInfo { id: string; displayName: string; description: string; isDefault: boolean; defaultReasoningEffort: string | null; supportedReasoningEfforts: { id: string; description: string }[]; serviceTiers: { id: string; name: string; description: string }[]; defaultServiceTier: string | null }

export interface UsageWindow { used_percent: number; resets_at: string | null; window_mins: number | null; label: string }
export interface UsageSnapshot {
  plan: string | null
  limit_name: string | null
  week: UsageWindow | null
  primary: UsageWindow | null
  secondary: UsageWindow | null
  credits: { has_credits: boolean; unlimited: boolean; balance: string | null } | null
  fetched_at: string
}

export interface FeishuSettings { app_id: string; has_secret: boolean; redirect_uri: string; enabled: boolean; ready: boolean; default_redirect_uri: string }
