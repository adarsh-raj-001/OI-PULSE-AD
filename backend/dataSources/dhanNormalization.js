export function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function fieldNumber(fields, ...names) {
  for (const name of names) {
    const value = numericOrNull(fields?.[name]);
    if (value !== null) return value;
  }
  return null;
}

export function normalizeLeg(leg) {
  return {
    securityId: fieldNumber(leg, 'security_id', 'securityId'),
    // A missing OI is unavailable data, not an actual zero position. Keeping
    // it null prevents a later window subtraction from manufacturing a large
    // apparent change against a placeholder zero.
    oi: fieldNumber(leg, 'oi'),
    previousOi: fieldNumber(leg, 'previous_oi', 'previousOi'),
    lastPrice: fieldNumber(leg, 'last_price', 'lastPrice'),
    volume: fieldNumber(leg, 'volume'),
    impliedVolatility: fieldNumber(leg, 'implied_volatility', 'impliedVolatility'),
    topBidPrice: fieldNumber(leg, 'top_bid_price', 'topBidPrice'),
    topBidQuantity: fieldNumber(leg, 'top_bid_quantity', 'topBidQuantity'),
    topAskPrice: fieldNumber(leg, 'top_ask_price', 'topAskPrice'),
    topAskQuantity: fieldNumber(leg, 'top_ask_quantity', 'topAskQuantity'),
  };
}
