import assert from 'node:assert/strict';
import { createPaperTradeEngine } from './paperTrading.js';

class MemoryStore {
  constructor() { this.trades = []; this.signalStates = {}; }
  async initialize() { return true; }
  async load() { return { trades: structuredClone(this.trades), signalStates: structuredClone(this.signalStates) }; }
  saveTrade(trade) { const index = this.trades.findIndex((item) => item.id === trade.id); if (index >= 0) this.trades[index] = structuredClone(trade); else this.trades.push(structuredClone(trade)); return Promise.resolve(true); }
  saveSignalState(symbol, signal) { this.signalStates[symbol] = signal; return Promise.resolve(true); }
  getStatus() { return { mode: 'postgres', status: 'ready', lastError: null }; }
}

function summary(callPrice = 100, putPrice = 120) {
  return {
    underlyingPrice: 24250,
    strikes: {
      24200: { ce: { lastPrice: 90 }, pe: { lastPrice: 130 } },
      24250: { ce: { securityId: 101, lastPrice: callPrice }, pe: { securityId: 202, lastPrice: putPrice } },
      24300: { ce: { lastPrice: 80 }, pe: { lastPrice: 140 } },
    },
  };
}

function payload(label) {
  return { windows: { m5: { referenceMode: 'exact-window', marketStrength: { label } } } };
}

const store = new MemoryStore();
const engine = createPaperTradeEngine({ store, rules: { enabled: true, lots: 10, targetPoints: 2, stopLossPoints: 5 } });
await engine.restore();

await engine.process('NIFTY', payload('Strong upward pressure'), summary(), 1_000);
let state = engine.snapshot();
assert.equal(state.trades.length, 1);
assert.equal(state.trades[0].optionType, 'CALL');
assert.equal(state.trades[0].entryPrice, 100);
assert.equal(state.trades[0].targetPrice, 102);
assert.equal(state.trades[0].stopLossPrice, 95);

await engine.process('NIFTY', payload('Strong upward pressure'), summary(101), 2_000);
assert.equal(engine.snapshot().trades.length, 1, 'one continuous strong signal must not create duplicate trades');
await engine.process('NIFTY', payload('Strong upward pressure'), summary(102), 3_000);
state = engine.snapshot();
assert.equal(state.trades[0].status, 'closed');
assert.equal(state.trades[0].closeReason, 'target');
assert.equal(state.trades[0].resultPoints, 2);

await engine.process('NIFTY', payload('Strong upward pressure'), summary(103), 4_000);
assert.equal(engine.snapshot().trades.length, 1, 'a settled trade must not reopen until the strong signal exits and re-enters');
await engine.process('NIFTY', payload('Balanced / mixed'), summary(103), 5_000);
await engine.process('NIFTY', payload('Strong downward pressure'), summary(104, 120), 6_000);
state = engine.snapshot();
assert.equal(state.trades.length, 2);
assert.equal(state.trades[0].optionType, 'PUT');
await engine.process('NIFTY', payload('Strong downward pressure'), summary(104, 115), 7_000);
state = engine.snapshot();
assert.equal(state.trades[0].status, 'closed');
assert.equal(state.trades[0].closeReason, 'stop-loss');
assert.equal(state.trades[0].resultPoints, -5);

const restored = createPaperTradeEngine({ store, rules: { enabled: true, lots: 10, targetPoints: 2, stopLossPoints: 5 } });
await restored.restore();
assert.equal(restored.snapshot().trades.length, 2, 'paper records must recover from durable storage');

const eligibilityStore = new MemoryStore();
const eligibilityEngine = createPaperTradeEngine({ store: eligibilityStore, rules: { enabled: true, lots: 10, targetPoints: 2, stopLossPoints: 5 } });
await eligibilityEngine.restore();
await eligibilityEngine.process('SENSEX', { windows: { m5: { referenceMode: 'current-market-baseline', marketStrength: { label: 'Strong upward pressure' } } } }, summary(), 8_000);
assert.equal(eligibilityEngine.snapshot().trades.length, 0, 'reset/start provisional windows must never open a paper trade');
await eligibilityEngine.process('SENSEX', { windows: {
  m5: { referenceMode: 'exact-window', marketStrength: { label: 'Balanced / mixed' } },
  m30: { referenceMode: 'exact-window', marketStrength: { label: 'Strong upward pressure' } },
} }, summary(), 9_000);
const eligibleTrade = eligibilityEngine.snapshot().trades[0];
assert.equal(eligibleTrade.optionType, 'CALL', 'a later completed qualifying window may open a Buy Call when the shorter completed window is non-qualifying');
assert.equal(eligibleTrade.signalWindow, '30 Min');
console.log('paper trading tests passed');
