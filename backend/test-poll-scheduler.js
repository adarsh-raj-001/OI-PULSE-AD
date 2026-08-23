import assert from 'node:assert/strict';
import { SerializedPollScheduler, nextPollDelayMs } from './pollScheduler.js';

assert.equal(nextPollDelayMs({ startedAt: 100, finishedAt: 600, minimumIntervalMs: 3100 }), 2600);
assert.equal(nextPollDelayMs({ startedAt: 100, finishedAt: 600, minimumIntervalMs: 3100, retryAfterMs: 15000 }), 15000);

let now = 0;
const queued = [];
const calls = [];
const scheduler = new SerializedPollScheduler({
  symbols: [{ name: 'NIFTY' }, { name: 'SENSEX' }],
  minimumIntervalMs: 3100,
  now: () => now,
  schedule: (callback, delay) => {
    queued.push({ callback, delay });
    return queued.length;
  },
  run: async (symbol) => {
    calls.push({ name: symbol.name, at: now });
    return symbol.name === 'SENSEX' ? { retryAfterMs: 15000 } : {};
  },
});

scheduler.running = true;
await scheduler.tick();
assert.deepEqual(calls, [{ name: 'NIFTY', at: 0 }]);
assert.equal(queued[0].delay, 3100, 'next REST request must not start before the global 3.1s cadence');

now = 3100;
const nextPoll = queued.shift();
await nextPoll.callback();
assert.deepEqual(calls, [{ name: 'NIFTY', at: 0 }, { name: 'SENSEX', at: 3100 }]);
assert.equal(queued[0].delay, 15000, 'a Dhan 429 backoff must pause all following REST work');

scheduler.stop();
console.log('poll scheduler tests passed');
