import assert from 'node:assert/strict';
import { createPaperTradeEngine } from './paperTrading.js';

class MemoryStore {
  constructor() { this.trades = []; this.signalStates = {}; this.settings = null; }
  async initialize() { return true; }
  async load() { return { trades: structuredClone(this.trades), signalStates: structuredClone(this.signalStates), settings: structuredClone(this.settings) }; }
  saveTrade(trade) { const index = this.trades.findIndex((item) => item.id === trade.id); if (index >= 0) this.trades[index] = structuredClone(trade); else this.trades.push(structuredClone(trade)); return Promise.resolve(true); }
  saveSignalState(symbol, signal) { this.signalStates[symbol] = signal; return Promise.resolve(true); }
  saveSettings(settings) { this.settings = structuredClone(settings); return Promise.resolve(true); }
  clearSessionHistory() { this.trades.splice(0, this.trades.length); this.signalStates = {}; return Promise.resolve(true); }
  getStatus() { return { mode: 'postgres', status: 'ready', lastError: null }; }
  isReady() { return true; }
}

const defaults = { enabled: true, lots: 10, symbolEnabled: { NIFTY: true, SENSEX: true }, marketHoursEnabled: true, strengthThreshold: 60, oiTriggerEnabled: false, entryPremiumOffset: 0, targetPoints: 2, stopLossPoints: 5, maxAliveSeconds: 0, cooldownSeconds: 0 };
const contractLotSizes = { NIFTY: 65, SENSEX: 20 };

function summary(callPrice = 100, putPrice = 120, quoteAt = 1_000) {
  return {
    underlyingPrice: 24250,
    strikes: {
      24200: { ce: { lastPrice: 90, lastPriceAt: quoteAt }, pe: { lastPrice: 130, lastPriceAt: quoteAt } },
      24250: { ce: { securityId: 101, lastPrice: callPrice, lastPriceAt: quoteAt }, pe: { securityId: 202, lastPrice: putPrice, lastPriceAt: quoteAt } },
      24300: { ce: { lastPrice: 80, lastPriceAt: quoteAt }, pe: { lastPrice: 140, lastPriceAt: quoteAt } },
    },
  };
}

function payload(label, window = 'm5', intensity = label.includes('Strong') ? 80 : label.includes('Mild') ? 40 : 0) {
  const direction = label.includes('upward') ? 'up' : label.includes('downward') ? 'down' : 'neutral';
  return { windows: { [window]: { referenceMode: 'exact-window', marketStrength: { label, intensity, direction } } } };
}

const store = new MemoryStore();
const engine = createPaperTradeEngine({ store, rules: defaults, contractLotSizes });
await engine.restore();

await engine.process('NIFTY', payload('Strong upward pressure'), summary(), 1_000);
let state = engine.snapshot();
assert.equal(state.trades.length, 1);
assert.equal(state.trades[0].optionType, 'CALL');
assert.equal(state.trades[0].entryPrice, 100);
assert.equal(state.trades[0].entryPriceSource, 'live-option-ltp');
assert.equal(state.trades[0].entryPriceObservedAt, 1_000);
assert.equal(state.trades[0].contractLotSize, 65, 'NIFTY trade must persist the configured units per lot at entry');
assert.equal(state.trades[0].targetPrice, 102);
assert.equal(state.trades[0].stopLossPrice, 95);
assert.equal(state.trades[0].expiresAt, null);

await engine.process('NIFTY', payload('Strong upward pressure'), summary(101, 120, 2_000), 2_000);
assert.equal(engine.snapshot().trades.length, 1, 'one continuous strong signal must not create duplicate trades');
await engine.process('NIFTY', payload('Strong upward pressure'), summary(102, 120, 3_000), 3_000);
state = engine.snapshot();
assert.equal(state.trades[0].status, 'closed');
assert.equal(state.trades[0].closeReason, 'target');
assert.equal(state.trades[0].resultPoints, 2);

