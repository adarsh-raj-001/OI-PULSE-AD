import { randomUUID } from 'node:crypto';
import { nearestStrikeIndex, sortedStrikes } from './oiWindows.js';

const LOT_SIZES = new Set([10, 20]);
const TRIGGER_LEVELS = new Set(['strong', 'mild']);
const PAPER_SYMBOLS = ['NIFTY', 'SENSEX'];
const MAX_SECONDS = 86_400;
const MAX_OPTION_QUOTE_AGE_MS = 15_000;

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function positiveNumber(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = finite(value);
  if (parsed === null || parsed <= 0 || parsed > 10_000) throw new Error(`${name} must be a positive number.`);
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

function normalizeRules(input = {}, base = {}) {
  const enabled = input.enabled === undefined ? base.enabled === true : input.enabled === true;
  const lotsCandidate = input.lots === undefined || input.lots === null || input.lots === '' ? base.lots : Number(input.lots);
  if (!LOT_SIZES.has(lotsCandidate)) throw new Error('Lot size must be 10 or 20 lots.');
  const triggerCandidate = input.triggerLevel === undefined || input.triggerLevel === null || input.triggerLevel === ''
    ? (base.triggerLevel || 'strong')
    : String(input.triggerLevel).toLowerCase();
  if (!TRIGGER_LEVELS.has(triggerCandidate)) throw new Error('Trigger level must be mild or strong.');
  const sourceSymbolEnabled = {
    ...(base.symbolEnabled || {}),
    ...(input.symbolEnabled && typeof input.symbolEnabled === 'object' ? input.symbolEnabled : {}),
  };
  const symbolEnabled = Object.fromEntries(PAPER_SYMBOLS.map((symbol) => [symbol, sourceSymbolEnabled[symbol] !== false]));
  return {
    enabled,
    lots: lotsCandidate,
    symbolEnabled,
    triggerLevel: triggerCandidate,
    targetPoints: positiveNumber(input.targetPoints, base.targetPoints ?? 2, 'Target'),
    stopLossPoints: positiveNumber(input.stopLossPoints, base.stopLossPoints ?? 5, 'Stop-loss'),
    maxAliveSeconds: wholeSeconds(input.maxAliveSeconds, base.maxAliveSeconds ?? 0, 'Maximum alive time'),
    cooldownSeconds: wholeSeconds(input.cooldownSeconds, base.cooldownSeconds ?? 0, 'Cooldown'),
  };
}

function preferredSignal(payload, triggerLevel) {
  const entries = [
    ['m5', '5 Min'],
    ['m30', '30 Min'],
    ['h3', '3 Hour'],
  ].map(([key, label]) => ({ key, label, window: payload?.windows?.[key] }))
    .filter((entry) => entry.window?.referenceMode === 'exact-window' && entry.window?.marketStrength);
  const qualifyingLabels = triggerLevel === 'mild'
    ? new Set(['Strong upward pressure', 'Strong downward pressure', 'Mild upward pressure', 'Mild downward pressure'])
    : new Set(['Strong upward pressure', 'Strong downward pressure']);
  const preferred = entries.find((entry) => qualifyingLabels.has(entry.window.marketStrength.label));
  const label = preferred?.window?.marketStrength?.label;
  if (label === 'Strong upward pressure' || label === 'Mild upward pressure') return { direction: 'up', optionSide: 'ce', window: preferred };
  if (label === 'Strong downward pressure' || label === 'Mild downward pressure') return { direction: 'down', optionSide: 'pe', window: preferred };
  return null;
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
  return {
    strike,
    securityId,
    entryPrice: quote.price,
    entryPriceSource: 'live-option-ltp',
    entryPriceObservedAt: quote.observedAt,
  };
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
  let currentRules = normalizeRules(rules, {
    enabled: false,
    lots: 10,
    symbolEnabled: Object.fromEntries(PAPER_SYMBOLS.map((symbol) => [symbol, true])),
    triggerLevel: 'strong',
    targetPoints: 2,
    stopLossPoints: 5,
    maxAliveSeconds: 0,
    cooldownSeconds: 0,
  });
  let enabled = false;
  let queue = Promise.resolve();

  function activeTrade(symbol) {
    return trades.find((trade) => trade.symbol === symbol && trade.status === 'open') || null;
  }

  function tradePnl(trade) {
    const entryPrice = finite(trade?.entryPrice);
    const lots = Math.max(0, finite(trade?.lots) ?? 0);
    const storedLotSize = finite(trade?.contractLotSize);
    const contractLotSize = storedLotSize !== null && storedLotSize > 0 ? storedLotSize : currentContractLotSizes[trade?.symbol];
    if (entryPrice === null || !Number.isFinite(contractLotSize) || contractLotSize <= 0) return { points: null, money: null, contractLotSize: null };
    const points = trade?.status === 'open'
      ? (() => {
        const lastPrice = finite(trade?.lastPrice);
        return lastPrice === null ? null : lastPrice - entryPrice;
      })()
      : finite(trade?.resultPoints) ?? (() => {
        const exitPrice = finite(trade?.exitPrice);
        return exitPrice === null ? null : exitPrice - entryPrice;
      })();
    return { points, money: points === null ? null : points * lots * contractLotSize, contractLotSize };
  }

  function performance() {
    const totals = {
      totalTrades: trades.length,
      openTrades: 0,
      closedTrades: 0,
      winningClosedTrades: 0,
      losingClosedTrades: 0,
      realisedPoints: 0,
      unrealisedPoints: 0,
      netPoints: 0,
      realisedMoney: 0,
      unrealisedMoney: 0,
      netMoney: 0,
    };
    for (const trade of trades) {
      const pnl = tradePnl(trade);
      const isOpen = trade.status === 'open';
      if (isOpen) totals.openTrades += 1;
      else totals.closedTrades += 1;
      if (pnl.points === null || pnl.money === null) continue;
      if (isOpen) {
        totals.unrealisedPoints += pnl.points;
        totals.unrealisedMoney += pnl.money;
      } else {
        totals.realisedPoints += pnl.points;
        totals.realisedMoney += pnl.money;
        if (pnl.points > 0) totals.winningClosedTrades += 1;
        if (pnl.points < 0) totals.losingClosedTrades += 1;
      }
    }
    totals.netPoints = totals.realisedPoints + totals.unrealisedPoints;
    totals.netMoney = totals.realisedMoney + totals.unrealisedMoney;
    return totals;
  }

  function snapshot() {
    return {
      enabled,
      storage: store.getStatus(),
      rules: { ...currentRules },
      contractLotSizes: { ...currentContractLotSizes },
      trades: [...trades].sort((a, b) => b.openedAt - a.openedAt),
      performance: performance(),
    };
  }

  function changed() {
    onChange(snapshot());
  }

  function restoreCooldowns() {
    for (const trade of trades) {
      const expiry = finite(trade.cooldownUntil);
      if (trade.status === 'closed' && expiry !== null) cooldownUntil[trade.symbol] = Math.max(cooldownUntil[trade.symbol] || 0, expiry);
    }
  }

  async function restore() {
    const storageReady = await store.initialize();
    if (!storageReady) {
      enabled = false;
      changed();
      return snapshot();
    }
    const restored = await store.load();
    trades.splice(0, trades.length, ...restored.trades);
    Object.assign(signalStates, restored.signalStates);
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
    if (trade.cooldownUntil > closedAt) cooldownUntil[trade.symbol] = Math.max(cooldownUntil[trade.symbol] || 0, trade.cooldownUntil);
    await store.saveTrade(trade);
  }

  async function monitor(symbol, summary, timestamp) {
    const trade = activeTrade(symbol);
    if (!trade) return false;
    const quote = optionLastPrice(summary, trade, timestamp);
    const currentPrice = quote?.price ?? null;
    if (quote) {
      trade.lastPrice = quote.price;
      trade.lastPriceObservedAt = quote.observedAt;
      trade.lastUpdatedAt = timestamp;
      if (quote.price >= trade.targetPrice) {
        await closeTrade(trade, quote.price, timestamp, 'target');
        return true;
      }
      if (quote.price <= trade.stopLossPrice) {
        await closeTrade(trade, quote.price, timestamp, 'stop-loss');
        return true;
      }
    }
    if (trade.expiresAt && timestamp >= trade.expiresAt) {
      const exitPrice = currentPrice ?? finite(trade.lastPrice) ?? trade.entryPrice;
      await closeTrade(trade, exitPrice, timestamp, 'time-expired', currentPrice === null ? 'last-observed-option-ltp' : 'option-ltp');
      return true;
    }
    if (currentPrice !== null) await store.saveTrade(trade);
    return currentPrice !== null;
  }

  async function setSignalState(symbol, direction, timestamp) {
    if ((signalStates[symbol] || null) === direction) return;
    signalStates[symbol] = direction;
    await store.saveSignalState(symbol, direction, timestamp);
  }

  async function maybeOpen(symbol, payload, summary, timestamp) {
    if (currentRules.symbolEnabled[symbol] !== true) {
      await setSignalState(symbol, null, timestamp);
      return false;
    }
    const signal = preferredSignal(payload, currentRules.triggerLevel);
    if (!signal) {
      await setSignalState(symbol, null, timestamp);
      return false;
    }
    await setSignalState(symbol, signal.direction, timestamp);
    if (activeTrade(symbol) || (cooldownUntil[symbol] || 0) > timestamp) return false;
    const option = atmOption(summary, signal.optionSide, timestamp);
    if (!option) return false;
    const expiresAt = currentRules.maxAliveSeconds > 0 ? timestamp + (currentRules.maxAliveSeconds * 1000) : null;
    const trade = {
      id: randomUUID(),
      status: 'open',
      symbol,
      optionType: signal.optionSide === 'ce' ? 'CALL' : 'PUT',
      optionSide: signal.optionSide,
      securityId: option.securityId,
      strike: option.strike,
      lots: currentRules.lots,
      contractLotSize: currentContractLotSizes[symbol],
      contractLotSizeSource: 'dhan-instrument-master-config',
      entryPrice: option.entryPrice,
      entryPriceSource: option.entryPriceSource,
      entryPriceObservedAt: option.entryPriceObservedAt,
      lastPrice: option.entryPrice,
      lastPriceObservedAt: option.entryPriceObservedAt,
      targetPrice: option.entryPrice + currentRules.targetPoints,
      stopLossPrice: Math.max(0, option.entryPrice - currentRules.stopLossPoints),
      openedAt: timestamp,
      lastUpdatedAt: timestamp,
      expiresAt,
      triggerLevel: currentRules.triggerLevel,
      cooldownSecondsAtEntry: currentRules.cooldownSeconds,
      signalWindow: signal.window.label,
      signalLabel: signal.window.window.marketStrength.label,
      source: 'dhan-live-paper-simulation',
      paperOnly: true,
    };
    trades.push(trade);
    await store.saveTrade(trade);
    return true;
  }

  async function disableAndClose(timestamp, symbols = null, closeReason = 'simulator-disabled') {
    const allowed = symbols ? new Set(symbols) : null;
    const openTrades = trades.filter((trade) => trade.status === 'open' && (!allowed || allowed.has(trade.symbol)));
    for (const trade of openTrades) {
      const exitPrice = finite(trade.lastPrice) ?? trade.entryPrice;
      await closeTrade(trade, exitPrice, timestamp, closeReason, 'last-observed-option-ltp');
    }
  }

  function updateSettings(nextSettings, timestamp = now()) {
    const operation = queue.then(async () => {
      if (!store.isReady()) {
        const error = new Error('Paper simulator settings are unavailable until durable PostgreSQL storage is ready.');
        error.statusCode = 503;
        throw error;
      }
      const nextRules = normalizeRules(nextSettings, currentRules);
      if (nextRules.enabled === false) await disableAndClose(timestamp);
      else {
        const disabledSymbols = PAPER_SYMBOLS.filter((symbol) => currentRules.symbolEnabled[symbol] === true && nextRules.symbolEnabled[symbol] === false);
        if (disabledSymbols.length) await disableAndClose(timestamp, disabledSymbols, 'symbol-disabled');
      }
      currentRules = nextRules;
      enabled = currentRules.enabled === true;
      await store.saveSettings(currentRules, timestamp);
      changed();
      return snapshot();
    });
    queue = operation.catch((err) => {
      console.error('[paper-trading]', err.message);
      return snapshot();
    });
    return operation;
  }

  function expire(timestamp = now()) {
    queue = queue.then(async () => {
      const expiring = trades.filter((trade) => trade.status === 'open' && trade.expiresAt && timestamp >= trade.expiresAt);
      for (const trade of expiring) {
        const exitPrice = finite(trade.lastPrice) ?? trade.entryPrice;
        await closeTrade(trade, exitPrice, timestamp, 'time-expired', 'last-observed-option-ltp');
      }
      if (expiring.length) changed();
      return snapshot();
    }).catch((err) => {
      console.error('[paper-trading]', err.message);
      return snapshot();
    });
    return queue;
  }

  function process(symbol, payload, summary, timestamp = now()) {
    queue = queue.then(async () => {
      if (!summary || !payload) return snapshot();
      const monitored = enabled ? await monitor(symbol, summary, timestamp) : false;
      const opened = enabled && !monitored ? await maybeOpen(symbol, payload, summary, timestamp) : false;
      if (monitored || opened) changed();
      return snapshot();
    }).catch((err) => {
      console.error('[paper-trading]', err.message);
      return snapshot();
    });
    return queue;
  }

  return { restore, process, expire, snapshot, activeTrade, updateSettings };
}
