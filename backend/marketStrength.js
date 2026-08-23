// Market-strength helpers for OI Pulse. The directional score is deliberately
// based on price, option-premium and best-quote pressure. OI and volume are
// exposed as side-activity context rather than treated as a standalone forecast.

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

const sum = (values) => values.reduce((total, value) => total + (finite(value) ?? 0), 0);

const ratio = (numerator, denominator) => {
  const top = finite(numerator);
  const bottom = finite(denominator);
  if (top === null || bottom === null || bottom === 0) return null;
  return top / bottom;
};

const bpsChange = (current, reference) => {
  const now = finite(current);
  const before = finite(reference);
  if (now === null || before === null || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 10_000;
};

function weightedAverage(entries) {
  const valid = entries.filter((entry) => finite(entry.value) !== null && finite(entry.weight) !== null && Number(entry.weight) > 0);
  const totalWeight = sum(valid.map((entry) => entry.weight));
  if (!totalWeight) return null;
  return sum(valid.map((entry) => Number(entry.value) * Number(entry.weight))) / totalWeight;
}

function quoteStats(leg) {
  const bidPrice = finite(leg?.topBidPrice);
  const askPrice = finite(leg?.topAskPrice);
  const bidQuantity = finite(leg?.topBidQuantity);
  const askQuantity = finite(leg?.topAskQuantity);
  const depth = bidQuantity !== null && askQuantity !== null && bidQuantity + askQuantity > 0 ? bidQuantity + askQuantity : null;
  const imbalance = depth ? (bidQuantity - askQuantity) / depth : null;
  const mid = bidPrice !== null && askPrice !== null ? (bidPrice + askPrice) / 2 : null;
  const spreadBps = mid && askPrice >= bidPrice ? ((askPrice - bidPrice) / mid) * 10_000 : null;
  return { bidPrice, askPrice, bidQuantity, askQuantity, depth, imbalance, spreadBps };
}

function direction(score, confidence) {
  if (score === null || confidence < 35) {
    return { label: 'Limited data', behavior: 'Direction is unavailable until price and quote data are complete.' };
  }
  if (score >= 0.6) return { label: 'Strong upward pressure', behavior: 'Current price, option premium and best-quote inputs align to the upside.' };
  if (score >= 0.2) return { label: 'Mild upward pressure', behavior: 'More inputs lean upward, but conviction remains moderate.' };
  if (score <= -0.6) return { label: 'Strong downward pressure', behavior: 'Current price, option premium and best-quote inputs align to the downside.' };
  if (score <= -0.2) return { label: 'Mild downward pressure', behavior: 'More inputs lean downward, but conviction remains moderate.' };
  return { label: 'Balanced / mixed', behavior: 'The available directional inputs are offsetting each other.' };
}

export function buildMarketStrength({ cur, ref, band, actualSpanMs }) {
  const call = { oi: 0, sessionOiChange: 0, volume: 0, bidQuantity: 0, askQuantity: 0, premiumChanges: [], book: [], spreads: [], bidPrices: [], askPrices: [], iv: [], validQuotes: 0, legs: 0 };
  const put = { oi: 0, sessionOiChange: 0, volume: 0, bidQuantity: 0, askQuantity: 0, premiumChanges: [], book: [], spreads: [], bidPrices: [], askPrices: [], iv: [], validQuotes: 0, legs: 0 };

  for (const row of band) {
    const now = cur.strikes[row.strike];
    const before = ref.strikes[row.strike];
    if (!now || !before) continue;
    for (const [side, field, windowChange] of [['ce', call, row.dCe], ['pe', put, row.dPe]]) {
      const currentLeg = now[side];
      const referenceLeg = before[side];
      if (!currentLeg) continue;
      field.legs += 1;
      field.oi += finite(currentLeg.oi) ?? 0;
      const previousOi = finite(currentLeg.previousOi);
      const currentOi = finite(currentLeg.oi);
      if (previousOi !== null && currentOi !== null) field.sessionOiChange += currentOi - previousOi;
      field.volume += finite(currentLeg.volume) ?? 0;
      const premiumBps = bpsChange(currentLeg.lastPrice, referenceLeg?.lastPrice);
      if (premiumBps !== null) field.premiumChanges.push({ value: premiumBps, weight: Math.max(finite(currentLeg.volume) ?? 1, 1) });
      const quote = quoteStats(currentLeg);
      if (quote.depth !== null && quote.imbalance !== null) {
        field.book.push({ value: quote.imbalance, weight: quote.depth });
        field.validQuotes += 1;
      }
      if (quote.bidQuantity !== null) field.bidQuantity += quote.bidQuantity;
      if (quote.askQuantity !== null) field.askQuantity += quote.askQuantity;
      if (quote.depth !== null && quote.spreadBps !== null) field.spreads.push({ value: quote.spreadBps, weight: quote.depth });
      if (quote.bidPrice !== null && quote.bidQuantity !== null) field.bidPrices.push({ value: quote.bidPrice, weight: Math.max(quote.bidQuantity, 1) });
      if (quote.askPrice !== null && quote.askQuantity !== null) field.askPrices.push({ value: quote.askPrice, weight: Math.max(quote.askQuantity, 1) });
      const iv = finite(currentLeg.impliedVolatility);
      if (iv !== null) field.iv.push({ value: iv, weight: Math.max(currentOi ?? 1, 1) });
      // Keep this reference explicit: selected-window OI change comes from the
      // backend's exact snapshot window, not from Dhan previous-day fields.
      field.windowOiChange = (field.windowOiChange ?? 0) + (finite(windowChange) ?? 0);
    }
  }

  const priceBps = bpsChange(cur.underlyingPrice, ref.underlyingPrice);
  const callPremiumBps = weightedAverage(call.premiumChanges);
  const putPremiumBps = weightedAverage(put.premiumChanges);
  const callBookImbalance = weightedAverage(call.book);
  const putBookImbalance = weightedAverage(put.book);
  const callSpreadBps = weightedAverage(call.spreads);
  const putSpreadBps = weightedAverage(put.spreads);
  const callBidPrice = weightedAverage(call.bidPrices);
  const callAskPrice = weightedAverage(call.askPrices);
  const putBidPrice = weightedAverage(put.bidPrices);
  const putAskPrice = weightedAverage(put.askPrices);
  const callIV = weightedAverage(call.iv);
  const putIV = weightedAverage(put.iv);

  const priceScaleBps = Math.max(15, 15 * Math.sqrt(Math.max(actualSpanMs, 300_000) / 300_000));
  const priceScore = priceBps === null ? null : Math.tanh(priceBps / priceScaleBps);
  const premiumScore = callPremiumBps === null || putPremiumBps === null ? null : Math.tanh((callPremiumBps - putPremiumBps) / 500);
  const bookScore = callBookImbalance === null || putBookImbalance === null ? null : clamp((callBookImbalance - putBookImbalance) / 2, -1, 1);
  const components = [
    { value: priceScore, weight: 0.45 },
    { value: premiumScore, weight: 0.35 },
    { value: bookScore, weight: 0.2 },
  ].filter((component) => component.value !== null);
  const availableWeight = sum(components.map((component) => component.weight));
  const score = availableWeight ? clamp(sum(components.map((component) => Number(component.value) * component.weight)) / availableWeight, -1, 1) : null;
  const quoteCoveragePct = call.legs + put.legs ? ((call.validQuotes + put.validQuotes) / (call.legs + put.legs)) * 100 : 0;
  const confidence = Math.round(clamp((availableWeight / 1) * 70 + (quoteCoveragePct / 100) * 30, 0, 100));

  const oiActivity = Math.abs(call.windowOiChange ?? 0) + Math.abs(put.windowOiChange ?? 0);
  const volumeActivity = call.volume + put.volume;
  const callSideStrength = oiActivity || volumeActivity
    ? ((Math.abs(call.windowOiChange ?? 0) / (oiActivity || 1)) * 0.65 + (call.volume / (volumeActivity || 1)) * 0.35) * 100
    : null;
  const putSideStrength = callSideStrength === null ? null : 100 - callSideStrength;
  const sideGap = callSideStrength === null || putSideStrength === null ? null : Math.abs(callSideStrength - putSideStrength);
  const strongerSide = sideGap === null || sideGap < 6 ? 'Balanced activity' : callSideStrength > putSideStrength ? 'Call activity stronger' : 'Put activity stronger';
  const classification = direction(score, confidence);

  return {
    score,
    intensity: score === null ? null : Math.round(Math.abs(score) * 100),
    direction: score === null ? 'neutral' : score > 0.05 ? 'up' : score < -0.05 ? 'down' : 'neutral',
    confidence,
    ...classification,
    drivers: { priceBps, priceScore, callPremiumBps, putPremiumBps, premiumScore, callBookImbalance, putBookImbalance, bookScore },
    aggregates: {
      callWindowOiChange: call.windowOiChange ?? 0,
      putWindowOiChange: put.windowOiChange ?? 0,
      callCurrentOi: call.oi,
      putCurrentOi: put.oi,
      putCallOiRatio: ratio(put.oi, call.oi),
      callSessionOiChange: call.sessionOiChange,
      putSessionOiChange: put.sessionOiChange,
      callVolume: call.volume,
      putVolume: put.volume,
      putCallVolumeRatio: ratio(put.volume, call.volume),
      callBidQuantity: call.bidQuantity,
      callAskQuantity: call.askQuantity,
      callBidAskQuantityDifference: call.bidQuantity - call.askQuantity,
      putBidQuantity: put.bidQuantity,
      putAskQuantity: put.askQuantity,
      putBidAskQuantityDifference: put.bidQuantity - put.askQuantity,
      callWeightedBidPrice: callBidPrice,
      callWeightedAskPrice: callAskPrice,
      putWeightedBidPrice: putBidPrice,
      putWeightedAskPrice: putAskPrice,
      callSideStrength,
      putSideStrength,
      strongerSide,
      callSpreadBps,
      putSpreadBps,
      callIV,
      putIV,
      quoteCoveragePct,
    },
  };
}
