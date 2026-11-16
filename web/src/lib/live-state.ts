/** Keep in sync with lib/live-state.js (Node tests require the CJS copy). */
export function shouldClearLive({ eventStatus, historyKnown = false, historyRunning = false, liveTurnId = null, endedTurnId = null }: {
  eventStatus?: string
  historyKnown?: boolean
  historyRunning?: boolean
  liveTurnId?: string | null
  endedTurnId?: string | null
} = {}): boolean {
  if (!['completed', 'failed', 'interrupted'].includes(eventStatus || '')) return false
  if (historyKnown && historyRunning) return false
  if (liveTurnId && endedTurnId && liveTurnId !== endedTurnId) return false
  return true
}
