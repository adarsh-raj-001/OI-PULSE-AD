import { randomUUID } from 'node:crypto';
import { nearestStrikeIndex, sortedStrikes } from './oiWindows.js';

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function preferredSignal(payload) {
  const entries = [
    ['m5', '5 Min'],
    ['m30', '30 Min'],
    ['h3', '3 Hour'],
  ].map(([key, label]) => ({ key, label, window: payload?.windows?.[key] }))
    .filter((entry) => entry.window?.referenceMode === 'exact-window' && entry.window?.marketStrength);
  const preferred = entries.find((entry) => (
    entry.window.marketStrength.label === 'Strong upward pressure'
    || entry.window.marketStrength.label === 'Strong downward pressure'
  ));
  const label = preferred?.window?.marketStrength?.label;
  if (label === 'Strong upward pressure') return { direction: 'up', optionSide: 'ce', window: preferred };
  if (label === 'Strong downward pressure') return { direction: 'down', optionSide: 'pe', window: preferred };
  return null;
}

function atmOption(summary, optionSide) {
  const strikes = sortedStrikes(summary?.strikes);
  const index = nearestStrikeIndex(strikes, summary?.underlyingPrice);
  if (index === null) return null;
  const strike = strikes[index];
  const leg = summary.strikes?.[strike]?.[optionSide];
  const price = finite(leg?.lastPrice);
  const securityId = finite(leg?.securityId);
  if (price === null || price <= 0 || securityId === null) return null;
  return { strike, securityId, entryPrice: price };
}

function optionLastPrice(summary, trade) {
  return finite(summary?.strikes?.[trade.strike]?.[trade.optionSide]?.lastPrice);
}

export function createPaperTradeEngine({ store, rules, onChange = () => {}, now = () => Date.now() }) {
  const trades = [];
  const signalStates = {};
  let enabled = false;
  let queue = Promise.resolve();

  function activeTrade(symbol) {
    return trades.find((trade) => trade.symbol === symbol && trade.status === 'open') || null;
  }

  function snapshot() {
    return {
      enabled,
      storage: store.getStatus(),
      rules: { ...rules },
      trades: [...trades].sort((a, b) => b.openedAt - a.openedAt),
    };
  }

  function changed() {
    onChange(snapshot());
  }

  async function restore() {
    if (rules.enabled === false) {
      enabled = false;
      changed();
      return snapshot();
    }
    enabled = await store.initialize();
    if (!enabled) {
      changed();
      return snapshot();
    }
    const restored = await store.load();
    trades.splice(0, trades.length, ...restored.trades);
    Object.assign(signalStates, restored.signalStates);
    changed();
    return snapshot();
  }

  function closeTrade(trade, exitPrice, closedAt, closeReason) {
    trade.status = 'closed';
    trade.closedAt = closedAt;
    trade.exitPrice = exitPrice;
    trade.closeReason = closeReason;
    trade.resultPoints = exitPrice - trade.entryPrice;
    void store.saveTrade(trade);
  }

  function monitor(symbol, summary, timestamp) {
    const trade = activeTrade(symbol);
    if (!trade) return false;
    const currentPrice = optionLastPrice(summary, trade);
    if (currentPrice === null) return false;
    trade.lastPrice = currentPrice;
    trade.lastUpdatedAt = timestamp;
    if (currentPrice >= trade.targetPrice) closeTrade(trade, currentPrice, timestamp, 'target');
    else if (currentPrice <= trade.stopLossPrice) closeTrade(trade, currentPrice, timestamp, 'stop-loss');
    else void store.saveTrade(trade);
    return true;
  }

  function setSignalState(symbol, direction, timestamp) {
    if (signalStates[symbol] === direction) return;
    signalStates[symbol] = direction;
    void store.saveSignalState(symbol, direction, timestamp);
  }

  function maybeOpen(symbol, payload, summary, timestamp) {
    const signal = preferredSignal(payload);
    if (!signal) {
      setSignalState(symbol, null, timestamp);
      return false;
    }
    const previousDirection = signalStates[symbol] || null;
    setSignalState(symbol, signal.direction, timestamp);
    if (activeTrade(symbol) || previousDirection === signal.direction) return false;
    const option = atmOption(summary, signal.optionSide);
    if (!option) return false;
    const trade = {
      id: randomUUID(),
      status: 'open',
      symbol,
      optionType: signal.optionSide === 'ce' ? 'CALL' : 'PUT',
      optionSide: signal.optionSide,
      securityId: option.securityId,
      strike: option.strike,
      lots: rules.lots,
      entryPrice: option.entryPrice,
      lastPrice: option.entryPrice,
      targetPrice: option.entryPrice + rules.targetPoints,
      stopLossPrice: Math.max(0, option.entryPrice - rules.stopLossPoints),
      openedAt: timestamp,
      lastUpdatedAt: timestamp,
      signalWindow: signal.window.label,
      signalLabel: signal.window.window.marketStrength.label,
      source: 'dhan-live-paper-simulation',
      paperOnly: true,
    };
    trades.push(trade);
    void store.saveTrade(trade);
    return true;
  }

  function process(symbol, payload, summary, timestamp = now()) {
    queue = queue.then(async () => {
      if (!enabled || !summary || !payload) return snapshot();
      const monitored = monitor(symbol, summary, timestamp);
      const opened = maybeOpen(symbol, payload, summary, timestamp);
      if (monitored || opened) changed();
      return snapshot();
    }).catch((err) => {
      console.error('[paper-trading]', err.message);
      return snapshot();
    });
    return queue;
  }

  return { restore, process, snapshot, activeTrade };
}
