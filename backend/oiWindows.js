import { buildMarketStrength } from './marketStrength.js';

export function sortedStrikes(strikes) {
  return Object.keys(strikes || {})
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

export function nearestStrikeIndex(strikes, price) {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || !strikes.length) return null;
  let bestIndex = 0;
  let bestDiff = Math.abs(strikes[0] - numericPrice);
  for (let i = 1; i < strikes.length; i += 1) {
    const diff = Math.abs(strikes[i] - numericPrice);
    if (diff < bestDiff) {
      bestIndex = i;
      bestDiff = diff;
    }
  }
  return bestIndex;
}

export function bandStep(strikes) {
  const steps = [];
  for (let i = 1; i < strikes.length; i += 1) steps.push(strikes[i] - strikes[i - 1]);
  return steps.length && steps.every((step) => step === steps[0]) ? steps[0] : null;
}

/**
 * Calls are strictly ITM below the underlying price; puts are strictly ITM
 * above it. Each returned list starts with the closest available ITM strike.
 */
export function itmStrikeSets(strikes, underlyingPrice, count) {
  const numericPrice = Number(underlyingPrice);
  const requested = Math.max(1, Math.floor(Number(count) || 0));
  if (!Number.isFinite(numericPrice)) return { callStrikes: [], putStrikes: [], atmStrike: null };
  const allStrikes = [...strikes].filter(Number.isFinite).sort((a, b) => a - b);
  const callStrikes = allStrikes.filter((strike) => strike < numericPrice).slice(-requested).reverse();
  const putStrikes = allStrikes.filter((strike) => strike > numericPrice).slice(0, requested);
  const atmIndex = nearestStrikeIndex(allStrikes, numericPrice);
  return { callStrikes, putStrikes, atmStrike: atmIndex === null ? null : allStrikes[atmIndex] };
}

function legOi(leg) {
  const value = typeof leg === 'object' && leg !== null ? leg.oi : leg;
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function calculateBandDelta({ cur, ref, strikesEachSide, requestedWindowMs, referenceMode, provisional }) {
  if (!cur?.strikes || !ref?.strikes) return null;
  const allStrikes = sortedStrikes(cur.strikes);
  const { callStrikes, putStrikes, atmStrike } = itmStrikeSets(allStrikes, cur.underlyingPrice, strikesEachSide);
  if (!callStrikes.length && !putStrikes.length) return null;
  const band = [];
  let bandDeltaCe = 0;
  let bandDeltaPe = 0;
  let bandDeltaTotal = 0;
  const addItmLeg = (strike, optionSide, offset) => {
    const curLeg = cur.strikes[strike];
    const refLeg = ref.strikes[strike];
    if (!curLeg || !refLeg) return;
    const current = legOi(curLeg[optionSide]);
    const reference = legOi(refLeg[optionSide]);
    if (!Number.isFinite(current) || !Number.isFinite(reference)) return;
    const delta = current - reference;
    const dCe = optionSide === 'ce' ? delta : null;
    const dPe = optionSide === 'pe' ? delta : null;
    if (optionSide === 'ce') bandDeltaCe += delta;
    else bandDeltaPe += delta;
    bandDeltaTotal += delta;
    band.push({ strike, optionSide, moneyness: 'ITM', offset, dCe, dPe, dTotal: delta });
  };
  callStrikes.forEach((strike, index) => addItmLeg(strike, 'ce', -(index + 1)));
  putStrikes.forEach((strike, index) => addItmLeg(strike, 'pe', index + 1));

  if (!band.length) return null;
  const actualSpanMs = Math.max(0, Number(cur.t) - Number(ref.t));
  return {
    fromT: ref.t,
    toT: cur.t,
    actualSpanMs,
    requestedWindowMs,
    referenceMode,
    provisional,
    atmStrike,
    strikeStep: bandStep(allStrikes),
    band,
    callItmStrikes: callStrikes,
    putItmStrikes: putStrikes,
    bandDeltaCe,
    bandDeltaPe,
    bandDeltaTotal,
    marketStrength: buildMarketStrength({ cur, ref, band, actualSpanMs }),
  };
}

// Uses a completed lookback only when a reference at or before the requested
// start time exists. This keeps mature 5m/30m/3h cards exact.
export function exactWindowDelta(history, nowMs, windowMs, strikesEachSide) {
  if (history.length < 2) return null;
  const cur = history[history.length - 1];
  const targetT = nowMs - windowMs;
  if (history[0].t > targetT) return null;
  let ref = history[0];
  for (const snapshot of history) {
    if (snapshot.t <= targetT) ref = snapshot;
    else break;
  }
  if (ref.t === cur.t) return null;
  return calculateBandDelta({
    cur,
    ref,
    strikesEachSide,
    requestedWindowMs: windowMs,
    referenceMode: 'exact-window',
    provisional: false,
  });
}

// Before a complete interval exists, use the real start/reset snapshot as the
// reference. This makes all cards immediately readable at zero on reset,
// rather than fabricating a zero-valued market or withholding the card.
export function currentBaselineDelta(baseline, current, windowMs, strikesEachSide) {
  return calculateBandDelta({
    cur: current,
    ref: baseline,
    strikesEachSide,
    requestedWindowMs: windowMs,
    referenceMode: 'current-market-baseline',
    provisional: true,
  });
}
