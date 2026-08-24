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

function legOi(leg) {
  const value = typeof leg === 'object' && leg !== null ? leg.oi : leg;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function calculateBandDelta({ cur, ref, strikesEachSide, requestedWindowMs, referenceMode, provisional }) {
  if (!cur?.strikes || !ref?.strikes) return null;
  const allStrikes = sortedStrikes(cur.strikes);
  const atmIndex = nearestStrikeIndex(allStrikes, cur.underlyingPrice);
  if (atmIndex === null) return null;

  const atm = allStrikes[atmIndex];
  const band = [];
  let bandDeltaCe = 0;
  let bandDeltaPe = 0;
  let bandDeltaTotal = 0;
  for (let offset = -strikesEachSide; offset <= strikesEachSide; offset += 1) {
    const strikeIndex = atmIndex + offset;
    if (strikeIndex < 0 || strikeIndex >= allStrikes.length) continue;
    const strike = allStrikes[strikeIndex];
    const curLeg = cur.strikes[strike];
    const refLeg = ref.strikes[strike];
    if (!curLeg || !refLeg) continue;
    const dCe = legOi(curLeg.ce) - legOi(refLeg.ce);
    const dPe = legOi(curLeg.pe) - legOi(refLeg.pe);
    const dTotal = dCe + dPe;
    bandDeltaCe += dCe;
    bandDeltaPe += dPe;
    bandDeltaTotal += dTotal;
    band.push({ strike, isATM: offset === 0, offset, dCe, dPe, dTotal });
  }

  if (!band.length) return null;
  const actualSpanMs = Math.max(0, Number(cur.t) - Number(ref.t));
  return {
    fromT: ref.t,
    toT: cur.t,
    actualSpanMs,
    requestedWindowMs,
    referenceMode,
    provisional,
    atmStrike: atm,
    strikeStep: bandStep(allStrikes),
    band,
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