await engine.process('NIFTY', payload('Strong upward pressure'), summary(103, 120, 4_000), 4_000);
assert.equal(engine.snapshot().trades.length, 2, 'a zero-second cooldown may open a new record on the next live update after the prior record closes');
await engine.process('NIFTY', payload('Balanced / mixed'), summary(105, 120, 5_000), 5_000);
await engine.process('NIFTY', payload('Strong downward pressure'), summary(104, 120, 6_000), 6_000);
state = engine.snapshot();
assert.equal(state.trades.length, 3);
assert.equal(state.trades[0].optionType, 'PUT');
await engine.process('NIFTY', payload('Strong downward pressure'), summary(104, 115, 7_000), 7_000);
state = engine.snapshot();
assert.equal(state.trades[0].status, 'closed');
assert.equal(state.trades[0].closeReason, 'stop-loss');
assert.equal(state.trades[0].resultPoints, -5);

const restored = createPaperTradeEngine({ store, rules: defaults, contractLotSizes });
await restored.restore();
assert.equal(restored.snapshot().trades.length, 3, 'paper records must recover from durable storage');

const eligibilityStore = new MemoryStore();
const eligibilityEngine = createPaperTradeEngine({ store: eligibilityStore, rules: defaults, contractLotSizes });
await eligibilityEngine.restore();
await eligibilityEngine.process('SENSEX', { windows: { m5: { referenceMode: 'current-market-baseline', marketStrength: { label: 'Strong upward pressure' } } } }, summary(100, 120, 8_000), 8_000);
assert.equal(eligibilityEngine.snapshot().trades.length, 0, 'reset/start provisional windows must never open a paper trade');
await eligibilityEngine.process('SENSEX', { windows: {
  m5: { referenceMode: 'exact-window', marketStrength: { label: 'Balanced / mixed', intensity: 0, direction: 'neutral' } },
  m30: { referenceMode: 'exact-window', marketStrength: { label: 'Strong upward pressure', intensity: 80, direction: 'up' } },
} }, summary(100, 120, 9_000), 9_000);
const eligibleTrade = eligibilityEngine.snapshot().trades[0];
assert.equal(eligibleTrade.optionType, 'CALL', 'a later completed qualifying window may open a Buy Call when the shorter completed window is non-qualifying');
assert.equal(eligibleTrade.signalWindow, '30 Min');

const controlStore = new MemoryStore();
const controlEngine = createPaperTradeEngine({ store: controlStore, rules: defaults, contractLotSizes });
await controlEngine.restore();
await controlEngine.updateSettings({ lots: 20, strengthThreshold: 30, targetPoints: 3, stopLossPoints: 4, maxAliveSeconds: 10, cooldownSeconds: 3 }, 10_000);
await controlEngine.process('NIFTY', payload('Mild upward pressure'), summary(100, 120, 11_000), 11_000);
state = controlEngine.snapshot();
assert.equal(state.trades.length, 1, 'a numeric 30/100 threshold must accept a completed 40-intensity mild upward signal');
assert.equal(state.trades[0].lots, 20);
assert.equal(state.trades[0].strengthThreshold, 30);
assert.equal(state.trades[0].targetPrice, 103);
assert.equal(state.trades[0].stopLossPrice, 96);
assert.equal(state.trades[0].expiresAt, 21_000);
assert.equal(state.trades[0].cooldownSecondsAtEntry, 3);
await controlEngine.expire(21_000);
state = controlEngine.snapshot();
assert.equal(state.trades[0].closeReason, 'time-expired', 'the lifetime timer closes a trade even when no new market update arrives');
assert.equal(state.trades[0].exitPrice, 100);
assert.equal(state.trades[0].cooldownUntil, 24_000);
await controlEngine.process('NIFTY', payload('Balanced / mixed'), summary(100, 120, 22_000), 22_000);
await controlEngine.process('NIFTY', payload('Mild upward pressure'), summary(100, 120, 23_000), 23_000);
assert.equal(controlEngine.snapshot().trades.length, 1, 'cooldown blocks qualifying re-entry until its configured seconds pass');
await controlEngine.process('NIFTY', payload('Balanced / mixed'), summary(100, 120, 24_000), 24_000);
await controlEngine.process('NIFTY', payload('Mild upward pressure'), summary(100, 120, 25_000), 25_000);
assert.equal(controlEngine.snapshot().trades.length, 2, 'a new edge after cooldown may open a new paper record');

