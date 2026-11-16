'use strict';

const assert = require('node:assert/strict');
const { shouldClearLive } = require('../lib/live-state');

assert.equal(shouldClearLive({ eventStatus: 'completed' }), true, 'completed event may clear when history is hung');
assert.equal(shouldClearLive({ eventStatus: 'failed' }), true);
assert.equal(shouldClearLive({ eventStatus: 'interrupted' }), true);
assert.equal(shouldClearLive({ eventStatus: 'disconnected' }), false, 'disconnect must not clear a still-running turn');
assert.equal(shouldClearLive({ eventStatus: 'started' }), false);
assert.equal(shouldClearLive({ eventStatus: 'completed', historyKnown: true, historyRunning: true }), false, 'history still running must not be masked');
assert.equal(shouldClearLive({ eventStatus: 'completed', historyKnown: true, historyRunning: false }), true, 'confirmed idle history after completion may clear');
assert.equal(shouldClearLive({ eventStatus: 'completed', liveTurnId: 'new', endedTurnId: 'old' }), false, 'a newer turn must keep its live buffer');
assert.equal(shouldClearLive({ eventStatus: 'completed', liveTurnId: 'same', endedTurnId: 'same' }), true);
assert.equal(shouldClearLive({ eventStatus: 'completed', historyKnown: false, historyRunning: true }), true, 'hung history after a completion still clears');
console.log('Live-state tests passed');
