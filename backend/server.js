// OI Pulse — backend relay
// Polls an option chain data source (Dhan, or the free NSE feed — see
// config.json's dataSource) for each configured symbol, tracks OI at the
// at-the-money strike plus N strikes above/below, computes 5m/30m/3h
// deltas per strike, streams over SSE, and pushes a notification when
// a window's combined change crosses its configured threshold.

import express from 'express';
import cors from 'cors';
import { secrets, config, notificationsEnabled } from './config.js';
import { addSubscription, removeSubscription, checkThresholds } from './notifications.js';
import * as dhanSource from './dataSources/dhan.js';
import * as nseFreeSource from './dataSources/nseFree.js';
import { appendChartPoint, buildChartPoint } from './chartHistory.js';
import { DhanLiveFeed } from './dhanLiveFeed.js';
import { SerializedPollScheduler } from './pollScheduler.js';
import { isLiveFeedFresh, resolveDashboardStatus } from './liveStatus.js';
import { createHistoryStore } from './historyStore.js';
import { createPaperTradeStore } from './paperTradeStore.js';
import { createPaperTradeEngine } from './paperTrading.js';
import { currentBaselineDelta, exactWindowDelta, nearestStrikeIndex, sortedStrikes } from './oiWindows.js';

const source = config.dataSource === 'dhan' ? dhanSource : nseFreeSource;

// symbol -> array of { t, underlyingPrice, strikes: { [strike]: {ce, pe} } }
const history = Object.fromEntries(config.symbols.map((s) => [s.name, []]));
const historyResetInFlight = new Set();

// Postgres is optional at code level so local/demo development remains simple.
// In production, configuring OI_HISTORY_DATABASE_URL makes the raw snapshots
// survive a Render deploy, restart, or temporary Dhan connection failure.
const historyStore = createHistoryStore({
  databaseUrl: config.historyDatabaseUrl,
  historyMaxMs: config.historyMaxMs,
  persistIntervalMs: config.historyPersistIntervalMs,
});

// The paper simulator has no broker credentials and no order endpoint. It uses
// only the already-received Dhan market summary and a separate durable table.
const paperTradeStore = createPaperTradeStore({ databaseUrl: config.historyDatabaseUrl });
const paperTrading = createPaperTradeEngine({
  store: paperTradeStore,
  rules: config.paperTrading,
  onChange: () => broadcastPaperTrades(),
});

// symbol -> compact 10-hour near-ATM chart points. These are separate from
// raw OI snapshots so history delivery stays fast and bounded.
const chartHistory = Object.fromEntries(config.symbols.map((s) => [s.name, []]));

// symbol -> latest computed payload sent to clients
const latest = Object.fromEntries(config.symbols.map((s) => [s.name, null]));

// The REST chain remains the complete reference snapshot. The live object is
// a mutable copy of that chain whose active ATM band is updated by Dhan's Full
// Packet stream between REST calls.
const liveState = Object.fromEntries(config.symbols.map((s) => [s.name, null]));
const restState = Object.fromEntries(config.symbols.map((s) => [s.name, 'starting']));
const liveInstrumentRefs = new Map();
let liveFeedStatus = { state: config.liveFeedEnabled ? 'waiting' : 'disabled', lastEventAt: null };
let liveFeed = null;


function computePayload(name) {
  const hist = history[name];
  if (!hist.length) return null;
  const cur = hist[hist.length - 1];
  const baseline = hist.find((snapshot) => snapshot.resetBaseline === true) || hist[0];
  const windowFor = (windowMs) => exactWindowDelta(hist, cur.t, windowMs, config.strikesEachSide)
    || currentBaselineDelta(baseline, cur, windowMs, config.strikesEachSide);
  return {
    symbol: name,
    updatedAt: cur.t,
    underlyingPrice: cur.underlyingPrice,
    history: {
      baselineAt: baseline.t,
      collectedMs: Math.max(0, cur.t - baseline.t),
      source: baseline.baselineReason || 'initial-real-market-snapshot',
    },
    windows: {
      m5: windowFor(5 * 60 * 1000),
      m30: windowFor(30 * 60 * 1000),
      h3: windowFor(3 * 60 * 60 * 1000),
    },
  };
}

