import assert from 'node:assert/strict';
import { currentBaselineDelta, exactWindowDelta } from './oiWindows.js';

function summary(t, oiShift = 0) {
  return {
    t,
    underlyingPrice: 24250 + oiShift,
    strikes: {
      24200: { ce: { oi: 100 + oiShift, lastPrice: 10 }, pe: { oi: 200 + oiShift, lastPrice: 12 } },
      24250: { ce: { oi: 300 + oiShift, lastPrice: 11 }, pe: { oi: 400 + oiShift, lastPrice: 13 } },
      24300: { ce: { oi: 500 + oiShift, lastPrice: 12 }, pe: { oi: 600 + oiShift, lastPrice: 14 } },
    },
  };
}

const baseline = summary(1_000);
const resetNow = currentBaselineDelta(baseline, baseline, 5 * 60_000, 1);
assert.equal(resetNow.referenceMode, 'current-market-baseline');
assert.equal(resetNow.provisional, true);
assert.equal(resetNow.actualSpanMs, 0);
assert.equal(resetNow.bandDeltaCe, 0);
assert.equal(resetNow.bandDeltaPe, 0);
assert.equal(resetNow.bandDeltaTotal, 0);
assert.deepEqual(resetNow.callItmStrikes, [24200]);
assert.deepEqual(resetNow.putItmStrikes, [24300]);
assert.ok(resetNow.band.every((row) => row.dTotal === 0 && (row.dCe === 0 || row.dPe === 0)), 'all displayed ITM strike deltas must be zero at reset');

const afterReset = summary(61_000, 9);
const beforeFiveMinutes = currentBaselineDelta(baseline, afterReset, 5 * 60_000, 1);
assert.equal(beforeFiveMinutes.provisional, true);
assert.equal(beforeFiveMinutes.bandDeltaTotal, 18, 'until a complete interval exists, selected ITM deltas should be against the real reset snapshot');

const fiveMinuteReference = summary(61_000, 9);
const afterSixMinutes = summary(361_000, 15);
const exact = exactWindowDelta([baseline, fiveMinuteReference, afterSixMinutes], afterSixMinutes.t, 5 * 60_000, 1);
assert.equal(exact.referenceMode, 'exact-window');
assert.equal(exact.provisional, false);
assert.equal(exact.fromT, fiveMinuteReference.t);
assert.equal(exact.bandDeltaTotal, 12, 'after five minutes, the card must transition to an exact 5-minute reference');

const incompleteCurrent = structuredClone(afterReset);
incompleteCurrent.strikes[24250].ce.oi = null;
const withoutInventedZero = currentBaselineDelta(baseline, incompleteCurrent, 5 * 60_000, 1);
assert.equal(withoutInventedZero.band.find((row) => row.strike === 24250 && row.optionSide === 'ce'), undefined, 'a strike with null or missing OI must be excluded, never calculated against a fabricated zero');
assert.ok(withoutInventedZero.band.every((row) => row.dTotal === (row.dCe ?? row.dPe)), 'each displayed ITM total must equal its selected Call or Put delta');

console.log('OI window baseline tests passed');
