'use strict';

// When a turn event arrives (and optionally after history refresh), decide whether
// the thinking placeholder may be cleared. A hung history fetch after a real
// completion should still clear; a still-running turn, or a non-terminal event
// such as a disconnect, must not.
function shouldClearLive({ eventStatus, historyKnown = false, historyRunning = false, liveTurnId = null, endedTurnId = null } = {}) {
  if (!['completed', 'failed', 'interrupted'].includes(eventStatus)) return false;
  if (historyKnown && historyRunning) return false;
  if (liveTurnId && endedTurnId && liveTurnId !== endedTurnId) return false;
  return true;
}

module.exports = { shouldClearLive };
