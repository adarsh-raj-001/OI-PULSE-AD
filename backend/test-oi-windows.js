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
incompleteCurrent.strikes[24200].ce.oi = null;
const withoutInventedZero = currentBaselineDelta(baseline, incompleteCurrent, 5 * 60_000, 1);
assert.equal(withoutInventedZero, null, 'a selected strict ITM strike with missing OI must block the aggregate instead of calculating against a fabricated zero');

function strictItmSummary(t, oiShift = 0) {
  const strikes = [24000, 24050, 24100, 24150, 24200, 24250, 24300];
  return {
    t,
    underlyingPrice: 24150,
    strikes: Object.fromEntries(strikes.map((strike, index) => [strike, {
      ce: { oi: 100 + index + oiShift },
      pe: { oi: 200 + index + oiShift },
    }])),
  };
}

const strictBaseline = strictItmSummary(1_000);
const strictCurrent = strictItmSummary(61_000, 10);
const strictBand = currentBaselineDelta(strictBaseline, strictCurrent, 5 * 60_000, 3);
assert.deepEqual(strictBand.callItmStrikes, [24100, 24050, 24000], 'three Calls must be strictly below the underlying');
assert.deepEqual(strictBand.putItmStrikes, [24200, 24250, 24300], 'three Puts must be strictly above the underlying');
assert.equal(strictBand.atmStrike, 24150, 'the nearest ATM strike is reported only for display');
assert.equal(strictBand.band.length, 6, 'the aggregate must contain exactly three strict ITM legs on each side');
assert.ok(strictBand.band.every((row) => row.strike !== 24150 && row.moneyness === 'ITM'), 'ATM must never be included in the aggregate');
assert.equal(strictBand.bandDeltaCe, 30);
assert.equal(strictBand.bandDeltaPe, 30);
assert.equal(strictBand.callItmOiBaseline, 303, 'Call percentage baseline must contain only the three current strict-ITM Calls');
assert.equal(strictBand.putItmOiBaseline, 615, 'Put percentage baseline must contain only the three current strict-ITM Puts');
assert.equal(strictBand.callItmOiCurrent, 333);
assert.equal(strictBand.putItmOiCurrent, 645);
assert.ok(Math.abs(strictBand.callItmOiChangePct - ((30 / 303) * 100)) < 1e-12, 'Call OI percentage must use the selected three-Call reference total');
assert.ok(Math.abs(strictBand.putItmOiChangePct - ((30 / 615) * 100)) < 1e-12, 'Put OI percentage must use the selected three-Put reference total');
assert.ok(Math.abs(strictBand.bandDeltaTotalPct - ((60 / 918) * 100)) < 1e-12, 'Combined OI percentage must use all six selected reference OI values');
assert.ok(Math.abs(strictBand.bandDeltaDifferencePct - (strictBand.callItmOiChangePct - strictBand.putItmOiChangePct)) < 1e-12, 'Difference percentage must equal Call percentage minus Put percentage');
assert.ok(strictBand.band.every((row) => Number.isFinite(row.referenceOi) && Number.isFinite(row.currentOi) && Number.isFinite(row.oiChangePct)), 'every displayed strict ITM leg must retain its selected-window OI baseline and percentage delta');

const missingStrictLeg = strictItmSummary(61_000, 10);
delete missingStrictLeg.strikes[24300];
assert.equal(currentBaselineDelta(strictBaseline, missingStrictLeg, 5 * 60_000, 3), null, 'a partial strict-ITM side must not produce a partial OI aggregate');

const incompleteStrictLeg = strictItmSummary(61_000, 10);
incompleteStrictLeg.strikes[24100].ce.oi = null;
assert.equal(currentBaselineDelta(strictBaseline, incompleteStrictLeg, 5 * 60_000, 3), null, 'all six strict ITM OI values must be present before calculating a band');

console.log('OI window baseline tests passed');
