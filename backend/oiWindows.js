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
  const atmIndex = nearestStrikeIndex(allStrikes, numericPrice);
  const atmStrike = atmIndex === null ? null : allStrikes[atmIndex];
  const callStrikes = allStrikes.filter((strike) => strike < numericPrice && strike !== atmStrike).slice(-requested).reverse();
  const putStrikes = allStrikes.filter((strike) => strike > numericPrice && strike !== atmStrike).slice(0, requested);
  return { callStrikes, putStrikes, atmStrike };
}

function legOi(leg) {
  const value = typeof leg === 'object' && leg !== null ? leg.oi : leg;
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function changePct(change, baseline) {
  if (!Number.isFinite(change) || !Number.isFinite(baseline) || baseline === 0) return null;
  return (change / Math.abs(baseline)) * 100;
}

function calculateBandDelta({ cur, ref, strikesEachSide, requestedWindowMs, referenceMode, provisional, windowStartAt = null, windowEndAt = null }) {
  if (!cur?.strikes || !ref?.strikes) return null;
  const allStrikes = sortedStrikes(cur.strikes);
  const { callStrikes, putStrikes, atmStrike } = itmStrikeSets(allStrikes, cur.underlyingPrice, strikesEachSide);
  const requiredPerSide = Math.max(1, Math.floor(Number(strikesEachSide) || 0));
  if (callStrikes.length !== requiredPerSide || putStrikes.length !== requiredPerSide) return null;
  const band = [];
  let bandDeltaCe = 0;
  let bandDeltaPe = 0;
  let bandDeltaTotal = 0;
  let callItmOiBaseline = 0;
  let putItmOiBaseline = 0;
  let callItmOiCurrent = 0;
  let putItmOiCurrent = 0;
  const addItmLeg = (strike, optionSide, offset) => {
    const curLeg = cur.strikes[strike];
    const refLeg = ref.strikes[strike];
    if (!curLeg || !refLeg) return false;
    const current = legOi(curLeg[optionSide]);
    const reference = legOi(refLeg[optionSide]);
    if (!Number.isFinite(current) || !Number.isFinite(reference)) return false;
    const delta = current - reference;
    const dCe = optionSide === 'ce' ? delta : null;
    const dPe = optionSide === 'pe' ? delta : null;
    if (optionSide === 'ce') {
      bandDeltaCe += delta;
      callItmOiBaseline += reference;
      callItmOiCurrent += current;
    } else {
      bandDeltaPe += delta;
      putItmOiBaseline += reference;
      putItmOiCurrent += current;
    }
    bandDeltaTotal += delta;
    band.push({ strike, optionSide, moneyness: 'ITM', offset, referenceOi: reference, currentOi: current, oiChangePct: changePct(delta, reference), dCe, dPe, dTotal: delta });
    return true;
  };
  const complete = [
    ...callStrikes.map((strike, index) => addItmLeg(strike, 'ce', -(index + 1))),
    ...putStrikes.map((strike, index) => addItmLeg(strike, 'pe', index + 1)),
  ].every(Boolean);

  if (!complete || band.length !== requiredPerSide * 2) return null;
  const actualSpanMs = Math.max(0, Number(cur.t) - Number(ref.t));
  const callItmOiChangePct = changePct(bandDeltaCe, callItmOiBaseline);
  const putItmOiChangePct = changePct(bandDeltaPe, putItmOiBaseline);
  const bandDeltaTotalPct = changePct(bandDeltaTotal, callItmOiBaseline + putItmOiBaseline);
  const bandDeltaDifferencePct = callItmOiChangePct === null || putItmOiChangePct === null ? null : callItmOiChangePct - putItmOiChangePct;
  const marketStrength = buildMarketStrength({ cur, ref, band, actualSpanMs });
  marketStrength.aggregates = {
    ...marketStrength.aggregates,
    callWindowOiBaseline: callItmOiBaseline,
    putWindowOiBaseline: putItmOiBaseline,
    callWindowOiCurrent: callItmOiCurrent,
    putWindowOiCurrent: putItmOiCurrent,
    callWindowOiChangePct: callItmOiChangePct,
    putWindowOiChangePct: putItmOiChangePct,
    totalWindowOiChangePct: bandDeltaTotalPct,
  };
  return {
    fromT: ref.t,
    toT: cur.t,
    actualSpanMs,
    requestedWindowMs,
    referenceMode,
    provisional,
    windowStartAt,
    windowEndAt,
    atmStrike,
    strikeStep: bandStep(allStrikes),
    band,
    callItmStrikes: callStrikes,
    putItmStrikes: putStrikes,
    bandDeltaCe,
    bandDeltaPe,
    bandDeltaTotal,
    callItmOiBaseline,
    putItmOiBaseline,
    callItmOiCurrent,
    putItmOiCurrent,
    callItmOiChangePct,
    putItmOiChangePct,
    bandDeltaTotalPct,
    bandDeltaDifferencePct,
    marketStrength,
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

const INDIA_STANDARD_TIME_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// The market is in India, which has a fixed UTC+05:30 offset. Shift by that
// offset before flooring so every interval starts on an India wall-clock mark:
// 5m at :00/:05…, 30m at :00/:30, and 3h at 09:00/12:00/15:00.
export function standardClockWindowStart(nowMs, windowMs) {
  const now = Number(nowMs);
  const span = Number(windowMs);
  if (!Number.isFinite(now) || !Number.isFinite(span) || span <= 0) return null;
  return Math.floor((now + INDIA_STANDARD_TIME_OFFSET_MS) / span) * span - INDIA_STANDARD_TIME_OFFSET_MS;
}

// The first real snapshot collected at or after a standard-clock boundary is
// that window's reference. Its delta is therefore zero, and all later deltas
// in the block use that same current-market baseline rather than a rolling
// lookback. A manual/session reset naturally behaves the same way because it
// clears retained snapshots and starts a new real snapshot history.
export function clockAlignedWindowDelta(history, nowMs, windowMs, strikesEachSide) {
  if (!Array.isArray(history) || !history.length) return null;
  const cur = history[history.length - 1];
  const windowStartAt = standardClockWindowStart(nowMs, windowMs);
  if (windowStartAt === null || Number(cur?.t) < windowStartAt) return null;
  const ref = history.find((snapshot) => Number(snapshot?.t) >= windowStartAt);
  if (!ref) return null;
  return calculateBandDelta({
    cur,
    ref,
    strikesEachSide,
    requestedWindowMs: windowMs,
    referenceMode: 'clock-aligned-baseline',
    provisional: false,
    windowStartAt,
    windowEndAt: windowStartAt + windowMs,
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