function chartMeta(name, point) {
  return {
    samplingMode: config.liveFeedEnabled ? 'event-driven' : 'snapshot',
    eventBucketMs: config.liveFeedEnabled ? config.liveFeedEventBucketMs : config.pollIntervalMs,
    fallbackIntervalMs: config.pollIntervalMs,
    retentionMs: config.chartHistoryMaxMs,
    point: point || chartHistory[name][chartHistory[name].length - 1] || null,
  };
}

function cloneSummary(summary) {
  return structuredClone(summary);
}

function updatePayload(name, point, nextRestState = null) {
  if (nextRestState) restState[name] = nextRestState;
  const payload = computePayload(name);
  if (!payload) return;
  const dataStatus = resolveDashboardStatus({
    restState: restState[name],
    liveFeedStatus,
    freshnessMs: config.liveFeedFreshnessMs,
  });
  payload.status = dataStatus.status;
  payload.dataStatus = dataStatus;
  payload.chart = chartMeta(name, point);
  payload.liveFeed = { ...liveFeedStatus };
  latest[name] = payload;
  checkThresholds(name, payload.windows);
}

function recordSnapshot(name, summary, t, { eventDriven = false, restState: nextRestState = null, persist = true, allowDuringReset = false } = {}) {
  if (historyResetInFlight.has(name) && !allowDuringReset) return;
  const hist = history[name];
  const previous = hist[hist.length - 1] || null;
  const shouldReplace = eventDriven && previous && t - previous.t < config.liveFeedEventBucketMs;
  const snapshot = { t: shouldReplace ? previous.t : t, ...cloneSummary(summary) };

  if (shouldReplace) hist[hist.length - 1] = snapshot;
  else hist.push(snapshot);
  const cutoff = t - config.historyMaxMs;
  while (hist.length && hist[0].t < cutoff) hist.shift();

  // Durable writes are coalesced independently of in-memory event buckets.
  // This retains restart-safe exact-window references without making every
  // WebSocket packet a database write.
  if (persist && !historyResetInFlight.has(name)) void historyStore.save(name, snapshot);

  const points = chartHistory[name];
  const replacingChartBucket = eventDriven && points.length > 0 && t - points[points.length - 1].t < config.liveFeedEventBucketMs;
  const previousChartPoint = replacingChartBucket ? points[points.length - 2] || null : points[points.length - 1] || null;
  const chartPoint = buildChartPoint(snapshot, previousChartPoint, config.strikesEachSide);
  appendChartPoint(points, chartPoint, t - config.chartHistoryMaxMs, eventDriven ? config.liveFeedEventBucketMs : 0);
  updatePayload(name, chartPoint, nextRestState);
  // The simulator consumes the current summary only. It never initiates a Dhan
  // REST request, and its engine ignores reset/start provisional windows.
  void paperTrading.process(name, latest[name], summary, t);
}

function activeBandSubscriptions(sym, summary) {
  const strikes = sortedStrikes(summary.strikes);
  const atmIndex = nearestStrikeIndex(strikes, summary.underlyingPrice);
  if (atmIndex === null) return [];
  const optionSegment = sym.name === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO';
  const subscriptions = [{
    exchangeSegment: 'IDX_I',
    securityId: sym.dhan.securityId,
    symbol: sym.name,
    kind: 'underlying',
  }];
  for (let offset = -config.strikesEachSide; offset <= config.strikesEachSide; offset += 1) {
    const strike = strikes[atmIndex + offset];
    const legs = summary.strikes[strike];
    for (const side of ['ce', 'pe']) {
      const securityId = Number(legs?.[side]?.securityId);
      if (!Number.isFinite(securityId)) continue;
      subscriptions.push({ exchangeSegment: optionSegment, securityId, symbol: sym.name, kind: 'option', strike, side });
    }
  }
  return subscriptions;
}

function refreshLiveSubscriptions() {
  if (!liveFeed) return;
  const subscriptions = [];
  liveInstrumentRefs.clear();
  const addLiveSubscription = (instrument) => {
    const key = `${instrument.exchangeSegment}:${instrument.securityId}`;
    if (liveInstrumentRefs.has(key)) return;
    liveInstrumentRefs.set(key, instrument);
    subscriptions.push(instrument);
  };
  for (const sym of config.symbols) {
    const summary = liveState[sym.name];
    if (!summary || !sym.dhan) continue;
    for (const instrument of activeBandSubscriptions(sym, summary)) {
      addLiveSubscription(instrument);
    }
    // Retain the original option subscription until its simulated position is
    // closed, even if ATM moves. Target/stop evaluation remains option-LTP based.
    const openTrade = paperTrading.activeTrade(sym.name);
    if (!openTrade || !Number.isFinite(openTrade.securityId)) continue;
    const optionSegment = sym.name === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO';
    addLiveSubscription({
      exchangeSegment: optionSegment,
      securityId: openTrade.securityId,
      symbol: sym.name,
      kind: 'option',
      strike: openTrade.strike,
      side: openTrade.optionSide,
      paperTracking: true,
    });
  }
  liveFeed.setSubscriptions(subscriptions);
  liveFeed.start();
}

