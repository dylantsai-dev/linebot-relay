'use strict';
// A finished turn must never come back as the "live" turn (it mashed the old process + answer into the next message).
const assert = require('node:assert/strict');
const { AppServer } = require('../lib/appserver');

const app = new AppServer('/nonexistent.sock');
const events = [];
app.onLive((threadId, data) => events.push({ threadId, ...data }));
const T = 'thread-1';
const note = (method, params) => app.message(JSON.stringify({ method, params: { threadId: T, ...params } }));

note('turn/started', { turn: { id: 'old' } });
note('item/completed', { turnId: 'old', item: { id: 'a1', type: 'agentMessage', text: '你说的“达人主页”是哪一种？', phase: 'final_answer' } });
assert.equal(app.threadState(T).live.turnId, 'old');
assert.equal(events.at(-1).turnId, 'old', 'item events carry their turn id');
note('turn/completed', { turn: { id: 'old', status: 'completed' } });
assert.equal(app.threadState(T).live, null);

// A thread/read that was in flight while the turn finished still says inProgress.
const stale = { turns: [{ id: 'old', status: 'inProgress', items: [{ id: 'a1', type: 'agentMessage', text: '你说的“达人主页”是哪一种？' }] }] };
assert.equal(app.runningTurn(stale), null, 'a completed turn is not running');
assert.equal(app.seedLive(T, stale.turns[0]), null, 'stale read does not resurrect the finished turn');
assert.equal(app.threadState(T).live, null);
assert.equal(app.busy(T), false);

// The next turn starts clean; a late stale read during it keeps the new live turn.
note('turn/started', { turn: { id: 'new' } });
note('item/started', { turnId: 'new', item: { id: 'c1', type: 'commandExecution', command: 'ls /root/user', status: 'inProgress' } });
assert.equal(app.seedLive(T, stale.turns[0]).turnId, 'new');
assert.deepEqual(app.threadState(T).live.items.map(item => item.id), ['c1']);
note('item/agentMessage/delta', { turnId: 'new', itemId: 'a2', delta: '好' });
assert.equal(events.at(-1).type, 'delta');
assert.equal(events.at(-1).turnId, 'new');

// A genuinely running turn (never seen complete, e.g. started from the App before the relay joined) still seeds.
const other = 'thread-2';
const seeded = app.seedLive(other, { id: 'app-turn', status: 'inProgress', items: [{ id: 'x', type: 'agentMessage', text: 'hi' }] });
assert.equal(seeded.turnId, 'app-turn');
console.log('live turn tests passed');
