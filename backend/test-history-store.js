import assert from 'node:assert/strict';
import { compactHistorySummary, createHistoryStore } from './historyStore.js';

class MemoryPgPool {
  constructor() {
    this.rows = [];
  }

  async query(sql, values = []) {
    const statement = String(sql).replace(/\s+/g, ' ').trim().toUpperCase();
    if (statement.startsWith('CREATE ')) return { rows: [] };
    if (statement.startsWith('INSERT ')) {
      const [symbol, recordedAt, snapshotText] = values;
      const next = { symbol, recorded_at: String(recordedAt), snapshot: JSON.parse(snapshotText) };
      const index = this.rows.findIndex((row) => row.symbol === symbol && Number(row.recorded_at) === Number(recordedAt));
      if (index >= 0) this.rows[index] = next;
      else this.rows.push(next);
      return { rows: [] };
    }
    if (statement.startsWith('DELETE ')) {
      if (statement.includes('WHERE SYMBOL = $1')) {
        const [symbol] = values;
        this.rows = this.rows.filter((row) => row.symbol !== symbol);
      } else {
        const [cutoff] = values;
        this.rows = this.rows.filter((row) => Number(row.recorded_at) >= Number(cutoff));
      }
      return { rows: [] };
    }
    if (statement.startsWith('SELECT ')) {
      const [symbols, cutoff] = values;
      return {
        rows: this.rows
          .filter((row) => symbols.includes(row.symbol) && Number(row.recorded_at) >= Number(cutoff))
          .sort((a, b) => a.symbol.localeCompare(b.symbol) || Number(a.recorded_at) - Number(b.recorded_at)),
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

const summary = {
  underlyingPrice: 24250,
  expiry: '2026-08-27',
  strikes: {
    24250: {
      ce: { securityId: 1, oi: 200, previousOi: 150, lastPrice: 100, volume: 90, impliedVolatility: 12, topBidPrice: 99, topBidQuantity: 10, topAskPrice: 101, topAskQuantity: 11 },
      pe: { securityId: 2, oi: 300, previousOi: 250, lastPrice: 110, volume: 80, impliedVolatility: 13, topBidPrice: 109, topBidQuantity: 12, topAskPrice: 111, topAskQuantity: 14 },
    },
  },
};

const compact = compactHistorySummary(summary);
assert.equal(compact.strikes[24250].ce.oi, 200);
assert.equal('securityId' in compact.strikes[24250].ce, false);
assert.equal('topBidQuantity' in compact.strikes[24250].ce, false);
assert.equal(compact.resetBaseline, false);

const pool = new MemoryPgPool();
let now = 20_000;
const store = createHistoryStore({ pool, historyMaxMs: 10_000, persistIntervalMs: 5_000, now: () => now, logger: { error() {} } });
assert.equal(await store.initialize(), true);
assert.equal(await store.save('NIFTY', { t: 10_000, ...summary }), true);
assert.equal(await store.save('NIFTY', { t: 12_000, ...summary }), false, 'nearby live events should be coalesced before persistence');
assert.equal(await store.save('NIFTY', { t: 16_000, ...summary }), true);

// A new store instance represents a newly deployed/restarted backend process.
const restartedStore = createHistoryStore({ pool, historyMaxMs: 10_000, persistIntervalMs: 5_000, now: () => now, logger: { error() {} } });
assert.equal(await restartedStore.initialize(), true);
let restored = await restartedStore.load(['NIFTY', 'SENSEX']);
assert.deepEqual(restored.NIFTY.map((snapshot) => snapshot.t), [10_000, 16_000]);
assert.deepEqual(restored.SENSEX, []);
assert.deepEqual(restored.NIFTY[0].strikes[24250].pe, { oi: 300, lastPrice: 110 });

now = 28_000;
assert.equal(await store.save('NIFTY', { t: 28_000, ...summary }), true);
restored = await restartedStore.load(['NIFTY']);
assert.deepEqual(restored.NIFTY.map((snapshot) => snapshot.t), [28_000], 'retention pruning should remove expired durable snapshots');
assert.deepEqual(restartedStore.getStatus(), { mode: 'postgres', status: 'ready', lastError: null });

// A symbol reset removes only that symbol's durable references, leaving another
// market's independent 5m/30m/3h collection untouched.
assert.equal(await store.save('SENSEX', { t: 28_000, ...summary }), true);
assert.equal(await store.reset('NIFTY'), true);
assert.equal(await store.save('NIFTY', { t: 28_000, ...summary, resetBaseline: true, baselineReason: 'reset-real-market-snapshot' }), true);
restored = await restartedStore.load(['NIFTY', 'SENSEX']);
assert.equal(restored.NIFTY.length, 1);
assert.equal(restored.NIFTY[0].resetBaseline, true, 'a restarted process must retain the immediate reset baseline marker');
assert.equal(restored.NIFTY[0].baselineReason, 'reset-real-market-snapshot');
assert.deepEqual(restored.SENSEX.map((snapshot) => snapshot.t), [28_000]);

console.log('history store tests passed');
