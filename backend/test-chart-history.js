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
assert.equal(first.callOi, 330);
assert.equal(first.putOi, 630);
assert.equal(first.callOiChange, null);
assert.equal(first.callBidAskDifference, 9);
assert.equal(first.putBidAskDifference, -12);
assert.equal(first.callPrice, 12);

const snapshotTwo = structuredClone(snapshotOne);
snapshotTwo.t = 4_000;
snapshotTwo.underlyingPrice = 112;
snapshotTwo.strikes[110].ce.oi = 118;
snapshotTwo.strikes[120].pe.oi = 230;
const second = buildChartPoint(snapshotTwo, first, 1);
assert.equal(second.underlyingPriceChange, 2);
assert.equal(second.callOiChange, 8);
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

console.log('chart-history tests passed');