await controlEngine.process('SENSEX', payload('Mild downward pressure'), summary(100, 120, 26_000), 26_000);
assert.equal(controlEngine.snapshot().trades.filter((trade) => trade.status === 'open').length, 2);
await controlEngine.updateSettings({ enabled: false }, 27_000);
state = controlEngine.snapshot();
assert.equal(state.enabled, false);
assert.equal(state.trades.filter((trade) => trade.status === 'open').length, 0, 'disabling closes every open paper trade before new entries are blocked');
assert.equal(state.trades.filter((trade) => trade.closeReason === 'simulator-disabled').length, 2);
await controlEngine.updateSettings({ enabled: true }, 28_000);
await controlEngine.process('SENSEX', payload('Mild downward pressure'), summary(100, 120, 29_000), 29_000);
assert.equal(controlEngine.snapshot().trades.filter((trade) => trade.symbol === 'SENSEX').length, 1, 're-enabling cannot duplicate an unchanged qualifying signal');

const freshnessStore = new MemoryStore();
const freshnessEngine = createPaperTradeEngine({ store: freshnessStore, rules: defaults, contractLotSizes });
await freshnessEngine.restore();
await freshnessEngine.process('NIFTY', payload('Strong upward pressure'), summary(100, 120, 1), 16_001);
assert.equal(freshnessEngine.snapshot().trades.length, 0, 'an expired option LTP must never create a simulated entry');
await freshnessEngine.process('NIFTY', payload('Strong upward pressure'), summary(99, 120, 16_002), 16_002);
state = freshnessEngine.snapshot();
assert.equal(state.trades[0].entryPrice, 99, 'a new simulation must fill at the latest valid selected-option LTP');
assert.equal(state.trades[0].entryPriceObservedAt, 16_002);

const manualExitStore = new MemoryStore();
const manualExitEngine = createPaperTradeEngine({ store: manualExitStore, rules: defaults, contractLotSizes });
await manualExitEngine.restore();
await manualExitEngine.process('NIFTY', payload('Strong upward pressure'), summary(100, 120, 20_000), 20_000);
const manualExitId = manualExitEngine.snapshot().trades[0].id;
await manualExitEngine.process('NIFTY', payload('Balanced / mixed'), summary(101.5, 120, 20_100), 20_100);
await manualExitEngine.exitTrade(manualExitId, 20_200);
state = manualExitEngine.snapshot();
assert.equal(state.trades[0].status, 'closed', 'manual exit closes only the selected open paper position');
assert.equal(state.trades[0].closeReason, 'manual-exit');
assert.equal(state.trades[0].exitPrice, 101.5, 'manual exit uses the latest already-observed option LTP');
assert.equal(state.trades[0].exitPriceSource, 'last-observed-option-ltp');
assert.equal(state.trades[0].resultPoints, 1.5);
assert.equal(manualExitStore.trades[0].closeReason, 'manual-exit', 'manual exit must persist to the paper ledger');
await assert.rejects(() => manualExitEngine.exitTrade(manualExitId, 20_300), /Only an open paper trade can be exited manually/);

const pnlStore = new MemoryStore();
const pnlEngine = createPaperTradeEngine({ store: pnlStore, rules: defaults, contractLotSizes });
await pnlEngine.restore();
await pnlEngine.process('NIFTY', payload('Strong upward pressure'), summary(100, 120, 30_000), 30_000);
await pnlEngine.process('NIFTY', payload('Balanced / mixed'), summary(101, 120, 31_000), 31_000);
state = pnlEngine.snapshot();
assert.equal(state.performance.unrealisedPoints, 1);
assert.equal(state.performance.unrealisedMoney, 650, 'NIFTY paper money P&L is premium movement × paper lots × 65 units per lot');
assert.equal(state.performance.netMoney, 650);
await pnlEngine.process('NIFTY', payload('Balanced / mixed'), summary(102, 120, 32_000), 32_000);
state = pnlEngine.snapshot();
assert.equal(state.performance.realisedPoints, 2);
assert.equal(state.performance.realisedMoney, 1300);
assert.equal(state.performance.unrealisedMoney, 0);
assert.equal(state.performance.netMoney, 1300);

