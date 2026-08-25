import { randomUUID } from 'node:crypto';
import { nearestStrikeIndex, sortedStrikes } from './oiWindows.js';

const PAPER_SYMBOLS = ['NIFTY', 'SENSEX'];
const PORTFOLIO_IDS = ['portfolio1', 'portfolio2', 'portfolio3'];
const MAX_SECONDS = 86_400;
const MAX_OPTION_QUOTE_AGE_MS = 15_000;
const MAX_LOTS = 100_000;
const MAX_PREMIUM_OFFSET = 10_000;
const OI_WINDOWS = ['m5', 'm30', 'h3'];
const OI_METRICS = ['call', 'put', 'combined', 'difference'];
const TRADE_SIDES = ['auto', 'call', 'put'];

export const PAPER_PORTFOLIOS = {
  portfolio1: { id: 'portfolio1', label: 'Portfolio 1 · Strength strategy', strategy: 'market-strength' },
  portfolio2: { id: 'portfolio2', label: 'Portfolio 2 · Strength strategy', strategy: 'market-strength' },
  portfolio3: { id: 'portfolio3', label: 'Portfolio 3 · OI threshold', strategy: 'oi-threshold', directionMode: 'oi' },
};

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function positiveNumber(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = finite(value);
  if (parsed === null || parsed <= 0 || parsed > 10_000_000_000) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function positiveWholeNumber(value, fallback, name, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = finite(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${name} must be a whole number from 1 to ${max}.`);
  return parsed;
}

function wholeSeconds(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = finite(value);
  if (parsed === null || parsed < 0 || parsed > MAX_SECONDS || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be a whole number from 0 to ${MAX_SECONDS}.`);
  }
  return parsed;
}

function premiumOffset(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = finite(value);
  if (parsed === null || Math.abs(parsed) > MAX_PREMIUM_OFFSET) throw new Error(`Premium offset must be between -${MAX_PREMIUM_OFFSET} and ${MAX_PREMIUM_OFFSET}.`);
  return parsed;
}

