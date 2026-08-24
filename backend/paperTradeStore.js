import { Pool } from 'pg';

function normalizeTrade(row) {
  const payload = row?.trade;
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') return null;
  return payload;
}

function normalizeSettings(row) {
  const payload = row?.settings;
  return payload && typeof payload === 'object' ? payload : null;
}

export function createPaperTradeStore({ databaseUrl, pool = null, logger = console }) {
  const client = pool || (databaseUrl ? new Pool({ connectionString: databaseUrl }) : null);
  let initialized = false;
  let status = client ? 'connecting' : 'disabled';
  let lastError = null;
  let queued = Promise.resolve();

  function enqueue(operation) {
    queued = queued.then(operation).catch((err) => {
      status = 'degraded';
      lastError = err?.message || String(err);
      logger.error(`[paper-trade-store] ${lastError}`);
    });
    return queued;
  }

  async function initialize() {
    if (!client) return false;
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS oi_pulse_paper_trades (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          status TEXT NOT NULL,
          opened_at BIGINT NOT NULL,
          trade JSONB NOT NULL
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS oi_pulse_paper_trades_recent
        ON oi_pulse_paper_trades (symbol, opened_at DESC)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS oi_pulse_paper_trade_signals (
          symbol TEXT PRIMARY KEY,
          signal TEXT NULL,
          updated_at BIGINT NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS oi_pulse_paper_trade_settings (
          setting_key TEXT PRIMARY KEY,
          settings JSONB NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `);
      initialized = true;
      status = 'ready';
      lastError = null;
      return true;
    } catch (err) {
      status = 'degraded';
      lastError = err?.message || String(err);
      logger.error(`[paper-trade-store] initialization failed; paper simulation remains disabled: ${lastError}`);
      return false;
    }
  }

  async function load() {
    if (!client || !initialized) return { trades: [], signalStates: {}, settings: null };
    try {
      const [tradeResult, signalResult, settingsResult] = await Promise.all([
        client.query('SELECT trade FROM oi_pulse_paper_trades ORDER BY opened_at DESC'),
        client.query('SELECT symbol, signal FROM oi_pulse_paper_trade_signals'),
        client.query('SELECT settings FROM oi_pulse_paper_trade_settings WHERE setting_key = $1', ['runtime']),
      ]);
      const trades = tradeResult.rows.map(normalizeTrade).filter(Boolean);
      const signalStates = Object.fromEntries(signalResult.rows.map((row) => [row.symbol, row.signal || null]));
      status = 'ready';
      lastError = null;
      return { trades, signalStates, settings: normalizeSettings(settingsResult.rows[0]) };
    } catch (err) {
      status = 'degraded';
      lastError = err?.message || String(err);
      logger.error(`[paper-trade-store] recovery failed; paper simulation remains disabled: ${lastError}`);
      return { trades: [], signalStates: {}, settings: null };
    }
  }

  function saveTrade(trade) {
    if (!client || !initialized || !trade?.id) return Promise.resolve(false);
    return enqueue(async () => {
      await client.query(
        `INSERT INTO oi_pulse_paper_trades (id, symbol, status, opened_at, trade)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, trade = EXCLUDED.trade`,
        [trade.id, trade.symbol, trade.status, trade.openedAt, JSON.stringify(trade)],
      );
      status = 'ready';
      lastError = null;
      return true;
    });
  }

  function saveSignalState(symbol, signal, updatedAt) {
    if (!client || !initialized) return Promise.resolve(false);
    return enqueue(async () => {
      await client.query(
        `INSERT INTO oi_pulse_paper_trade_signals (symbol, signal, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (symbol) DO UPDATE SET signal = EXCLUDED.signal, updated_at = EXCLUDED.updated_at`,
        [symbol, signal, updatedAt],
      );
      status = 'ready';
      lastError = null;
      return true;
    });
  }

  function saveSettings(settings, updatedAt) {
    if (!client || !initialized) return Promise.resolve(false);
    return enqueue(async () => {
      await client.query(
        `INSERT INTO oi_pulse_paper_trade_settings (setting_key, settings, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (setting_key) DO UPDATE SET settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at`,
        ['runtime', JSON.stringify(settings), updatedAt],
      );
      status = 'ready';
      lastError = null;
      return true;
    });
  }

  function clearSessionHistory() {
    if (!client || !initialized) return Promise.resolve(false);
    return enqueue(async () => {
      await client.query('DELETE FROM oi_pulse_paper_trades');
      await client.query('DELETE FROM oi_pulse_paper_trade_signals');
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
    saveTrade,
    saveSignalState,
    saveSettings,
    clearSessionHistory,
    close,
    getStatus: () => ({ mode: client ? 'postgres' : 'disabled', status, lastError }),
    isReady: () => initialized && status === 'ready',
  };
}
