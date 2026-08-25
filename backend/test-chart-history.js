import assert from 'node:assert/strict';
import { appendChartPoint, buildChartPoint } from './chartHistory.js';

const snapshotOne = {
  t: 1_000,
  underlyingPrice: 110,
  strikes: {
    100: { ce: { oi: 100, lastPrice: 10, volume: 5, topBidQuantity: 9, topAskQuantity: 4 }, pe: { oi: 200, lastPrice: 15, volume: 2, topBidQuantity: 3, topAskQuantity: 8 } },
    110: { ce: { oi: 110, lastPrice: 12, volume: 10, topBidQuantity: 7, topAskQuantity: 6 }, pe: { oi: 210, lastPrice: 16, volume: 3, topBidQuantity: 4, topAskQuantity: 9 } },
    120: { ce: { oi: 120, lastPrice: 14, volume: 5, topBidQuantity: 8, topAskQuantity: 5 }, pe: { oi: 220, lastPrice: 17, volume: 5, topBidQuantity: 5, topAskQuantity: 7 } },
  },
};

const first = buildChartPoint(snapshotOne, null, 1);
assert.equal(first.atmStrike, 110);
assert.deepEqual(first.callItmStrikes, [100]);
assert.deepEqual(first.putItmStrikes, [120]);
assert.equal(first.callOi, 100);
assert.equal(first.putOi, 220);
assert.equal(first.callOiChange, null);
assert.equal(first.callBidAskDifference, 5);
assert.equal(first.putBidAskDifference, -2);
assert.equal(first.callPrice, 10);

const snapshotTwo = structuredClone(snapshotOne);
snapshotTwo.t = 4_000;
snapshotTwo.underlyingPrice = 112;
snapshotTwo.strikes[110].ce.oi = 118;
snapshotTwo.strikes[120].pe.oi = 230;
const second = buildChartPoint(snapshotTwo, first, 1);
assert.equal(second.underlyingPriceChange, 2);
assert.deepEqual(second.callItmStrikes, [100], 'the nearest ATM strike is excluded even when the underlying sits between strikes');
assert.equal(second.callOiChange, 0);
assert.equal(second.putOiChange, 10);

const retained = [];
appendChartPoint(retained, first, 0);
appendChartPoint(retained, second, 2_000);
assert.deepEqual(retained, [second]);

const eventPoints = [];
appendChartPoint(eventPoints, first, 0, 1_000);
const sameSecond = { ...second, t: 1_450 };
appendChartPoint(eventPoints, sameSecond, 0, 1_000);
assert.equal(eventPoints.length, 1, 'nearby event points should replace the current chart bucket');
assert.equal(eventPoints[0].t, first.t, 'replacement preserves the original bucket timestamp');
assert.equal(eventPoints[0].underlyingPrice, second.underlyingPrice);

function strictChartSnapshot(t, oiShift = 0) {
  const strikes = [24000, 24050, 24100, 24150, 24200, 24250, 24300];
  return {
    t,
    underlyingPrice: 24150,
    strikes: Object.fromEntries(strikes.map((strike, index) => [strike, {
      ce: { oi: 100 + index + oiShift, lastPrice: 10 + index, volume: 1 },
      pe: { oi: 200 + index + oiShift, lastPrice: 20 + index, volume: 1 },
    }])),
  };
}

const strictChart = buildChartPoint(strictChartSnapshot(5_000), null, 3);
assert.deepEqual(strictChart.callItmStrikes, [24100, 24050, 24000]);
assert.deepEqual(strictChart.putItmStrikes, [24200, 24250, 24300]);
assert.equal(strictChart.atmStrike, 24150);
assert.equal(strictChart.callOi, 303, 'chart Call OI uses exactly the three strict ITM Calls');
assert.equal(strictChart.putOi, 615, 'chart Put OI uses exactly the three strict ITM Puts');

const incompleteStrictChart = strictChartSnapshot(6_000);
incompleteStrictChart.strikes[24200].pe.oi = null;
assert.equal(buildChartPoint(incompleteStrictChart, strictChart, 3), null, 'the chart must not emit a partial strict-ITM OI point');

console.log('chart-history tests passed');
