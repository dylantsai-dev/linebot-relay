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
}
export interface HistoryResponse { key: string; session: string; history: HistoryEntry[]; source: 'thread' | 'local'; running: boolean; revision?: number }
export interface Stats { today: { calls: number; failures: number; avg_duration_ms: number }; total_sessions: number; running: number; queued: number; uptime_s: number; scope?: 'granted' }
export interface RequestRow { time: string; request_id: string; session: string | null; source: string; method: string; path: string; status: number | string; ok: boolean; duration_ms: number; error: string | null }
export interface DraftFile { id: number; file: File; name: string; size: number; mime: string; kind: 'image' | 'file'; preview: string | null }
export interface PendingSend { message: string; attachments: DraftFile[]; started: number }
export interface User { id: number; username: string; role: 'admin' | 'user'; disabled: boolean; created_at: string; updated_at: string; last_login_at: string | null; sessions: string[] }
export interface Me { ok: true; auth: 'token' | 'user'; role: 'admin' | 'user'; needs_setup: boolean; user: { id: number; username: string; role: 'admin' | 'user'; last_login_at: string | null } | null }
