// Compact chart-series helpers. These points are retained separately from the
// raw snapshots used for exact 5m/30m/3h OI windows so a 10-hour chart does
// not require keeping full option-chain objects in memory.
import { itmStrikeSets } from './oiWindows.js';

const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function sortedStrikes(strikes) {
  return Object.keys(strikes || {})
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function nearestStrikeIndex(strikes, price) {
  const numericPrice = finite(price);
  if (numericPrice === null || !strikes.length) return null;
  let bestIndex = 0;
  let bestDifference = Math.abs(strikes[0] - numericPrice);
  for (let index = 1; index < strikes.length; index += 1) {
    const difference = Math.abs(strikes[index] - numericPrice);
    if (difference < bestDifference) {
      bestIndex = index;
      bestDifference = difference;
    }
  }
  return bestIndex;
}

function legValue(leg, key) {
  if (key === 'oi' && (typeof leg === 'number' || typeof leg === 'string')) return finite(leg);
  return finite(leg?.[key]);
}

function weightedOrSimpleAverage(entries) {
  const values = entries.filter((entry) => finite(entry.value) !== null);
  if (!values.length) return null;
  const weighted = values.filter((entry) => finite(entry.weight) !== null && Number(entry.weight) > 0);
  const totalWeight = weighted.reduce((total, entry) => total + Number(entry.weight), 0);
  if (totalWeight) return weighted.reduce((total, entry) => total + Number(entry.value) * Number(entry.weight), 0) / totalWeight;
  return values.reduce((total, entry) => total + Number(entry.value), 0) / values.length;
}

function emptySide() {
  return { oi: 0, volume: 0, prices: [], bidQuantity: 0, askQuantity: 0, quoteLegs: 0 };
}

function addLeg(side, leg) {
  if (!leg) return;
  side.oi += legValue(leg, 'oi') ?? 0;
  side.volume += legValue(leg, 'volume') ?? 0;
  const lastPrice = legValue(leg, 'lastPrice');
  if (lastPrice !== null) side.prices.push({ value: lastPrice, weight: legValue(leg, 'volume') });

  const bidQuantity = legValue(leg, 'topBidQuantity');
  const askQuantity = legValue(leg, 'topAskQuantity');
  if (bidQuantity !== null && askQuantity !== null) {
    side.bidQuantity += bidQuantity;
    side.askQuantity += askQuantity;
    side.quoteLegs += 1;
  }
}

function sidePoint(side, previous, prefix) {
  const bidAskDifference = side.quoteLegs ? side.bidQuantity - side.askQuantity : null;
  const depth = side.quoteLegs ? side.bidQuantity + side.askQuantity : null;
  return {
    [`${prefix}Oi`]: side.oi,
    [`${prefix}OiChange`]: previous && finite(previous[`${prefix}Oi`]) !== null ? side.oi - Number(previous[`${prefix}Oi`]) : null,
    [`${prefix}Volume`]: side.volume,
    [`${prefix}Price`]: weightedOrSimpleAverage(side.prices),
    [`${prefix}BidAskDifference`]: bidAskDifference,
    [`${prefix}BidAskImbalance`]: depth ? bidAskDifference / depth : null,
  };
}

/**
 * Builds one compact chart point from exactly three strict ITM Calls below the
 * underlying and three strict ITM Puts above it. The nearest ATM strike is
 * retained only as display metadata and never contributes to aggregates.
 */
export function buildChartPoint(snapshot, previousPoint, strikesEachSide) {
  const strikes = sortedStrikes(snapshot?.strikes);
  const timestamp = finite(snapshot?.t);
  const underlyingPrice = finite(snapshot?.underlyingPrice);
  const { callStrikes, putStrikes, atmStrike } = itmStrikeSets(strikes, underlyingPrice, strikesEachSide);
  const requiredPerSide = Math.max(1, Math.floor(Number(strikesEachSide) || 0));
  const selectedLegs = [
    ...callStrikes.map((strike) => snapshot?.strikes?.[strike]?.ce),
    ...putStrikes.map((strike) => snapshot?.strikes?.[strike]?.pe),
  ];
  if (timestamp === null || underlyingPrice === null || callStrikes.length !== requiredPerSide || putStrikes.length !== requiredPerSide || selectedLegs.some((leg) => legValue(leg, 'oi') === null)) return null;

  const call = emptySide();
  const put = emptySide();
  callStrikes.forEach((strike) => addLeg(call, snapshot.strikes[strike]?.ce));
  putStrikes.forEach((strike) => addLeg(put, snapshot.strikes[strike]?.pe));

  return {
    t: timestamp,
    underlyingPrice,
    underlyingPriceChange: previousPoint && finite(previousPoint.underlyingPrice) !== null
      ? underlyingPrice - Number(previousPoint.underlyingPrice)
      : null,
    atmStrike,
    callItmStrikes: callStrikes,
    putItmStrikes: putStrikes,
    ...sidePoint(call, previousPoint, 'call'),
    ...sidePoint(put, previousPoint, 'put'),
  };
}

export function appendChartPoint(points, point, cutoffMs, eventBucketMs = 0) {
  if (!point) return points;
  const previous = points[points.length - 1];
  if (previous && eventBucketMs > 0 && point.t - previous.t < eventBucketMs) {
    // Lightweight Charts uses second-resolution timestamps. Replacing a nearby
    // point keeps the latest live state in that second-sized event bucket,
    // rather than emitting conflicting points at the same chart time.
    point.t = previous.t;
    points[points.length - 1] = point;
  } else {
    points.push(point);
  }
  while (points.length && points[0].t < cutoffMs) points.shift();
  return points;
}
