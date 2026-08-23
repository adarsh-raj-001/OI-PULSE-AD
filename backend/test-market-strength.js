import assert from 'node:assert/strict';

import { buildMarketStrength } from './marketStrength.js';

const ref = {
  underlyingPrice: 24_000,
  strikes: {
    24_000: {
      ce: { oi: 1_000, lastPrice: 120, volume: 500, topBidPrice: 119, topAskPrice: 121, topBidQuantity: 80, topAskQuantity: 20, impliedVolatility: 12 },
      pe: { oi: 1_000, lastPrice: 110, volume: 500, topBidPrice: 109, topAskPrice: 111, topBidQuantity: 20, topAskQuantity: 80, impliedVolatility: 13 },
    },
  },
};

const cur = {
  underlyingPrice: 24_060,
  strikes: {
    24_000: {
      ce: { oi: 1_150, previousOi: 900, lastPrice: 132, volume: 900, topBidPrice: 131, topAskPrice: 133, topBidQuantity: 120, topAskQuantity: 30, impliedVolatility: 13 },
      pe: { oi: 900, previousOi: 1_100, lastPrice: 97, volume: 600, topBidPrice: 96, topAskPrice: 98, topBidQuantity: 20, topAskQuantity: 100, impliedVolatility: 12 },
    },
  },
};

const result = buildMarketStrength({ cur, ref, band: [{ strike: 24_000, dCe: 150, dPe: -100 }], actualSpanMs: 300_000 });
assert.equal(result.direction, 'up');
assert.equal(result.aggregates.strongerSide, 'Call activity stronger');
assert.equal(result.aggregates.callWindowOiChange, 150);
assert.equal(result.aggregates.putWindowOiChange, -100);
assert.ok(result.drivers.priceBps > 0);
assert.ok(result.drivers.callPremiumBps > 0);
assert.ok(result.drivers.putPremiumBps < 0);
assert.ok(result.confidence >= 80);

const incomplete = buildMarketStrength({
  cur: { underlyingPrice: 24_000, strikes: { 24_000: { ce: { oi: 10 }, pe: { oi: 10 } } } },
  ref: { underlyingPrice: 24_000, strikes: { 24_000: { ce: { oi: 8 }, pe: { oi: 12 } } } },
  band: [{ strike: 24_000, dCe: 2, dPe: -2 }],
  actualSpanMs: 300_000,
});
assert.equal(incomplete.direction, 'neutral');
assert.equal(incomplete.label, 'Limited data');

console.log('market-strength tests passed');
