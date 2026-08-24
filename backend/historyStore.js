// Durable raw OI snapshot storage. The active process continues to calculate
// immediately from memory; this store preserves a compact copy so an exact
// 5m/30m/3h reference can be restored after a restart or redeploy.

import { Pool } from 'pg';

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function compactLeg(leg) {
  return {
    // Preserve unavailable OI as null. Persisting a missing source value as
    // zero would turn a future comparison into an artificial positive delta.
    oi: finiteOrNull(leg?.oi),
    lastPrice: finiteOrNull(leg?.lastPrice),
  };
}

// The historical side of an exact OI delta needs only OI and premium values.
// Security IDs, quotes, volume, IV, and previous-day OI come from the current
// Dhan snapshot; omitting them keeps retained snapshots small while preserving
// exact window OI and premium comparisons.
export function compactHistorySummary(summary) {
  const strikes = {};
  for (const [strike, legs] of Object.entries(summary?.strikes || {})) {
    strikes[strike] = { ce: compactLeg(legs?.ce), pe: compactLeg(legs?.pe) };
  }
  return {
    underlyingPrice: finiteOrNull(summary?.underlyingPrice),
    expiry: typeof summary?.expiry === 'string' ? summary.expiry : null,
    // Retain the explicit real-market baseline marker so a restart can keep
    // immediate reset-time deltas instead of reverting the cards to a wait.
    resetBaseline: summary?.resetBaseline === true,
    baselineReason: typeof summary?.baselineReason === 'string' ? summary.baselineReason : null,
    strikes,
  };
}

function normalizeStoredSnapshot(row) {
  const t = Number(row?.recorded_at);
  const payload = row?.snapshot;
  if (!Number.isFinite(t) || !payload || typeof payload !== 'object' || !payload.strikes || typeof payload.strikes !== 'object') return null;
  return { t, ...payload };
}

export function createHistoryStore({ databaseUrl, historyMaxMs, persistIntervalMs, pool = null, logger = console, now = () => Date.now() }) {
  const client = pool || (databaseUrl ? new Pool({ connectionString: databaseUrl }) : null);
  const lastStoredAt = new Map();
  let queued = Promise.resolve();
  let initialized = false;
  let lastPruneAt = 0;
  let status = client ? 'connecting' : 'memory-only';
  let lastError = null;

  function enqueue(operation) {
    queued = queued.then(operation).catch((err) => {
      status = 'degraded';
      lastError = err?.message || String(err);
      logger.error(`[history-store] ${lastError}`);
    });
    return queued;
  }

  async function initialize() {
    if (!client) return false;
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS oi_pulse_snapshot_history (
          symbol TEXT NOT NULL,
          recorded_at BIGINT NOT NULL,
          snapshot JSONB NOT NULL,
          PRIMARY KEY (symbol, recorded_at)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS oi_pulse_snapshot_history_recent
        ON oi_pulse_snapshot_history (symbol, recorded_at)
      `);
      initialized = true;
      status = 'ready';
      lastError = null;
      return true;
    } catch (err) {
      status = 'degraded';
      lastError = err?.message || String(err);
      logger.error(`[history-store] initialization failed; continuing in memory: ${lastError}`);
      return false;
    }
  }

  async function load(symbols) {
    if (!client || !initialized) return Object.fromEntries(symbols.map((symbol) => [symbol, []]));
    const cutoff = now() - historyMaxMs;
    try {
      const result = await client.query(
        `SELECT symbol, recorded_at, snapshot
         FROM oi_pulse_snapshot_history
         WHERE symbol = ANY($1::text[]) AND recorded_at >= $2
         ORDER BY symbol ASC, recorded_at ASC`,
        [symbols, cutoff],
      );
      const restored = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
      for (const row of result.rows) {
        const snapshot = normalizeStoredSnapshot(row);
        if (snapshot && restored[row.symbol]) restored[row.symbol].push(snapshot);
      }
      for (const [symbol, snapshots] of Object.entries(restored)) {
        if (snapshots.length) lastStoredAt.set(symbol, snapshots[snapshots.length - 1].t);
      }
      status = 'ready';
      lastError = null;
      return restored;
    } catch (err) {
      status = 'degraded';
      lastError = err?.message || String(err);
      logger.error(`[history-store] recovery failed; continuing in memory: ${lastError}`);
      return Object.fromEntries(symbols.map((symbol) => [symbol, []]));
    }
  }

  function save(symbol, snapshot) {
    if (!client || !initialized || !Number.isFinite(snapshot?.t)) return Promise.resolve(false);
    const previousAt = lastStoredAt.get(symbol);
    if (previousAt !== undefined && snapshot.t - previousAt < persistIntervalMs) return Promise.resolve(false);
    lastStoredAt.set(symbol, snapshot.t);
    const payload = compactHistorySummary(snapshot);
    const cutoff = snapshot.t - historyMaxMs;

    return enqueue(async () => {
      await client.query(
        `INSERT INTO oi_pulse_snapshot_history (symbol, recorded_at, snapshot)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (symbol, recorded_at) DO UPDATE SET snapshot = EXCLUDED.snapshot`,
        [symbol, snapshot.t, JSON.stringify(payload)],
      );
      if (snapshot.t - lastPruneAt >= Math.max(persistIntervalMs, 60_000)) {
        await client.query('DELETE FROM oi_pulse_snapshot_history WHERE recorded_at < $1', [cutoff]);
        lastPruneAt = snapshot.t;
      }
      status = 'ready';
      lastError = null;
      return true;
    });
  }

  function reset(symbol) {
    if (!client || !initialized) {
      lastStoredAt.delete(symbol);
      return Promise.resolve(false);
    }
    // Place deletion behind any pending persistence work. This guarantees that
    // a pre-reset event already queued for storage cannot reappear after the
    // user intentionally establishes a new baseline.
    return enqueue(async () => {
      await client.query('DELETE FROM oi_pulse_snapshot_history WHERE symbol = $1', [symbol]);
      lastStoredAt.delete(symbol);
      status = 'ready';
      lastError = null;
      return true;
    });
  }

  async function close() {
    await queued;
    if (client && !pool) await client.end();
  }

  return {
    initialize,
    load,
    save,
    reset,
    close,
    getStatus: () => ({ mode: client ? 'postgres' : 'memory-only', status, lastError }),
  };
}
