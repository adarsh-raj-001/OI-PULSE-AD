import assert from 'node:assert/strict';
import { createPaperTradeStore } from './paperTradeStore.js';

class MemoryPgPool {
  constructor() {
    this.trades = new Map();
    this.signals = new Map();
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
    if (statement.startsWith('SELECT TRADE ')) {
      return { rows: [...this.trades.values()].sort((a, b) => b.opened_at - a.opened_at).map((row) => ({ trade: row.trade })) };
    }
    if (statement.startsWith('SELECT SYMBOL, SIGNAL ')) {
      return { rows: [...this.signals.entries()].map(([symbol, signal]) => ({ symbol, signal })) };
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
  lots: 10, entryPrice: 100, targetPrice: 102, stopLossPrice: 95,
};
assert.equal(await store.saveTrade(openTrade), true);
assert.equal(await store.saveSignalState('NIFTY', 'up', 1000), true);

const restarted = createPaperTradeStore({ pool, logger: { error() {} } });
assert.equal(await restarted.initialize(), true);
let restored = await restarted.load();
assert.equal(restored.trades.length, 1);
assert.equal(restored.trades[0].securityId, 101, 'open contract identity must survive restart recovery');
assert.deepEqual(restored.signalStates, { NIFTY: 'up' }, 'continuous-signal guard must survive a restart');

const closedTrade = { ...openTrade, status: 'closed', exitPrice: 102, closedAt: 2000, closeReason: 'target', resultPoints: 2 };
assert.equal(await store.saveTrade(closedTrade), true);
restored = await restarted.load();
assert.equal(restored.trades[0].status, 'closed');
assert.equal(restored.trades[0].resultPoints, 2);
assert.deepEqual(restarted.getStatus(), { mode: 'postgres', status: 'ready', lastError: null });

const disabled = createPaperTradeStore({ logger: { error() {} } });
assert.equal(await disabled.initialize(), false);
assert.equal(disabled.getStatus().mode, 'disabled');
console.log('paper trade store tests passed');
