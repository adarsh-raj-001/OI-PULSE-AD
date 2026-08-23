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
import { buildMarketStrength } from './marketStrength.js';
import { appendChartPoint, buildChartPoint } from './chartHistory.js';
import { DhanLiveFeed } from './dhanLiveFeed.js';
import { SerializedPollScheduler } from './pollScheduler.js';
import { isLiveFeedFresh, resolveDashboardStatus } from './liveStatus.js';

const source = config.dataSource === 'dhan' ? dhanSource : nseFreeSource;

// symbol -> array of { t, underlyingPrice, strikes: { [strike]: {ce, pe} } }
const history = Object.fromEntries(config.symbols.map((s) => [s.name, []]));

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


function sortedStrikes(strikes) {
  return Object.keys(strikes)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function nearestStrikeIndex(strikes, price) {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || !strikes.length) return null;

  let bestIndex = 0;
  let bestDiff = Math.abs(strikes[0] - numericPrice);
  for (let i = 1; i < strikes.length; i++) {
    const diff = Math.abs(strikes[i] - numericPrice);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function bandStep(strikes) {
  const steps = [];
  for (let i = 1; i < strikes.length; i++) steps.push(strikes[i] - strikes[i - 1]);
  return steps.length && steps.every((step) => step === steps[0]) ? steps[0] : null;
}

function legOi(leg) {
  const value = typeof leg === 'object' && leg !== null ? leg.oi : leg;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

// Builds the ATM +/- N strike band for the *current* snapshot, then diffs
// each of those strikes against the reference snapshot for a given window.
function bandDelta(hist, nowMs, windowMs) {
  if (hist.length < 2) return null;
  const cur = hist[hist.length - 1];
  const allStrikes = sortedStrikes(cur.strikes);
  const atmIndex = nearestStrikeIndex(allStrikes, cur.underlyingPrice);
  if (atmIndex === null) return null;
  const atm = allStrikes[atmIndex];
  const targetT = nowMs - windowMs;
  if (hist[0].t > targetT) return null; // do not label a shorter warm-up span as this window

  let ref = hist[0];
  for (const snap of hist) {
    if (snap.t <= targetT) ref = snap;
    else break;
  }
  if (ref.t === cur.t) return null; // not enough history yet for this window

  const band = [];
  let bandDeltaCe = 0;
  let bandDeltaPe = 0;
  let bandDeltaTotal = 0;
  for (let i = -config.strikesEachSide; i <= config.strikesEachSide; i++) {
    const strikeIndex = atmIndex + i;
    if (strikeIndex < 0 || strikeIndex >= allStrikes.length) continue;
    const strike = allStrikes[strikeIndex];
    const curLeg = cur.strikes[strike];
    const refLeg = ref.strikes[strike];
    if (!curLeg || !refLeg) continue; // skip a strike that was not present in both snapshots
    const prevLeg = refLeg;
    const dCe = legOi(curLeg.ce) - legOi(prevLeg.ce);
    const dPe = legOi(curLeg.pe) - legOi(prevLeg.pe);
    const dTotal = dCe + dPe;
    bandDeltaCe += dCe;
    bandDeltaPe += dPe;
    bandDeltaTotal += dTotal;
    band.push({ strike, isATM: i === 0, offset: i, dCe, dPe, dTotal });
  }

  return {
    fromT: ref.t,
    toT: cur.t,
    actualSpanMs: cur.t - ref.t,
    atmStrike: atm,
    strikeStep: bandStep(allStrikes),
    band,
    bandDeltaCe,
    bandDeltaPe,
    bandDeltaTotal,
    marketStrength: buildMarketStrength({ cur, ref, band, actualSpanMs: cur.t - ref.t }),
  };
}

function computePayload(name) {
  const hist = history[name];
  if (!hist.length) return null;
  const cur = hist[hist.length - 1];
  return {
    symbol: name,
    updatedAt: cur.t,
    underlyingPrice: cur.underlyingPrice,
    windows: {
      m5: bandDelta(hist, cur.t, 5 * 60 * 1000),
      m30: bandDelta(hist, cur.t, 30 * 60 * 1000),
      h3: bandDelta(hist, cur.t, 3 * 60 * 60 * 1000),
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

function recordSnapshot(name, summary, t, { eventDriven = false, restState: nextRestState = null } = {}) {
  const hist = history[name];
  const previous = hist[hist.length - 1] || null;
  const shouldReplace = eventDriven && previous && t - previous.t < config.liveFeedEventBucketMs;
  const snapshot = { t: shouldReplace ? previous.t : t, ...cloneSummary(summary) };

  if (shouldReplace) hist[hist.length - 1] = snapshot;
  else hist.push(snapshot);
  const cutoff = t - config.historyMaxMs;
  while (hist.length && hist[0].t < cutoff) hist.shift();

  const points = chartHistory[name];
  const replacingChartBucket = eventDriven && points.length > 0 && t - points[points.length - 1].t < config.liveFeedEventBucketMs;
  const previousChartPoint = replacingChartBucket ? points[points.length - 2] || null : points[points.length - 1] || null;
  const chartPoint = buildChartPoint(snapshot, previousChartPoint, config.strikesEachSide);
  appendChartPoint(points, chartPoint, t - config.chartHistoryMaxMs, eventDriven ? config.liveFeedEventBucketMs : 0);
  updatePayload(name, chartPoint, nextRestState);
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
  for (const sym of config.symbols) {
    const summary = liveState[sym.name];
    if (!summary || !sym.dhan) continue;
    for (const instrument of activeBandSubscriptions(sym, summary)) {
      const key = `${instrument.exchangeSegment}:${instrument.securityId}`;
      liveInstrumentRefs.set(key, instrument);
      subscriptions.push(instrument);
    }
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
      recordSnapshot(sym.name, liveState[sym.name], t, { restState: 'live' });
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
  req.on('close', () => sseClients.delete(res));
});

function broadcast() {
  const payload = JSON.stringify(latest);
  for (const client of sseClients) client.write(`data: ${payload}\n\n`);
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

app.listen(config.port, () => {
  console.log(`OI Pulse backend listening on :${config.port}`);
  console.log(`Data source: ${source.label}`);
  console.log(`Symbols: ${config.symbols.map((s) => s.name).join(', ')}`);
  console.log(`Push notifications: ${notificationsEnabled ? 'enabled' : 'disabled (set VAPID keys in .env)'}`);
  console.log(`Dhan live feed: ${config.liveFeedEnabled ? 'enabled (active ATM-band Full Packet stream)' : 'disabled (REST Option Chain only)'}`);
  console.log(`Self-ping keepalive: ${selfUrl && !selfPingDisabled ? `enabled (${selfUrl})` : 'disabled (set SELF_PING_URL or use Render)'}`);
  pollLoop();
});