const symbolStore = new MemoryStore();
const symbolEngine = createPaperTradeEngine({ store: symbolStore, rules: defaults, contractLotSizes });
await symbolEngine.restore();
await symbolEngine.process('SENSEX', payload('Strong downward pressure'), summary(100, 120, 40_000), 40_000);
await symbolEngine.process('SENSEX', payload('Balanced / mixed'), summary(100, 121, 41_000), 41_000);
state = symbolEngine.snapshot();
assert.equal(state.trades[0].contractLotSize, 20, 'SENSEX trade must persist its own contract units per lot');
assert.equal(state.performance.unrealisedMoney, 200, 'SENSEX paper money P&L uses 20 units per lot');
await symbolEngine.updateSettings({ symbolEnabled: { SENSEX: false } }, 42_000);
state = symbolEngine.snapshot();
assert.equal(state.rules.symbolEnabled.NIFTY, true);
assert.equal(state.rules.symbolEnabled.SENSEX, false);
assert.equal(state.trades[0].closeReason, 'symbol-disabled', 'disabling SENSEX must close only its open SENSEX paper trade');
await symbolEngine.process('SENSEX', payload('Strong downward pressure'), summary(100, 120, 43_000), 43_000);
assert.equal(symbolEngine.snapshot().trades.length, 1, 'disabled SENSEX must not open a new paper trade');
await symbolEngine.process('NIFTY', payload('Strong upward pressure'), summary(100, 120, 44_000), 44_000);
assert.equal(symbolEngine.snapshot().trades.length, 2, 'enabled NIFTY must continue to open independently of disabled SENSEX');

const pendingStore = new MemoryStore();
const pendingEngine = createPaperTradeEngine({ store: pendingStore, rules: { ...defaults, entryPremiumOffset: 2 }, contractLotSizes });
await pendingEngine.restore();
await pendingEngine.process('NIFTY', payload('Strong upward pressure'), summary(46, 120, 50_000), 50_000);
state = pendingEngine.snapshot();
assert.equal(state.trades[0].status, 'pending', 'a positive entry discount must create a pending paper limit entry rather than an invented immediate fill');
assert.equal(state.trades[0].requestedEntryPrice, 44, '₹2 below a ₹46 Call premium requests ₹44');
assert.equal(state.trades[0].entryCondition, 'at-or-below');
await pendingEngine.process('NIFTY', payload('Balanced / mixed'), summary(45, 120, 51_000), 51_000);
assert.equal(pendingEngine.snapshot().trades[0].status, 'pending', 'a below-market paper limit remains pending while LTP is above its requested price');
await pendingEngine.process('NIFTY', payload('Balanced / mixed'), summary(44, 120, 52_000), 52_000);
state = pendingEngine.snapshot();
assert.equal(state.trades[0].status, 'open');
assert.equal(state.trades[0].entryPrice, 44);
assert.equal(state.trades[0].entryPriceSource, 'live-option-ltp-pending-entry');

const pendingPutStore = new MemoryStore();
const pendingPutEngine = createPaperTradeEngine({ store: pendingPutStore, rules: { ...defaults, entryPremiumOffset: 2 }, contractLotSizes });
await pendingPutEngine.restore();
await pendingPutEngine.process('NIFTY', payload('Strong downward pressure'), summary(46, 120, 53_000), 53_000);
state = pendingPutEngine.snapshot();
assert.equal(state.trades[0].optionType, 'PUT');
assert.equal(state.trades[0].requestedEntryPrice, 118, '₹2 below a ₹120 Put premium requests ₹118');
assert.equal(state.trades[0].entryCondition, 'at-or-below');
await pendingPutEngine.process('NIFTY', payload('Balanced / mixed'), summary(46, 119, 54_000), 54_000);
assert.equal(pendingPutEngine.snapshot().trades[0].status, 'pending', 'a Put lower-price entry remains pending above its requested price');
await pendingPutEngine.process('NIFTY', payload('Balanced / mixed'), summary(46, 118, 55_000), 55_000);
state = pendingPutEngine.snapshot();
assert.equal(state.trades[0].status, 'open');
assert.equal(state.trades[0].entryPrice, 118);

