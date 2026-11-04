const timeFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
export const time = (value?: string | number | null) => (value ? timeFormat.format(new Date(value)) : '—')
export const duration = (ms?: number) => (typeof ms === 'number' ? (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`) : '—')
export function shortTime(value?: string) {
  if (!value) return ''
  const full = time(value), today = time(Date.now()).slice(0, 10)
  return full.slice(0, 10) === today ? full.slice(11, 16) : full.slice(5, 10)
}
export const fileSize = (size?: number) =>
  typeof size === 'number' ? (size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`) : ''
export function uptime(seconds: number) {
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60)
  return d ? `${d}天 ${h}时` : h ? `${h}时 ${m}分` : `${m}分`
}
