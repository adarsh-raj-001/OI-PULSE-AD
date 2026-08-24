import assert from 'node:assert/strict';
import { createPaperTradeEngine } from './paperTrading.js';

class MemoryStore {
  constructor() { this.trades = []; this.signalStates = {}; this.settings = null; }
  async initialize() { return true; }
  async load() { return { trades: structuredClone(this.trades), signalStates: structuredClone(this.signalStates), settings: structuredClone(this.settings) }; }
  saveTrade(trade) { const index = this.trades.findIndex((item) => item.id === trade.id); if (index >= 0) this.trades[index] = structuredClone(trade); else this.trades.push(structuredClone(trade)); return Promise.resolve(true); }
  saveSignalState(symbol, signal) { this.signalStates[symbol] = signal; return Promise.resolve(true); }
  saveSettings(settings) { this.settings = structuredClone(settings); return Promise.resolve(true); }
  getStatus() { return { mode: 'postgres', status: 'ready', lastError: null }; }
  isReady() { return true; }
}

const defaults = { enabled: true, lots: 10, triggerLevel: 'strong', targetPoints: 2, stopLossPoints: 5, maxAliveSeconds: 0, cooldownSeconds: 0 };

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

function payload(label, window = 'm5') {
  return { windows: { [window]: { referenceMode: 'exact-window', marketStrength: { label } } } };
}

const store = new MemoryStore();
const engine = createPaperTradeEngine({ store, rules: defaults });
await engine.restore();

await engine.process('NIFTY', payload('Strong upward pressure'), summary(), 1_000);
let state = engine.snapshot();
assert.equal(state.trades.length, 1);
assert.equal(state.trades[0].optionType, 'CALL');
assert.equal(state.trades[0].entryPrice, 100);
assert.equal(state.trades[0].entryPriceSource, 'live-option-ltp');
assert.equal(state.trades[0].entryPriceObservedAt, 1_000);
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

const restored = createPaperTradeEngine({ store, rules: defaults });
await restored.restore();
assert.equal(restored.snapshot().trades.length, 3, 'paper records must recover from durable storage');

const eligibilityStore = new MemoryStore();
const eligibilityEngine = createPaperTradeEngine({ store: eligibilityStore, rules: defaults });
await eligibilityEngine.restore();
await eligibilityEngine.process('SENSEX', { windows: { m5: { referenceMode: 'current-market-baseline', marketStrength: { label: 'Strong upward pressure' } } } }, summary(100, 120, 8_000), 8_000);
assert.equal(eligibilityEngine.snapshot().trades.length, 0, 'reset/start provisional windows must never open a paper trade');
await eligibilityEngine.process('SENSEX', { windows: {
  m5: { referenceMode: 'exact-window', marketStrength: { label: 'Balanced / mixed' } },
  m30: { referenceMode: 'exact-window', marketStrength: { label: 'Strong upward pressure' } },
} }, summary(100, 120, 9_000), 9_000);
const eligibleTrade = eligibilityEngine.snapshot().trades[0];
assert.equal(eligibleTrade.optionType, 'CALL', 'a later completed qualifying window may open a Buy Call when the shorter completed window is non-qualifying');
assert.equal(eligibleTrade.signalWindow, '30 Min');

const controlStore = new MemoryStore();
const controlEngine = createPaperTradeEngine({ store: controlStore, rules: defaults });
await controlEngine.restore();
await controlEngine.updateSettings({ lots: 20, triggerLevel: 'mild', targetPoints: 3, stopLossPoints: 4, maxAliveSeconds: 10, cooldownSeconds: 3 }, 10_000);
await controlEngine.process('NIFTY', payload('Mild upward pressure'), summary(100, 120, 11_000), 11_000);
state = controlEngine.snapshot();
assert.equal(state.trades.length, 1, 'mild trigger mode must accept a completed Mild upward pressure label');
assert.equal(state.trades[0].lots, 20);
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
const freshnessEngine = createPaperTradeEngine({ store: freshnessStore, rules: defaults });
await freshnessEngine.restore();
await freshnessEngine.process('NIFTY', payload('Strong upward pressure'), summary(100, 120, 1), 16_001);
assert.equal(freshnessEngine.snapshot().trades.length, 0, 'an expired option LTP must never create a simulated entry');
await freshnessEngine.process('NIFTY', payload('Strong upward pressure'), summary(99, 120, 16_002), 16_002);
state = freshnessEngine.snapshot();
assert.equal(state.trades[0].entryPrice, 99, 'a new simulation must fill at the latest valid selected-option LTP');
assert.equal(state.trades[0].entryPriceObservedAt, 16_002);

const pnlStore = new MemoryStore();
const pnlEngine = createPaperTradeEngine({ store: pnlStore, rules: defaults });
await pnlEngine.restore();
await pnlEngine.process('NIFTY', payload('Strong upward pressure'), summary(100, 120, 30_000), 30_000);
await pnlEngine.process('NIFTY', payload('Balanced / mixed'), summary(101, 120, 31_000), 31_000);
state = pnlEngine.snapshot();
assert.equal(state.performance.unrealisedPoints, 1);
assert.equal(state.performance.unrealisedMoney, 10, 'paper money P&L is premium movement × simulated quantity');
assert.equal(state.performance.netMoney, 10);
await pnlEngine.process('NIFTY', payload('Balanced / mixed'), summary(102, 120, 32_000), 32_000);
state = pnlEngine.snapshot();
assert.equal(state.performance.realisedPoints, 2);
assert.equal(state.performance.realisedMoney, 20);
assert.equal(state.performance.unrealisedMoney, 0);
assert.equal(state.performance.netMoney, 20);

const settingsRestored = createPaperTradeEngine({ store: controlStore, rules: defaults });
await settingsRestored.restore();
state = settingsRestored.snapshot();
assert.equal(state.rules.lots, 20, 'screen-edited simulator controls must persist across restart');
assert.equal(state.rules.enabled, true);
console.log('paper trading tests passed');