const legacyOffsetStore = new MemoryStore();
const legacyOffsetEngine = createPaperTradeEngine({ store: legacyOffsetStore, rules: { ...defaults, entryPremiumOffset: -2 }, contractLotSizes });
await legacyOffsetEngine.restore();
assert.equal(legacyOffsetEngine.snapshot().rules.entryPremiumOffset, 2, 'legacy negative offsets must normalize to the same positive lower-price discount');

await pendingEngine.setMarketSession({ active: false, reason: 'after-close' });
await pendingEngine.process('NIFTY', payload('Strong upward pressure'), summary(100, 120, 53_000), 53_000);
assert.equal(pendingEngine.snapshot().trades.length, 1, 'a paused market session must block new paper entries');
await pendingEngine.setMarketSession({ active: true, reason: 'open' });

const sessionStore = new MemoryStore();
const sessionEngine = createPaperTradeEngine({ store: sessionStore, rules: defaults, contractLotSizes });
await sessionEngine.restore();
await sessionEngine.process('NIFTY', payload('Strong upward pressure'), summary(100, 120, 60_000), 60_000);
await sessionEngine.updateSettings({ entryPremiumOffset: 2 }, 60_001);
await sessionEngine.process('SENSEX', payload('Strong downward pressure'), summary(100, 120, 60_002), 60_002);
state = sessionEngine.snapshot();
assert.equal(state.trades.filter((trade) => trade.status === 'open').length, 1, 'session reset setup includes an active paper entry');
assert.equal(state.trades.filter((trade) => trade.status === 'pending').length, 1, 'session reset setup includes a pending paper entry');
await sessionEngine.resetSession({ sessionKey: '2026-08-24', timestamp: 61_000 });
state = sessionEngine.snapshot();
assert.deepEqual(state.trades, [], 'session reset must clear in-memory paper ledger after lifecycle closure');
assert.deepEqual(sessionStore.trades, [], 'session reset must remove durable paper records after lifecycle closure');
assert.deepEqual(sessionStore.signalStates, {}, 'session reset must remove durable paper signal guards');
assert.equal(state.rules.enabled, true, 'session reset must retain the paper simulator enabled setting');
assert.equal(state.rules.entryPremiumOffset, 2, 'session reset must retain configurable paper settings');
assert.deepEqual(state.lastSessionReset, {
  sessionKey: '2026-08-24', resetAt: 61_000, reason: 'session-reset', clearedRecords: 2, closedOpenEntries: 1, cancelledPendingEntries: 1,
});
assert.deepEqual(sessionStore.settings.lastSessionReset, state.lastSessionReset, 'reset audit metadata must persist with retained settings');
await sessionEngine.resetSession({ sessionKey: '2026-08-24', timestamp: 62_000 });
assert.equal(sessionEngine.snapshot().lastSessionReset.resetAt, 61_000, 'same session key must not reset twice after restart or duplicate scheduler checks');

const sessionRestored = createPaperTradeEngine({ store: sessionStore, rules: defaults, contractLotSizes });
await sessionRestored.restore();
assert.equal(sessionRestored.snapshot().trades.length, 0, 'a restarted engine must retain the cleared paper ledger');
assert.equal(sessionRestored.snapshot().lastSessionReset.sessionKey, '2026-08-24', 'a restarted engine must retain reset idempotency metadata');

const settingsRestored = createPaperTradeEngine({ store: controlStore, rules: defaults, contractLotSizes });
await settingsRestored.restore();
state = settingsRestored.snapshot();
assert.equal(state.rules.lots, 20, 'screen-edited simulator controls must persist across restart');
assert.equal(state.rules.enabled, true);
assert.equal(state.rules.strengthThreshold, 30, 'numeric strength controls must persist across restart');