function applyLivePacket(packet) {
  const ref = liveInstrumentRefs.get(`${packet.exchangeSegment}:${packet.securityId}`);
  if (!ref) return;
  const summary = liveState[ref.symbol];
  if (!summary) return;

  if (ref.kind === 'underlying') {
    if (Number.isFinite(packet.lastPrice)) summary.underlyingPrice = packet.lastPrice;
  } else {
    const leg = summary.strikes?.[ref.strike]?.[ref.side];
    if (!leg) return;
    if (Number.isFinite(packet.lastPrice)) leg.lastPrice = packet.lastPrice;
    if (Number.isFinite(packet.oi)) leg.oi = packet.oi;
    if (Number.isFinite(packet.volume)) leg.volume = packet.volume;
    const top = packet.depth?.[0];
    if (top) {
      leg.topBidPrice = top.bidPrice;
      leg.topBidQuantity = top.bidQuantity;
      leg.topAskPrice = top.askPrice;
      leg.topAskQuantity = top.askQuantity;
    }
  }
  recordSnapshot(ref.symbol, summary, packet.receivedAt, { eventDriven: true });
}

if (config.liveFeedEnabled) {
  liveFeed = new DhanLiveFeed({
    getCredentials: dhanSource.getLiveFeedCredentials,
    onPacket: applyLivePacket,
    onStatus: (status) => {
      liveFeedStatus = status;
      for (const name of Object.keys(latest)) {
        if (latest[name]) updatePayload(name, chartHistory[name][chartHistory[name].length - 1]);
      }
    },
  });
}

const pollInFlight = new Set();

async function pollSymbol(sym) {
  if (pollInFlight.has(sym.name)) return;
  pollInFlight.add(sym.name);
  try {
    const summary = await source.fetchSnapshot(sym);
    const t = Date.now();
    const hasRetainedHistory = history[sym.name].length > 0;
    liveState[sym.name] = cloneSummary(summary);
    refreshLiveSubscriptions();
    const streamOwnsHistory = config.liveFeedEnabled
      && isLiveFeedFresh(liveFeedStatus, Date.now(), config.liveFeedFreshnessMs)
      && hasRetainedHistory;
    if (streamOwnsHistory) {
      // The chain call refreshes expiry, full-chain context, IV, and the active
      // security-ID universe. Do not manufacture a graph point on its timer
      // while the stream is healthy; the next real feed event owns history.
      updatePayload(sym.name, chartHistory[sym.name][chartHistory[sym.name].length - 1], 'live');
    } else {
      // First snapshot and every degraded/live-feed-reconnect period retain the
      // existing REST fallback rather than leaving the dashboard empty.
      recordSnapshot(sym.name, { ...liveState[sym.name], resetBaseline: !hasRetainedHistory, baselineReason: 'initial-real-market-snapshot' }, t, { restState: 'live' });
    }
    return { retryAfterMs: 0 };
  } catch (err) {
    console.error(`[poll:${sym.name}]`, err.message);
    const nextRestState = err.status === 429 ? 'rate-limited' : 'error';
    if (latest[sym.name]) updatePayload(sym.name, chartHistory[sym.name][chartHistory[sym.name].length - 1], nextRestState);
    else latest[sym.name] = { symbol: sym.name, status: 'error', error: err.message, dataStatus: { status: 'error', source: 'rest-error', restState: nextRestState } };
    return { retryAfterMs: Number(err.retryAfterMs) || 0 };
  } finally {
    pollInFlight.delete(sym.name);
  }
}

