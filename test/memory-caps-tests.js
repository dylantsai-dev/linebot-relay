'use strict';
const assert = require('node:assert/strict');
const { AppServer, slimThread, threadIsHeavy } = require('../lib/appserver');

const app = new AppServer('/nonexistent.sock');
app.completedTurnLimit = 5;
for (let i = 0; i < 12; i++) app.rememberCompleted(`t${i}`);
assert.equal(app.completedTurns.size, 5);
assert.equal(app.completedTurns.has('t0'), false);
assert.equal(app.completedTurns.has('t11'), true);

const fat = {
  id: 'thread',
  updatedAt: 1,
  turns: [
    { id: 'old', status: 'completed', startedAt: 1, completedAt: 2, items: [{ id: 'x', type: 'agentMessage', text: 'x'.repeat(200000) }] },
    { id: 'mid', status: 'completed', startedAt: 3, completedAt: 4, items: [{ id: 'y', type: 'agentMessage', text: 'y'.repeat(200000) }] },
    { id: 'live', status: 'inProgress', startedAt: 5, items: [{ id: 'z', type: 'agentMessage', text: 'hi' }] },
  ],
};
assert.equal(threadIsHeavy(fat), true);
assert.equal(threadIsHeavy({ turns: [{ id: 'a', status: 'completed', items: [{ text: 'hi' }] }] }), false);
const slim = slimThread(fat);
assert.equal(slim._completedTurns, 2);
assert.equal(slim.turns.length, 1);
assert.equal(slim.turns[0].id, 'live');
assert.equal(slim.turns[0].items[0].text, 'hi');

app.threadState('thread').cache = { thread: fat, revision: 1, time: Date.now(), hasTurns: true };
app.compactThreadCache('thread'); // heavy -> auto
assert.equal(app.threads.get('thread').cache.hasTurns, false);
assert.equal(app.threads.get('thread').cache.thread._completedTurns, 2);

app.threadState('gone');
app.inProgress.set('turn-x', 'gone');
app.forgetThread('gone');
assert.equal(app.threads.has('gone'), false);
assert.equal(app.inProgress.has('turn-x'), false);

assert.equal(app.canReadFullTurns('small', { rolloutBytes: 1024 }), true);
assert.equal(app.canReadFullTurns('huge', { rolloutBytes: 20 * 1024 * 1024 }), false);
app.noteFullTurnsFailure('failed');
assert.equal(app.canReadFullTurns('failed', { rolloutBytes: 1024 }), false);

app.captureCompletedTurn('th', {
  id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1000,
  items: [{ type: 'userMessage', content: [{ type: 'text', text: 'pwd' }] }, { type: 'agentMessage', id: 'm1', phase: 'final_answer', text: '/root' }],
});
assert.equal(app.capturedTurns('th').length, 1);
assert.equal(app.historyIsDirty('th'), true);
app.setHistorySnapshot('th', { entries: [{ role: 'assistant', text: '/root', time: '2026-01-01T00:00:00.000Z' }], localCount: 1, revision: 1 });
assert.equal(app.historyIsDirty('th'), false);
assert.equal(app.historySnapshot('th').entries[0].text, '/root');

console.log('memory caps tests passed');