function selectValue(value, allowed, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function defaultPortfolio(id) {
  const meta = PAPER_PORTFOLIOS[id];
  const shared = {
    id,
    enabled: false,
    lots: 10,
    symbolEnabled: Object.fromEntries(PAPER_SYMBOLS.map((symbol) => [symbol, true])),
    strengthThreshold: 60,
    entryPremiumOffset: 0,
    targetPoints: 2,
    stopLossPoints: 5,
    maxAliveSeconds: 0,
    cooldownSeconds: 0,
    strategy: meta.strategy,
  };
  if (id === 'portfolio3') return { ...shared, tradeSide: 'auto', oiWindow: 'm5', oiMetric: 'combined', oiThreshold: 1, directionMode: 'oi' };
  return { ...shared, reverseOrders: id === 'portfolio2' };
}

function normalizePortfolio(input = {}, base = {}, id) {
  const fallback = { ...defaultPortfolio(id), ...(base || {}) };
  const sourceSymbolEnabled = {
    ...(fallback.symbolEnabled || {}),
    ...(input.symbolEnabled && typeof input.symbolEnabled === 'object' ? input.symbolEnabled : {}),
  };
  const normalized = {
    id,
    enabled: input.enabled === undefined ? fallback.enabled === true : input.enabled === true,
    lots: positiveWholeNumber(input.lots, fallback.lots, 'Lots', MAX_LOTS),
    symbolEnabled: Object.fromEntries(PAPER_SYMBOLS.map((symbol) => [symbol, sourceSymbolEnabled[symbol] !== false])),
    strengthThreshold: positiveWholeNumber(input.strengthThreshold, fallback.strengthThreshold, 'Strength threshold', 100),
    entryPremiumOffset: premiumOffset(input.entryPremiumOffset, fallback.entryPremiumOffset),
    targetPoints: positiveNumber(input.targetPoints, fallback.targetPoints, 'Target'),
    stopLossPoints: positiveNumber(input.stopLossPoints, fallback.stopLossPoints, 'Stop-loss'),
    maxAliveSeconds: wholeSeconds(input.maxAliveSeconds, fallback.maxAliveSeconds, 'Maximum alive time'),
    cooldownSeconds: wholeSeconds(input.cooldownSeconds, fallback.cooldownSeconds, 'Cooldown'),
    strategy: PAPER_PORTFOLIOS[id].strategy,
  };
  if (id === 'portfolio3') return {
    ...normalized,
    tradeSide: selectValue(input.tradeSide, TRADE_SIDES, fallback.tradeSide, 'Trade side'),
    oiWindow: selectValue(input.oiWindow, OI_WINDOWS, fallback.oiWindow, 'OI window'),
    oiMetric: selectValue(input.oiMetric, OI_METRICS, fallback.oiMetric, 'OI metric'),
    oiThreshold: positiveNumber(input.oiThreshold, fallback.oiThreshold, 'OI threshold'),
    directionMode: 'oi',
  };
  return { ...normalized, reverseOrders: input.reverseOrders === undefined ? fallback.reverseOrders === true : input.reverseOrders === true };
}

function normalizeRules(input = {}, base = {}) {
  const inputPortfolioMap = input.portfolios && typeof input.portfolios === 'object' ? input.portfolios : null;
  const basePortfolioMap = base.portfolios && typeof base.portfolios === 'object' ? base.portfolios : {};
  const portfolios = Object.fromEntries(PORTFOLIO_IDS.map((id) => {
    const requested = inputPortfolioMap ? (inputPortfolioMap[id] || {}) : (id === 'portfolio1' ? input : {});
    return [id, normalizePortfolio(requested, basePortfolioMap[id] || defaultPortfolio(id), id)];
  }));
  const lastSessionReset = input.lastSessionReset && typeof input.lastSessionReset === 'object'
    ? { ...input.lastSessionReset }
    : base.lastSessionReset && typeof base.lastSessionReset === 'object' ? { ...base.lastSessionReset } : null;
  return {
    marketHoursEnabled: input.marketHoursEnabled === undefined ? base.marketHoursEnabled !== false : input.marketHoursEnabled === true,
    sessionResetEnabled: input.sessionResetEnabled === undefined ? base.sessionResetEnabled !== false : input.sessionResetEnabled === true,
    lastSessionReset,
    portfolios,
    enabled: Object.values(portfolios).some((portfolio) => portfolio.enabled === true),
  };
}

function strengthDirection(strength) {
  if (strength?.direction === 'up' || strength?.direction === 'down') return strength.direction;
  const label = strength?.label;
  if (label === 'Strong upward pressure' || label === 'Mild upward pressure') return 'up';
  if (label === 'Strong downward pressure' || label === 'Mild downward pressure') return 'down';
  return null;
}

function marketStrengthSignal(payload, portfolio) {
  const entries = [
    ['m5', '5 Min'],
    ['m30', '30 Min'],
    ['h3', '3 Hour'],
  ].map(([key, label]) => ({ key, label, window: payload?.windows?.[key] }))
    .filter((entry) => entry.window?.referenceMode === 'exact-window' && entry.window?.marketStrength);
  const preferred = entries.find((entry) => {
    const strength = entry.window.marketStrength;
    const intensity = finite(strength.intensity);
    return intensity !== null && intensity >= portfolio.strengthThreshold && strengthDirection(strength) !== null;
  });
  const direction = strengthDirection(preferred?.window?.marketStrength);
  if (!direction) return null;
  const followSide = direction === 'up' ? 'ce' : 'pe';
  return {
    direction,
    optionSide: followSide,
    window: preferred,
    intensity: preferred.window.marketStrength.intensity,
    label: preferred.window.marketStrength.label,
    triggerType: portfolio.reverseOrders ? 'reverse-market-strength' : 'market-strength',
  };
}

function oiMetricValue(window, metric) {
  const call = finite(window?.bandDeltaCe);
  const put = finite(window?.bandDeltaPe);
  if (call === null || put === null) return null;
  if (metric === 'call') return call;
  if (metric === 'put') return put;
  if (metric === 'difference') return call - put;
  return call + put;
}

function oiThresholdSignal(payload, portfolio) {
  const labels = { m5: '5 Min', m30: '30 Min', h3: '3 Hour' };
  const window = payload?.windows?.[portfolio.oiWindow];
  if (!window || window.referenceMode !== 'exact-window') return null;
  const value = oiMetricValue(window, portfolio.oiMetric);
  if (value === null || Math.abs(value) < portfolio.oiThreshold) return null;
  return {
    direction: value >= 0 ? 'up' : 'down',
    optionSide: value >= 0 ? 'ce' : 'pe',
    window: { key: portfolio.oiWindow, label: labels[portfolio.oiWindow], window },
    intensity: null,
    label: `${portfolio.oiMetric} ITM OI threshold`,
    triggerType: 'oi-threshold',
    oiMetric: portfolio.oiMetric,
    oiValue: value,
  };
}

function preferredSignal(payload, portfolio) {
  return portfolio.strategy === 'oi-threshold'
    ? oiThresholdSignal(payload, portfolio)
    : marketStrengthSignal(payload, portfolio);
}

function configuredOptionSide(signal, portfolio) {
  if (portfolio.tradeSide === 'call') return 'ce';
  if (portfolio.tradeSide === 'put') return 'pe';
  if (portfolio.strategy === 'market-strength' && portfolio.reverseOrders) return signal.optionSide === 'ce' ? 'pe' : 'ce';
  return signal.optionSide;
}

function liveOptionQuote(leg, timestamp) {
  const price = finite(leg?.lastPrice);
  const observedAt = finite(leg?.lastPriceAt);
  if (price === null || price <= 0 || observedAt === null || observedAt > timestamp || timestamp - observedAt > MAX_OPTION_QUOTE_AGE_MS) return null;
  return { price, observedAt };
}

function atmOption(summary, optionSide, timestamp) {
  const strikes = sortedStrikes(summary?.strikes);
  const index = nearestStrikeIndex(strikes, summary?.underlyingPrice);
  if (index === null) return null;
  const strike = strikes[index];
  const leg = summary.strikes?.[strike]?.[optionSide];
  const quote = liveOptionQuote(leg, timestamp);
  const securityId = finite(leg?.securityId);
  if (!quote || securityId === null) return null;
  return { strike, securityId, marketPrice: quote.price, observedAt: quote.observedAt };
}

function optionLastPrice(summary, trade, timestamp) {
  return liveOptionQuote(summary?.strikes?.[trade.strike]?.[trade.optionSide], timestamp);
}

export function createPaperTradeEngine({ store, rules, contractLotSizes = {}, onChange = () => {}, now = () => Date.now() }) {
  const trades = [];
  const signalStates = {};
  const cooldownUntil = {};
  const currentContractLotSizes = Object.fromEntries(PAPER_SYMBOLS.map((symbol) => {
    const size = finite(contractLotSizes[symbol]);
    return [symbol, size !== null && size > 0 ? size : 1];
  }));
  let currentRules = normalizeRules(rules, { marketHoursEnabled: true, sessionResetEnabled: true, lastSessionReset: null, portfolios: {} });
  let marketSession = { enabled: currentRules.marketHoursEnabled, active: true, reason: 'starting', timeZone: 'Asia/Kolkata', opensAt: '09:15', closesAt: '15:30' };
  let enabled = currentRules.enabled === true;
  let queue = Promise.resolve();

  const portfolioList = () => PORTFOLIO_IDS.map((id) => currentRules.portfolios[id]);
  const stateKey = (portfolioId, symbol) => `${portfolioId}:${symbol}`;

  function activeTrade(symbol, portfolioId = null) {
    return trades.find((trade) => trade.symbol === symbol && trade.status === 'open' && (!portfolioId || trade.portfolioId === portfolioId)) || null;
  }

  function activeTrades(symbol) {
    return trades.filter((trade) => trade.symbol === symbol && trade.status === 'open');
  }

  function activeEntry(symbol, portfolioId = null) {
    return trades.find((trade) => trade.symbol === symbol && (trade.status === 'open' || trade.status === 'pending') && (!portfolioId || trade.portfolioId === portfolioId)) || null;
  }

  function tradePnl(trade) {
    if (trade?.status === 'pending') return { points: null, money: null, contractLotSize: finite(trade?.contractLotSize) };
    const entryPrice = finite(trade?.entryPrice);
    const lots = Math.max(0, finite(trade?.lots) ?? 0);
    const storedLotSize = finite(trade?.contractLotSize);
    const contractLotSize = storedLotSize !== null && storedLotSize > 0 ? storedLotSize : currentContractLotSizes[trade?.symbol];
    if (entryPrice === null || !Number.isFinite(contractLotSize) || contractLotSize <= 0) return { points: null, money: null, contractLotSize: null };
    const points = trade?.status === 'open'
      ? (() => { const lastPrice = finite(trade?.lastPrice); return lastPrice === null ? null : lastPrice - entryPrice; })()
      : finite(trade?.resultPoints) ?? (() => { const exitPrice = finite(trade?.exitPrice); return exitPrice === null ? null : exitPrice - entryPrice; })();
    return { points, money: points === null ? null : points * lots * contractLotSize, contractLotSize };
  }

  function performance(portfolioId = null) {
    const selected = portfolioId ? trades.filter((trade) => trade.portfolioId === portfolioId) : trades;
    const totals = { totalTrades: selected.length, pendingEntries: 0, openTrades: 0, closedTrades: 0, winningClosedTrades: 0, losingClosedTrades: 0, realisedPoints: 0, unrealisedPoints: 0, netPoints: 0, realisedMoney: 0, unrealisedMoney: 0, netMoney: 0 };
    for (const trade of selected) {
      if (trade.status === 'pending') { totals.pendingEntries += 1; continue; }
      const pnl = tradePnl(trade);
      const isOpen = trade.status === 'open';
      if (isOpen) totals.openTrades += 1;
      else totals.closedTrades += 1;
      if (pnl.points === null || pnl.money === null) continue;
      if (isOpen) { totals.unrealisedPoints += pnl.points; totals.unrealisedMoney += pnl.money; }
      else { totals.realisedPoints += pnl.points; totals.realisedMoney += pnl.money; if (pnl.points > 0) totals.winningClosedTrades += 1; if (pnl.points < 0) totals.losingClosedTrades += 1; }
    }
    totals.netPoints = totals.realisedPoints + totals.unrealisedPoints;
    totals.netMoney = totals.realisedMoney + totals.unrealisedMoney;
    return totals;
  }

  function snapshot() {
    const portfolioPerformance = Object.fromEntries(PORTFOLIO_IDS.map((id) => [id, performance(id)]));
    const legacyPortfolioOne = currentRules.portfolios.portfolio1;
    const publicRules = { ...structuredClone(currentRules), ...legacyPortfolioOne, portfolios: structuredClone(currentRules.portfolios) };
    return {
      enabled,
      storage: store.getStatus(),
      rules: publicRules,
      portfolios: Object.fromEntries(PORTFOLIO_IDS.map((id) => [id, { ...PAPER_PORTFOLIOS[id], rules: { ...currentRules.portfolios[id] }, performance: portfolioPerformance[id] }])),
      lastSessionReset: currentRules.lastSessionReset ? { ...currentRules.lastSessionReset } : null,
      marketSession: { ...marketSession },
      contractLotSizes: { ...currentContractLotSizes },
      trades: [...trades].sort((a, b) => Number(b.requestedAt || b.openedAt || 0) - Number(a.requestedAt || a.openedAt || 0)),
      performance: performance(),
      portfolioPerformance,
    };
  }

  function changed() { onChange(snapshot()); }

  function restoreCooldowns() {
    for (const trade of trades) {
      const expiry = finite(trade.cooldownUntil);
      if (trade.status === 'closed' && expiry !== null) {
        const key = stateKey(trade.portfolioId || 'portfolio1', trade.symbol);
        cooldownUntil[key] = Math.max(cooldownUntil[key] || 0, expiry);
      }
    }
  }

  async function restore() {
    const storageReady = await store.initialize();
    if (!storageReady) { enabled = false; changed(); return snapshot(); }
    const restored = await store.load();
    trades.splice(0, trades.length, ...restored.trades.map((trade) => ({ ...trade, portfolioId: PORTFOLIO_IDS.includes(trade.portfolioId) ? trade.portfolioId : 'portfolio1' })));
    for (const [key, value] of Object.entries(restored.signalStates || {})) {
      signalStates[key.includes(':') ? key : stateKey('portfolio1', key)] = value;
    }
    restoreCooldowns();
    currentRules = normalizeRules(restored.settings || currentRules, currentRules);
    if (!restored.settings) await store.saveSettings(currentRules, now());
    enabled = currentRules.enabled === true;
    changed();
    return snapshot();
  }

  async function closeTrade(trade, exitPrice, closedAt, closeReason, exitPriceSource = 'option-ltp') {
    trade.status = 'closed';
    trade.closedAt = closedAt;
    trade.exitPrice = exitPrice;
    trade.exitPriceSource = exitPriceSource;
    trade.closeReason = closeReason;
    trade.resultPoints = exitPrice - trade.entryPrice;
    const cooldownSeconds = Number(trade.cooldownSecondsAtEntry) || 0;
    trade.cooldownUntil = closedAt + (cooldownSeconds * 1000);
    if (trade.cooldownUntil > closedAt) {
      const key = stateKey(trade.portfolioId || 'portfolio1', trade.symbol);
      cooldownUntil[key] = Math.max(cooldownUntil[key] || 0, trade.cooldownUntil);
    }
    await store.saveTrade(trade);
  }

  async function cancelPendingTrade(trade, timestamp, closeReason) {
    trade.status = 'cancelled';
    trade.closedAt = timestamp;
    trade.closeReason = closeReason;
    trade.resultPoints = 0;
    trade.cooldownUntil = timestamp;
    await store.saveTrade(trade);
  }

  function exitTrade(tradeId, timestamp = now()) {
    const operation = queue.then(async () => {
      if (!store.isReady()) { const error = new Error('Paper trade exits are unavailable until durable PostgreSQL storage is ready.'); error.statusCode = 503; throw error; }
      if (!tradeId || typeof tradeId !== 'string') { const error = new Error('A valid paper trade ID is required.'); error.statusCode = 400; throw error; }
      const trade = trades.find((entry) => entry.id === tradeId);
      if (!trade) { const error = new Error('Paper trade not found.'); error.statusCode = 404; throw error; }
      if (trade.status !== 'open') { const error = new Error('Only an open paper trade can be exited manually.'); error.statusCode = 409; throw error; }
      const exitPrice = finite(trade.lastPrice) ?? finite(trade.entryPrice);
      await closeTrade(trade, exitPrice, timestamp, 'manual-exit', 'last-observed-option-ltp');
      changed();
      return snapshot();
    });
    queue = operation.catch((err) => { console.error('[paper-trading]', err.message); return snapshot(); });
    return operation;
  }

  async function monitorOpen(trade, summary, timestamp) {
    const quote = optionLastPrice(summary, trade, timestamp);
    const currentPrice = quote?.price ?? null;
    if (quote) {
      trade.lastPrice = quote.price;
      trade.lastPriceObservedAt = quote.observedAt;
      trade.lastUpdatedAt = timestamp;
      if (quote.price >= trade.targetPrice) { await closeTrade(trade, quote.price, timestamp, 'target'); return true; }
      if (quote.price <= trade.stopLossPrice) { await closeTrade(trade, quote.price, timestamp, 'stop-loss'); return true; }
    }
    if (trade.expiresAt && timestamp >= trade.expiresAt) {
      await closeTrade(trade, currentPrice ?? finite(trade.lastPrice) ?? trade.entryPrice, timestamp, 'time-expired', currentPrice === null ? 'last-observed-option-ltp' : 'option-ltp');
      return true;
    }
    if (currentPrice !== null) await store.saveTrade(trade);
    return currentPrice !== null;
  }

  async function fillPending(trade, summary, timestamp) {
    if (trade.expiresAt && timestamp >= trade.expiresAt) {
      await cancelPendingTrade(trade, timestamp, 'limit-not-reached');
      return true;
    }
    const quote = optionLastPrice(summary, trade, timestamp);
    if (quote) {
      trade.lastPrice = quote.price;
      trade.lastPriceObservedAt = quote.observedAt;
      trade.lastUpdatedAt = timestamp;
      const fillable = trade.entryCondition === 'at-or-below' ? quote.price <= trade.requestedEntryPrice : quote.price >= trade.requestedEntryPrice;
      if (fillable) {
        trade.status = 'open';
        trade.entryPrice = quote.price;
        trade.entryPriceSource = 'live-option-ltp-pending-entry';
        trade.entryPriceObservedAt = quote.observedAt;
        trade.openedAt = timestamp;
        trade.targetPrice = quote.price + trade.targetPointsAtEntry;
        trade.stopLossPrice = Math.max(0, quote.price - trade.stopLossPointsAtEntry);
        await store.saveTrade(trade);
        return true;
      }
      await store.saveTrade(trade);
    }
    return quote !== null;
  }

  async function monitorEntries(symbol, summary, timestamp) {
    const changedPortfolioIds = new Set();
    const entries = trades.filter((trade) => trade.symbol === symbol && (trade.status === 'open' || trade.status === 'pending'));
    for (const trade of entries) {
      const pendingChanged = trade.status === 'pending' ? await fillPending(trade, summary, timestamp) : false;
      const openChanged = trade.status === 'open' ? await monitorOpen(trade, summary, timestamp) : false;
      if (pendingChanged || openChanged) changedPortfolioIds.add(trade.portfolioId || 'portfolio1');
    }
    return changedPortfolioIds;
  }

  async function setSignalState(portfolioId, symbol, direction, timestamp) {
    const key = stateKey(portfolioId, symbol);
    if ((signalStates[key] || null) === direction) return;
    signalStates[key] = direction;
    await store.saveSignalState(key, direction, timestamp);
  }

  async function maybeOpen(portfolio, symbol, payload, summary, timestamp) {
    const portfolioId = portfolio.id;
    if (portfolio.symbolEnabled[symbol] !== true) { await setSignalState(portfolioId, symbol, null, timestamp); return false; }
    const signal = preferredSignal(payload, portfolio);
    if (!signal) { await setSignalState(portfolioId, symbol, null, timestamp); return false; }
    await setSignalState(portfolioId, symbol, signal.direction, timestamp);
    const key = stateKey(portfolioId, symbol);
    if (activeEntry(symbol, portfolioId) || (cooldownUntil[key] || 0) > timestamp) return false;
    const optionSide = configuredOptionSide(signal, portfolio);
    const option = atmOption(summary, optionSide, timestamp);
    if (!option) return false;
    const offset = portfolio.entryPremiumOffset;
    const requestedEntryPrice = Math.max(0.01, option.marketPrice + offset);
    const pending = offset !== 0;
    const expiresAt = portfolio.maxAliveSeconds > 0 ? timestamp + (portfolio.maxAliveSeconds * 1000) : null;
    const trade = {
      id: randomUUID(),
      portfolioId,
      portfolioLabel: PAPER_PORTFOLIOS[portfolioId].label,
      strategy: portfolio.strategy,
      status: pending ? 'pending' : 'open',
      symbol,
      optionType: optionSide === 'ce' ? 'CALL' : 'PUT',
      optionSide,
      securityId: option.securityId,
      strike: option.strike,
      lots: portfolio.lots,
      contractLotSize: currentContractLotSizes[symbol],
      contractLotSizeSource: 'dhan-instrument-master-config',
      requestedAt: timestamp,
      marketPriceAtSignal: option.marketPrice,
      marketPriceObservedAt: option.observedAt,
      requestedEntryPrice,
      entryPremiumOffset: offset,
      entryCondition: offset < 0 ? 'at-or-below' : offset > 0 ? 'at-or-above' : 'market',
      entryPrice: pending ? null : option.marketPrice,
      entryPriceSource: pending ? null : 'live-option-ltp',
      entryPriceObservedAt: pending ? null : option.observedAt,
      lastPrice: option.marketPrice,
      lastPriceObservedAt: option.observedAt,
      targetPointsAtEntry: portfolio.targetPoints,
      stopLossPointsAtEntry: portfolio.stopLossPoints,
      targetPrice: pending ? null : option.marketPrice + portfolio.targetPoints,
      stopLossPrice: pending ? null : Math.max(0, option.marketPrice - portfolio.stopLossPoints),
      openedAt: pending ? null : timestamp,
      lastUpdatedAt: timestamp,
      expiresAt,
      strengthThreshold: portfolio.strengthThreshold,
      signalIntensity: signal.intensity,
      signalWindow: signal.window.label,
      signalLabel: signal.label,
      triggerType: signal.triggerType,
      oiMetric: signal.oiMetric || null,
      oiValueAtSignal: signal.oiValue ?? null,
      oiThreshold: portfolio.strategy === 'oi-threshold' ? portfolio.oiThreshold : null,
      cooldownSecondsAtEntry: portfolio.cooldownSeconds,
      source: 'dhan-live-paper-simulation',
      paperOnly: true,
    };
    trades.push(trade);
    await store.saveTrade(trade);
    return true;
  }

  async function disableAndClose(timestamp, { symbols = null, portfolioId = null, closeReason = 'simulator-disabled' } = {}) {
    const allowed = symbols ? new Set(symbols) : null;
    const entries = trades.filter((trade) => (trade.status === 'open' || trade.status === 'pending')
      && (!allowed || allowed.has(trade.symbol)) && (!portfolioId || trade.portfolioId === portfolioId));
    for (const trade of entries) {
      if (trade.status === 'pending') await cancelPendingTrade(trade, timestamp, closeReason);
      else await closeTrade(trade, finite(trade.lastPrice) ?? trade.entryPrice, timestamp, closeReason, 'last-observed-option-ltp');
    }
  }

  function resetSession({ sessionKey, timestamp = now() } = {}) {
    const operation = queue.then(async () => {
      if (!store.isReady()) { const error = new Error('Paper session reset is unavailable until durable PostgreSQL storage is ready.'); error.statusCode = 503; throw error; }
      if (!sessionKey || typeof sessionKey !== 'string') throw new Error('A valid paper session key is required for reset.');
      if (currentRules.lastSessionReset?.sessionKey === sessionKey) return snapshot();
      const entries = trades.filter((trade) => trade.status === 'open' || trade.status === 'pending');
      const openEntries = entries.filter((trade) => trade.status === 'open').length;
      const pendingEntries = entries.length - openEntries;
      const clearedRecords = trades.length;
      await disableAndClose(timestamp, { closeReason: 'session-reset' });
      if (await store.clearSessionHistory() !== true) {
        const error = new Error('Paper session reset could not clear durable paper records.');
        error.statusCode = 503;
        throw error;
      }
      trades.splice(0, trades.length);
      for (const key of Object.keys(signalStates)) delete signalStates[key];
      for (const key of Object.keys(cooldownUntil)) delete cooldownUntil[key];
      currentRules = { ...currentRules, lastSessionReset: { sessionKey, resetAt: timestamp, reason: 'session-reset', clearedRecords, closedOpenEntries: openEntries, cancelledPendingEntries: pendingEntries } };
      await store.saveSettings(currentRules, timestamp);
      changed();
      return snapshot();
    });
    queue = operation.catch((err) => { console.error('[paper-trading]', err.message); return snapshot(); });
    return operation;
  }

  function updateSettings(nextSettings, timestamp = now()) {
    const operation = queue.then(async () => {
      if (!store.isReady()) { const error = new Error('Paper simulator settings are unavailable until durable PostgreSQL storage is ready.'); error.statusCode = 503; throw error; }
      const nextRules = normalizeRules(nextSettings, currentRules);
      const legacyPortfolioOneUpdate = !nextSettings?.portfolios;
      for (const portfolioId of PORTFOLIO_IDS) {
        const previous = currentRules.portfolios[portfolioId];
        const next = nextRules.portfolios[portfolioId];
        if (previous.enabled === true && next.enabled === false) {
          await disableAndClose(timestamp, { portfolioId, closeReason: legacyPortfolioOneUpdate && portfolioId === 'portfolio1' ? 'simulator-disabled' : 'portfolio-disabled' });
          continue;
        }
        const disabledSymbols = PAPER_SYMBOLS.filter((symbol) => previous.symbolEnabled[symbol] === true && next.symbolEnabled[symbol] === false);
        if (disabledSymbols.length) await disableAndClose(timestamp, { portfolioId, symbols: disabledSymbols, closeReason: 'symbol-disabled' });
      }
      currentRules = nextRules;
      enabled = currentRules.enabled === true;
      await store.saveSettings(currentRules, timestamp);
      changed();
      return snapshot();
    });
    queue = operation.catch((err) => { console.error('[paper-trading]', err.message); return snapshot(); });
    return operation;
  }

  function setMarketSession(nextSession) {
    queue = queue.then(async () => {
      marketSession = { ...marketSession, ...(nextSession || {}) };
      changed();
      return snapshot();
    }).catch((err) => { console.error('[paper-trading]', err.message); return snapshot(); });
    return queue;
  }

  function expire(timestamp = now()) {
    queue = queue.then(async () => {
      if (marketSession.active === false) return snapshot();
      const expiring = trades.filter((trade) => (trade.status === 'open' || trade.status === 'pending') && trade.expiresAt && timestamp >= trade.expiresAt);
      for (const trade of expiring) {
        if (trade.status === 'pending') await cancelPendingTrade(trade, timestamp, 'limit-not-reached');
        else await closeTrade(trade, finite(trade.lastPrice) ?? trade.entryPrice, timestamp, 'time-expired', 'last-observed-option-ltp');
      }
      if (expiring.length) changed();
      return snapshot();
    }).catch((err) => { console.error('[paper-trading]', err.message); return snapshot(); });
    return queue;
  }

  function process(symbol, payload, summary, timestamp = now()) {
    queue = queue.then(async () => {
      if (!summary || !payload || marketSession.active === false) return snapshot();
      const monitored = enabled ? await monitorEntries(symbol, summary, timestamp) : new Set();
      let opened = false;
      if (enabled) {
        for (const portfolio of portfolioList()) {
          if (portfolio.enabled && !monitored.has(portfolio.id)) opened = (await maybeOpen(portfolio, symbol, payload, summary, timestamp)) || opened;
        }
      }
      if (monitored.size || opened) changed();
      return snapshot();
    }).catch((err) => { console.error('[paper-trading]', err.message); return snapshot(); });
    return queue;
  }

  return { restore, process, expire, snapshot, activeTrade, activeTrades, activeEntry, exitTrade, updateSettings, setMarketSession, resetSession };
}