const portfoliosStore = new MemoryStore();
const portfoliosEngine = createPaperTradeEngine({
  store: portfoliosStore,
  rules: {
    marketHoursEnabled: true,
    sessionResetEnabled: true,
    portfolios: {
      portfolio1: { ...defaults, enabled: true, symbolEnabled: { NIFTY: true, SENSEX: false } },
      portfolio2: { ...defaults, enabled: true, symbolEnabled: { NIFTY: true, SENSEX: false } },
      portfolio3: { ...defaults, enabled: true, symbolEnabled: { NIFTY: true, SENSEX: true }, tradeSide: 'put', oiWindow: 'm30', oiMetric: 'difference', oiThreshold: 500 },
    },
  },
  contractLotSizes,
});
await portfoliosEngine.restore();
const portfoliosPayload = {
  windows: {
    m5: { referenceMode: 'exact-window', marketStrength: { label: 'Strong upward pressure', intensity: 80, direction: 'up' } },
    m30: { referenceMode: 'exact-window', bandDeltaCe: 800, bandDeltaPe: 200 },
  },
};
await portfoliosEngine.process('NIFTY', portfoliosPayload, summary(100, 120, 70_000), 70_000);
state = portfoliosEngine.snapshot();
assert.equal(state.trades.length, 3, 'each enabled portfolio may hold its own independent paper position for one symbol');
assert.equal(state.trades.find((trade) => trade.portfolioId === 'portfolio1').optionType, 'CALL', 'Portfolio 1 follows upward strength into a Call');
assert.equal(state.trades.find((trade) => trade.portfolioId === 'portfolio2').optionType, 'PUT', 'Portfolio 2 reverses upward strength into a Put');
assert.equal(state.rules.portfolios.portfolio1.reverseOrders, false, 'Portfolio 1 defaults to follow-strength order routing');
assert.equal(state.rules.portfolios.portfolio2.reverseOrders, true, 'Portfolio 2 defaults to reverse-strength order routing');
assert.equal(state.rules.portfolios.portfolio1.oiTriggerEnabled, false, 'Portfolio 1 keeps its explicit strength-only fixture setting');
assert.equal(state.rules.portfolios.portfolio2.oiTriggerMode, 'positive-opposite-side', 'Portfolio 2 retains its normalized OI trigger mode even when its fixture disables OI routing');
const oiTrade = state.trades.find((trade) => trade.portfolioId === 'portfolio3');
assert.equal(oiTrade.optionType, 'PUT', 'Portfolio 3 honours its configured trade-side override');
assert.equal(oiTrade.oiMetric, 'difference');
assert.equal(oiTrade.oiValueAtSignal, 600, 'Portfolio 3 uses the selected signed ITM OI metric');
assert.equal(oiTrade.oiThresholdMode, 'number', 'missing legacy mode must default to number-based OI thresholds');
assert.equal(portfoliosEngine.activeTrades('NIFTY').length, 3, 'all open portfolio positions remain independently subscribable for fresh option LTP monitoring');
assert.equal(state.portfolioPerformance.portfolio1.totalTrades, 1);
assert.equal(state.portfolioPerformance.portfolio2.totalTrades, 1);
assert.equal(state.portfolioPerformance.portfolio3.totalTrades, 1);

await portfoliosEngine.updateSettings({ portfolios: { portfolio2: { reverseOrders: false } } }, 70_500);
assert.equal(portfoliosEngine.snapshot().rules.portfolios.portfolio2.reverseOrders, false, 'the Portfolio 2 reverse-orders switch must be independently configurable');

await portfoliosEngine.updateSettings({ portfolios: { portfolio3: { tradeSide: 'call' } } }, 71_000);
await portfoliosEngine.process('SENSEX', portfoliosPayload, summary(100, 120, 72_000), 72_000);
state = portfoliosEngine.snapshot();
assert.equal(state.trades.filter((trade) => trade.portfolioId === 'portfolio3').length, 2, 'Portfolio 3 may open independently on another enabled symbol');
assert.equal(state.trades.find((trade) => trade.portfolioId === 'portfolio3' && trade.symbol === 'SENSEX').optionType, 'CALL', 'the selectable trade side can route OI triggers to Calls');

