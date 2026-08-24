import assert from 'node:assert/strict';
import { resolveMarketSession } from './marketSession.js';

const atIst = (day, hour, minute) => Date.UTC(2026, 7, day, hour - 5, minute - 30);

let state = resolveMarketSession({ enabled: true, timestamp: atIst(24, 9, 15) });
assert.equal(state.active, true, 'the configured pause must allow the exact 09:15 open');
assert.equal(state.reason, 'open');
assert.equal(state.regularSessionActive, true, 'the real weekday session must identify itself as eligible for one daily reset');
assert.equal(state.localDate, '2026-08-24', 'the reset key must use the India-local calendar date');

state = resolveMarketSession({ enabled: true, timestamp: atIst(24, 15, 29) });
assert.equal(state.active, true);

state = resolveMarketSession({ enabled: true, timestamp: atIst(24, 15, 30) });
assert.equal(state.active, false, 'the configured pause must begin at the exact 15:30 close');
assert.equal(state.reason, 'after-close');

state = resolveMarketSession({ enabled: true, timestamp: atIst(24, 9, 14) });
assert.equal(state.active, false);
assert.equal(state.reason, 'before-open');

state = resolveMarketSession({ enabled: true, timestamp: atIst(23, 12, 0) });
assert.equal(state.active, false, 'weekends must remain paused under the automated rule');
assert.equal(state.reason, 'weekend');

state = resolveMarketSession({ enabled: false, timestamp: atIst(23, 12, 0) });
assert.equal(state.active, true, 'manual override must permit collection and paper processing outside automatic hours');
assert.equal(state.reason, 'manual-override');
assert.equal(state.regularSessionActive, false, 'manual override must not create a synthetic daily reset session');

assert.throws(() => resolveMarketSession({ enabled: true, opensAt: '15:30', closesAt: '09:15' }), /increasing HH:MM/);
console.log('market session tests passed');