async function resetSymbolHistory(name) {
  const summary = liveState[name];
  if (!summary) {
    const error = new Error(`No real ${name} market snapshot is available yet. Wait for the first Dhan update before resetting history.`);
    error.statusCode = 409;
    throw error;
  }
  if (historyResetInFlight.has(name)) {
    const error = new Error(`${name} history reset is already in progress.`);
    error.statusCode = 409;
    throw error;
  }

  historyResetInFlight.add(name);
  try {
    // First remove durable references, then clear the local series. Any live
    // packets arriving while deletion is pending are not persisted, so an older
    // reference cannot reappear after the user establishes a new baseline.
    await historyStore.reset(name);
    history[name].length = 0;
    chartHistory[name].length = 0;

    // The reset baseline is an actual Dhan snapshot already held by this
    // process. It never manufactures zero OI or zero underlying values. The
    // marker is retained in Postgres so all cards remain immediately usable
    // after a restart until their exact lookback intervals have elapsed.
    recordSnapshot(name, { ...summary, resetBaseline: true, baselineReason: 'reset-real-market-snapshot' }, Date.now(), { restState: restState[name], persist: false, allowDuringReset: true });
    const baseline = history[name][history[name].length - 1];
    await historyStore.save(name, baseline);
    return latest[name];
  } finally {
    historyResetInFlight.delete(name);
  }
}

function pollLoop() {
  // Production logs showed simultaneous NIFTY/SENSEX Option Chain calls
  // receiving 429 responses. Treat the Dhan limit as global for this account:
  // one entire snapshot request starts at least every 3.1s, never in parallel.
  const scheduler = new SerializedPollScheduler({
    symbols: config.symbols,
    minimumIntervalMs: config.pollIntervalMs,
    run: pollSymbol,
  });
  scheduler.start();
}

// ---- HTTP layer ----
const app = express();
app.use(cors({ origin: config.allowedOrigin }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

app.get('/api/config', (_req, res) => {
  res.json({
    dataSource: config.dataSource,
    dataSourceLabel: source.label,
    symbols: config.symbols.map((s) => s.name),
    strikesEachSide: config.strikesEachSide,
    chart: {
      samplingMode: config.liveFeedEnabled ? 'event-driven' : 'snapshot',
      eventBucketMs: config.liveFeedEnabled ? config.liveFeedEventBucketMs : config.pollIntervalMs,
      fallbackIntervalMs: config.pollIntervalMs,
      retentionMs: config.chartHistoryMaxMs,
    },
    historyStorage: historyStore.getStatus(),
    paperTrading: paperTrading.snapshot(),
    liveFeed: { enabled: config.liveFeedEnabled, ...liveFeedStatus },
    thresholds: config.thresholds,
    notificationsEnabled,
  });
});

app.get('/api/oi/:symbol', (req, res) => {
  const name = req.params.symbol.toUpperCase();
  if (!latest[name]) return res.status(404).json({ error: 'unknown symbol' });
  res.json(latest[name]);
});

app.get('/api/paper-trades', (_req, res) => {
  res.json(paperTrading.snapshot());
});

// Full retained history is requested once after connection or a symbol change.
// SSE subsequently sends only the latest compact point rather than re-sending
// up to ten hours of chart data every push interval.
app.get('/api/chart/:symbol', (req, res) => {
  const name = req.params.symbol.toUpperCase();
  if (!chartHistory[name]) return res.status(404).json({ error: 'unknown symbol' });
  const requestedFrom = Number(req.query.from);
  const points = Number.isFinite(requestedFrom)
    ? chartHistory[name].filter((point) => point.t >= requestedFrom)
    : chartHistory[name];
  res.json({
    symbol: name,
    samplingMode: config.liveFeedEnabled ? 'event-driven' : 'snapshot',
    eventBucketMs: config.liveFeedEnabled ? config.liveFeedEventBucketMs : config.pollIntervalMs,
    fallbackIntervalMs: config.pollIntervalMs,
    retentionMs: config.chartHistoryMaxMs,
    points,
  });
});

// Reset one symbol only. This re-baselines retained application data and never
// triggers a Dhan request or changes the global serialized poll scheduler.
app.post('/api/history/:symbol/reset', async (req, res) => {
  const name = req.params.symbol.toUpperCase();
  if (!history[name]) return res.status(404).json({ error: 'unknown symbol' });
  try {
    const payload = await resetSymbolHistory(name);
    res.json({ ok: true, symbol: name, payload });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'history reset failed' });
  }
});

app.get('/api/vapid-public-key', (_req, res) => {
  res.json({ publicKey: notificationsEnabled ? secrets.vapidPublicKey : null });
});