await portfoliosEngine.updateSettings({ portfolios: { portfolio2: { enabled: false } } }, 73_000);
state = portfoliosEngine.snapshot();
assert.equal(state.trades.find((trade) => trade.portfolioId === 'portfolio2').closeReason, 'portfolio-disabled', 'disabling one portfolio closes only its own open paper position');
assert.equal(state.trades.find((trade) => trade.portfolioId === 'portfolio1').status, 'open', 'other portfolios remain active when one portfolio is disabled');
assert.equal(state.rules.portfolios.portfolio2.enabled, false);

const percentageStore = new MemoryStore();
const percentageEngine = createPaperTradeEngine({
  store: percentageStore,
  rules: {
    marketHoursEnabled: true,
    sessionResetEnabled: true,
    portfolios: {
      portfolio1: { ...defaults, enabled: false },
      portfolio2: { ...defaults, enabled: false },
      portfolio3: { ...defaults, enabled: true, tradeSide: 'auto', oiWindow: 'm5', oiMetric: 'difference', oiThresholdMode: 'percentage', oiThreshold: 0.5 },
    },
  },
  contractLotSizes,
});
await percentageEngine.restore();
const percentagePayload = {
  windows: {
    m5: {
      referenceMode: 'exact-window',
      bandDeltaCe: 1200,
      bandDeltaPe: 800,
      callItmOiChangePct: 1.2,
      putItmOiChangePct: 0.8,
      bandDeltaTotalPct: 1,
      bandDeltaDifferencePct: 0.4,
    },
  },
};
await percentageEngine.process('NIFTY', percentagePayload, summary(100, 120, 80_000), 80_000);
assert.equal(percentageEngine.snapshot().trades.length, 0, 'Portfolio 3 percentage mode must compare the selected percentage value, not the larger absolute OI number');
await percentageEngine.updateSettings({ portfolios: { portfolio3: { oiThreshold: 0.3 } } }, 80_100);
await percentageEngine.process('NIFTY', percentagePayload, summary(100, 120, 80_200), 80_200);
const percentageTrade = percentageEngine.snapshot().trades[0];
assert.equal(percentageTrade.optionType, 'CALL', 'a positive Call % minus Put % threshold uses the upward automatic Call route');
assert.ok(Math.abs(percentageTrade.oiValueAtSignal - 0.4) < 1e-12, 'percentage difference must equal Call OI percentage minus Put OI percentage');
assert.equal(percentageTrade.oiThresholdMode, 'percentage', 'paper trade audit data must preserve the threshold unit selected for Portfolio 3');
assert.equal(percentageTrade.oiThreshold, 0.3);

