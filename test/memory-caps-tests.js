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

console.log('memory caps tests passed');
