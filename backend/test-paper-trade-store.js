import assert from 'node:assert/strict';
import { createPaperTradeStore } from './paperTradeStore.js';

class MemoryPgPool {
  constructor() {
    this.trades = new Map();
    this.signals = new Map();
    this.settings = new Map();
  }

  async query(sql, values = []) {
    const statement = String(sql).replace(/\s+/g, ' ').trim().toUpperCase();
    if (statement.startsWith('CREATE ')) return { rows: [] };
    if (statement.startsWith('INSERT INTO OI_PULSE_PAPER_TRADES')) {
      const [id, symbol, status, openedAt, tradeText] = values;
      this.trades.set(id, { id, symbol, status, opened_at: openedAt, trade: JSON.parse(tradeText) });
      return { rows: [] };
    }
    if (statement.startsWith('INSERT INTO OI_PULSE_PAPER_TRADE_SIGNALS')) {
      const [symbol, signal] = values;
      this.signals.set(symbol, signal);
      return { rows: [] };
    }
    if (statement.startsWith('INSERT INTO OI_PULSE_PAPER_TRADE_SETTINGS')) {
      const [key, settingsText, updatedAt] = values;
      this.settings.set(key, { settings: JSON.parse(settingsText), updated_at: updatedAt });
      return { rows: [] };
    }
    if (statement === 'DELETE FROM OI_PULSE_PAPER_TRADES') {
      this.trades.clear();
      return { rows: [] };
    }
    if (statement === 'DELETE FROM OI_PULSE_PAPER_TRADE_SIGNALS') {
      this.signals.clear();
      return { rows: [] };
    }
    if (statement.startsWith('SELECT TRADE ')) {
      return { rows: [...this.trades.values()].sort((a, b) => b.opened_at - a.opened_at).map((row) => ({ trade: row.trade })) };
    }
    if (statement.startsWith('SELECT SYMBOL, SIGNAL ')) {
      return { rows: [...this.signals.entries()].map(([symbol, signal]) => ({ symbol, signal })) };
    }
    if (statement.startsWith('SELECT SETTINGS ')) {
      const row = this.settings.get(values[0]);
      return { rows: row ? [{ settings: row.settings }] : [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

const pool = new MemoryPgPool();
const store = createPaperTradeStore({ pool, logger: { error() {} } });
assert.equal(await store.initialize(), true);
const openTrade = {
  id: 'paper-1', symbol: 'NIFTY', status: 'open', openedAt: 1000,
  optionType: 'CALL', optionSide: 'ce', securityId: 101, strike: 24250,
  lots: 20, entryPrice: 100, targetPrice: 103, stopLossPrice: 96, expiresAt: 11000, cooldownSecondsAtEntry: 3,
};
const settings = { enabled: true, lots: 20, triggerLevel: 'mild', targetPoints: 3, stopLossPoints: 4, maxAliveSeconds: 10, cooldownSeconds: 3 };
assert.equal(await store.saveTrade(openTrade), true);
assert.equal(await store.saveSignalState('NIFTY', 'up', 1000), true);
assert.equal(await store.saveSettings(settings, 1000), true);

const restarted = createPaperTradeStore({ pool, logger: { error() {} } });
assert.equal(await restarted.initialize(), true);
let restored = await restarted.load();
assert.equal(restored.trades.length, 1);
assert.equal(restored.trades[0].securityId, 101, 'open contract identity must survive restart recovery');
assert.deepEqual(restored.signalStates, { NIFTY: 'up' }, 'continuous-signal guard must survive a restart');
assert.deepEqual(restored.settings, settings, 'screen-edited runtime controls must survive a restart');

const closedTrade = { ...openTrade, status: 'closed', exitPrice: 101, closedAt: 11000, closeReason: 'time-expired', cooldownUntil: 14000, resultPoints: 1 };
assert.equal(await store.saveTrade(closedTrade), true);
restored = await restarted.load();
assert.equal(restored.trades[0].status, 'closed');
assert.equal(restored.trades[0].cooldownUntil, 14000);
assert.deepEqual(restarted.getStatus(), { mode: 'postgres', status: 'ready', lastError: null });

assert.equal(await restarted.clearSessionHistory(), true);
restored = await restarted.load();
assert.deepEqual(restored.trades, [], 'daily reset must remove durable paper trade records');
assert.deepEqual(restored.signalStates, {}, 'daily reset must remove durable signal guards');
assert.deepEqual(restored.settings, settings, 'daily reset must preserve durable simulator settings');

const disabled = createPaperTradeStore({ logger: { error() {} } });
assert.equal(await disabled.initialize(), false);
assert.equal(disabled.getStatus().mode, 'disabled');
console.log('paper trade store tests passed');