const oppositeSideStore = new MemoryStore();
const oppositeSideEngine = createPaperTradeEngine({
  store: oppositeSideStore,
  rules: {
    marketHoursEnabled: true,
    sessionResetEnabled: true,
    portfolios: {
      portfolio1: { ...defaults, enabled: false },
      portfolio2: { ...defaults, enabled: false },
      portfolio3: { ...defaults, enabled: true, tradeSide: 'put', oiWindow: 'm5', oppositeSideOiPctEnabled: true, oppositeSideOiPctThreshold: 1 },
    },
  },
  contractLotSizes,
});
await oppositeSideEngine.restore();
const putGrowthPayload = { windows: { m5: { referenceMode: 'clock-aligned-baseline', callItmOiChangePct: 0.7, putItmOiChangePct: 1.2 } } };
await oppositeSideEngine.process('NIFTY', putGrowthPayload, summary(100, 120, 90_000), 90_000);
state = oppositeSideEngine.snapshot();
const putGrowthTrade = state.trades.find((trade) => trade.symbol === 'NIFTY');
assert.equal(putGrowthTrade.optionType, 'CALL', 'Put OI percentage growth at or above the threshold must buy a Call');
assert.equal(putGrowthTrade.oiTriggerSource, 'put-oi-percent-to-call');
assert.equal(putGrowthTrade.oiThresholdMode, 'percentage');
assert.equal(putGrowthTrade.oiOppositeSidePctThreshold, 1);
const callGrowthPayload = { windows: { m5: { referenceMode: 'clock-aligned-baseline', callItmOiChangePct: 1.4, putItmOiChangePct: 0.6 } } };
await oppositeSideEngine.process('SENSEX', callGrowthPayload, summary(100, 120, 91_000), 91_000);
state = oppositeSideEngine.snapshot();
const callGrowthTrade = state.trades.find((trade) => trade.symbol === 'SENSEX');
assert.equal(callGrowthTrade.optionType, 'PUT', 'Call OI percentage growth at or above the threshold must buy a Put');
assert.equal(callGrowthTrade.oiTriggerSource, 'call-oi-percent-to-put');
const equalPercentStore = new MemoryStore();
const equalPercentEngine = createPaperTradeEngine({
  store: equalPercentStore,
  rules: { marketHoursEnabled: true, sessionResetEnabled: true, portfolios: { portfolio1: { ...defaults, enabled: false }, portfolio2: { ...defaults, enabled: false }, portfolio3: { ...defaults, enabled: true, oiWindow: 'm5', oppositeSideOiPctEnabled: true, oppositeSideOiPctThreshold: 1 } } },
  contractLotSizes,
});
await equalPercentEngine.restore();
await equalPercentEngine.process('NIFTY', { windows: { m5: { referenceMode: 'clock-aligned-baseline', callItmOiChangePct: 1.3, putItmOiChangePct: 1.3 } } }, summary(100, 120, 92_000), 92_000);
assert.equal(equalPercentEngine.snapshot().trades.length, 0, 'equal Call and Put percentage gains must not create an ambiguous opposite-side paper entry');
function oiPercentagePayload(callPct, putPct) {
  return {
    windows: {
      m5: {
        referenceMode: 'exact-window',
        callItmOiChangePct: callPct,
        putItmOiChangePct: putPct,
      },
    },
  };
}

async function assertPortfolioOiRoute(portfolioId, oiTriggerMode, callPct, putPct, expectedOptionType, expectedSource) {
  const store = new MemoryStore();
  const engine = createPaperTradeEngine({
    store,
    rules: {
      marketHoursEnabled: true,
      portfolios: {
        portfolio1: { ...defaults, enabled: false },
        portfolio2: { ...defaults, enabled: false },
        portfolio3: { ...defaults, enabled: false },
        [portfolioId]: { ...defaults, enabled: true, oiTriggerEnabled: true, oiWindow: 'm5', oiThresholdMode: 'percentage', oiThreshold: 5, oiTriggerMode },
      },
    },
    contractLotSizes,
  });
  await engine.restore();
  await engine.process('NIFTY', oiPercentagePayload(callPct, putPct), summary(100, 120, 80_000), 80_000);
  const trade = engine.snapshot().trades[0];
  assert.equal(trade.optionType, expectedOptionType, `${portfolioId} must route the qualifying OI percentage to the requested option side`);
  assert.equal(trade.oiTriggerSource, expectedSource, `${portfolioId} must retain the OI trigger source in the paper audit`);
  assert.equal(trade.oiThresholdMode, 'percentage');
  assert.equal(trade.oiThreshold, 5);
}

await assertPortfolioOiRoute('portfolio1', 'negative-same-side', -6, -2, 'CALL', 'call-oi-negative-to-call');
await assertPortfolioOiRoute('portfolio1', 'negative-same-side', -2, -6, 'PUT', 'put-oi-negative-to-put');
await assertPortfolioOiRoute('portfolio2', 'positive-opposite-side', 2, 6, 'CALL', 'put-oi-positive-to-call');
await assertPortfolioOiRoute('portfolio2', 'positive-opposite-side', 6, 2, 'PUT', 'call-oi-positive-to-put');

console.log('paper trading tests passed');
