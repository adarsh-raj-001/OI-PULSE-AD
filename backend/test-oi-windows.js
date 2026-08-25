import assert from 'node:assert/strict';
import { clockAlignedWindowDelta, currentBaselineDelta, exactWindowDelta, standardClockWindowStart } from './oiWindows.js';

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

const istTimestamp = (hour, minute) => Date.UTC(2026, 0, 1, hour - 5, minute - 30);
const fiveMinuteHistory = [summary(istTimestamp(11, 0)), summary(istTimestamp(11, 4), 4), summary(istTimestamp(11, 5), 7), summary(istTimestamp(11, 6), 10)];
const beforeFiveMinuteReset = clockAlignedWindowDelta(fiveMinuteHistory.slice(0, 2), istTimestamp(11, 4), 5 * 60_000, 1);
assert.equal(beforeFiveMinuteReset.referenceMode, 'clock-aligned-baseline');
assert.equal(beforeFiveMinuteReset.fromT, istTimestamp(11, 0));
assert.equal(beforeFiveMinuteReset.bandDeltaTotal, 8, 'the 11:00 baseline applies until the 11:05 standard-clock boundary');
const atFiveMinuteReset = clockAlignedWindowDelta(fiveMinuteHistory.slice(0, 3), istTimestamp(11, 5), 5 * 60_000, 1);
assert.equal(atFiveMinuteReset.windowStartAt, istTimestamp(11, 5));
assert.equal(atFiveMinuteReset.fromT, istTimestamp(11, 5));
assert.equal(atFiveMinuteReset.bandDeltaTotal, 0, 'the first real 11:05 snapshot must become the new five-minute baseline and show zero delta');
const afterFiveMinuteReset = clockAlignedWindowDelta(fiveMinuteHistory, istTimestamp(11, 6), 5 * 60_000, 1);
assert.equal(afterFiveMinuteReset.fromT, istTimestamp(11, 5));
assert.equal(afterFiveMinuteReset.bandDeltaTotal, 6, 'post-boundary changes must compare against the new 11:05 baseline');

const thirtyMinuteHistory = [summary(istTimestamp(11, 0)), summary(istTimestamp(11, 29), 5), summary(istTimestamp(11, 30), 9)];
assert.equal(standardClockWindowStart(istTimestamp(11, 29), 30 * 60_000), istTimestamp(11, 0));
assert.equal(standardClockWindowStart(istTimestamp(11, 30), 30 * 60_000), istTimestamp(11, 30));
assert.equal(clockAlignedWindowDelta(thirtyMinuteHistory.slice(0, 2), istTimestamp(11, 29), 30 * 60_000, 1).bandDeltaTotal, 10);
assert.equal(clockAlignedWindowDelta(thirtyMinuteHistory, istTimestamp(11, 30), 30 * 60_000, 1).bandDeltaTotal, 0, 'the 11:30 snapshot must reset the 30-minute delta to zero');

const threeHourHistory = [summary(istTimestamp(9, 15)), summary(istTimestamp(11, 59), 12), summary(istTimestamp(12, 0), 16)];
assert.equal(standardClockWindowStart(istTimestamp(11, 59), 3 * 60 * 60_000), istTimestamp(9, 0));
assert.equal(standardClockWindowStart(istTimestamp(12, 0), 3 * 60 * 60_000), istTimestamp(12, 0));
assert.equal(clockAlignedWindowDelta(threeHourHistory.slice(0, 2), istTimestamp(11, 59), 3 * 60 * 60_000, 1).fromT, istTimestamp(9, 15), 'the first real post-open snapshot provides the 09:00 block baseline');
assert.equal(clockAlignedWindowDelta(threeHourHistory, istTimestamp(12, 0), 3 * 60 * 60_000, 1).bandDeltaTotal, 0, 'the 12:00 standard-clock boundary must reset the three-hour delta to zero');

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