app.post('/api/subscribe', (req, res) => {
  if (!notificationsEnabled) return res.status(503).json({ error: 'notifications not configured on server' });
  addSubscription(req.body);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  removeSubscription(req.body.endpoint);
  res.json({ ok: true });
});

// Server-Sent Events: pushes every symbol's latest payload whenever it updates.
const sseClients = new Set();
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify(latest)}\n\n`);
  res.write(`event: paper-trades\ndata: ${JSON.stringify(paperTrading.snapshot())}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

function broadcast() {
  const payload = JSON.stringify(latest);
  for (const client of sseClients) client.write(`data: ${payload}\n\n`);
}

function broadcastPaperTrades() {
  const payload = JSON.stringify(paperTrading.snapshot());
  for (const client of sseClients) client.write(`event: paper-trades\ndata: ${payload}\n\n`);
}
setInterval(broadcast, config.ssePushIntervalMs);

// ---- Keep-alive self-ping (Render's free tier spins a service down after
// ~15 min with no inbound HTTP traffic). While the process is already
// running, pinging our own public health endpoint periodically counts as
// inbound traffic and stops it from ever going idle. RENDER_EXTERNAL_URL is
// set automatically by Render, so this is a no-op anywhere else (local dev,
// other hosts). This can't wake the service from an *already-cold* sleep —
// pair it with an external uptime pinger (UptimeRobot, cron-job.org, a
// scheduled GitHub Action) for that, or move to a paid Render plan, which
// disables spin-down entirely.
const selfUrl = process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || null;
const selfPingDisabled = process.env.DISABLE_SELF_PING === 'true';
if (selfUrl && !selfPingDisabled) {
  const KEEPALIVE_MS = 60 * 1000; // comfortably under the 15 min idle timeout
  const selfPing = () => {
    fetch(`${selfUrl.replace(/\/$/, '')}/api/health`).catch((err) => {
      console.error('[keepalive] self-ping failed:', err.message);
    });
  };
  selfPing();
  setInterval(selfPing, KEEPALIVE_MS);
}

async function restoreHistory() {
  const restored = await historyStore.load(config.symbols.map((sym) => sym.name));
  for (const [name, snapshots] of Object.entries(restored)) {
    if (!snapshots.length) continue;
    history[name].push(...snapshots);
    // Restored values remain visibly connecting until the new process receives
    // a current Dhan snapshot. Their window references are valid; their status
    // deliberately never claims that an old quote is currently live.
    updatePayload(name, chartHistory[name][chartHistory[name].length - 1]);
  }
  const count = Object.values(restored).reduce((total, snapshots) => total + snapshots.length, 0);
  console.log(`Durable OI history: ${historyStore.getStatus().status} (${count} snapshots restored)`);
}

async function restorePaperTrades() {
  const state = await paperTrading.restore();
  console.log(`Paper simulator: ${state.enabled ? 'enabled with durable Postgres records' : 'disabled (configure OI_HISTORY_DATABASE_URL for durable records)'}`);
}

async function start() {
  await historyStore.initialize();
  await restoreHistory();
  await restorePaperTrades();
  app.listen(config.port, () => {
    console.log(`OI Pulse backend listening on :${config.port}`);
    console.log(`Data source: ${source.label}`);
    console.log(`Symbols: ${config.symbols.map((s) => s.name).join(', ')}`);
    console.log(`Push notifications: ${notificationsEnabled ? 'enabled' : 'disabled (set VAPID keys in .env)'}`);
    console.log(`Dhan live feed: ${config.liveFeedEnabled ? 'enabled (active ATM-band Full Packet stream)' : 'disabled (REST Option Chain only)'}`);
    console.log(`Durable OI history: ${config.historyDatabaseUrl ? 'Postgres configured' : 'memory only (set OI_HISTORY_DATABASE_URL)'}`);
    console.log(`Paper simulator: ${config.paperTrading.enabled ? 'paper-only; no broker/order integration' : 'disabled in config'}`);
    console.log(`Self-ping keepalive: ${selfUrl && !selfPingDisabled ? `enabled (${selfUrl})` : 'disabled (set SELF_PING_URL or use Render)'}`);
    pollLoop();
  });
}

async function shutdown(signal) {
  console.log(`${signal} received; flushing durable OI history`);
  await historyStore.close();
  await paperTradeStore.close();
  process.exit(0);
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

start().catch((err) => {
  console.error('OI Pulse startup failed:', err);
  process.exit(1);
});
