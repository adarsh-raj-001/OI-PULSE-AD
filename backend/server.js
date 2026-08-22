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

const source = config.dataSource === 'dhan' ? dhanSource : nseFreeSource;

// symbol -> array of { t, underlyingPrice, strikes: { [strike]: {ce, pe} } }
const history = Object.fromEntries(config.symbols.map((s) => [s.name, []]));

// symbol -> latest computed payload sent to clients
const latest = Object.fromEntries(config.symbols.map((s) => [s.name, null]));


// Finds the strike step from the actual chain (min gap between consecutive
// strikes) rather than hardcoding it — NSE/BSE revise strike intervals
// from time to time, this stays correct regardless.
function strikeStep(strikes) {
  const sorted = Object.keys(strikes).map(Number).sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < sorted.length; i++) min = Math.min(min, sorted[i] - sorted[i - 1]);
  return Number.isFinite(min) ? min : null;
}

function nearestStrike(strikes, price) {
  let best = null, bestDiff = Infinity;
  for (const s of Object.keys(strikes).map(Number)) {
    const diff = Math.abs(s - price);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

// Builds the ATM +/- N strike band for the *current* snapshot, then diffs
// each of those strikes against the reference snapshot for a given window.
function bandDelta(hist, nowMs, windowMs) {
  if (hist.length < 2) return null;
  const cur = hist[hist.length - 1];
  const step = strikeStep(cur.strikes);
  const atm = nearestStrike(cur.strikes, cur.underlyingPrice);
  if (step === null || atm === null) return null;

  const targetT = nowMs - windowMs;
  let ref = hist[0];
  for (const snap of hist) {
    if (snap.t <= targetT) ref = snap;
    else break;
  }
  if (ref.t === cur.t) return null; // not enough history yet for this window

  const band = [];
  let bandDeltaTotal = 0;
  for (let i = -config.strikesEachSide; i <= config.strikesEachSide; i++) {
    const strike = atm + i * step;
    const curLeg = cur.strikes[strike];
    const refLeg = ref.strikes[strike];
    if (!curLeg) continue; // strike went out of chain range, skip
    const prevLeg = refLeg || { ce: 0, pe: 0 };
    const dCe = curLeg.ce - prevLeg.ce;
    const dPe = curLeg.pe - prevLeg.pe;
    const dTotal = dCe + dPe;
    bandDeltaTotal += dTotal;
    band.push({ strike, isATM: i === 0, offset: i, dCe, dPe, dTotal });
  }

  return {
    fromT: ref.t,
    toT: cur.t,
    actualSpanMs: cur.t - ref.t,
    atmStrike: atm,
    strikeStep: step,
    band,
    bandDeltaTotal,
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

async function pollSymbol(sym) {
  try {
    const summary = await source.fetchSnapshot(sym);
    const t = Date.now();
    const hist = history[sym.name];
    hist.push({ t, ...summary });
    const cutoff = t - config.historyMaxMs;
    while (hist.length && hist[0].t < cutoff) hist.shift();

    const payload = computePayload(sym.name);
    payload.status = 'live';
    latest[sym.name] = payload;

    checkThresholds(sym.name, payload.windows);
  } catch (err) {
    console.error(`[poll:${sym.name}]`, err.message);
    if (latest[sym.name]) latest[sym.name].status = 'stale';
    else latest[sym.name] = { symbol: sym.name, status: 'error', error: err.message };
  }
}

function pollLoop() {
  // Dhan: each underlying is its own rate-limit bucket (1 req/3s per
  // instrument+expiry), safe to poll in parallel. NSE free source: polled
  // less aggressively (see config.json) to avoid tripping its informal
  // rate limiting, also fine in parallel since it's two separate requests.
  setInterval(() => {
    for (const sym of config.symbols) pollSymbol(sym);
  }, config.pollIntervalMs);
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
    thresholds: config.thresholds,
    notificationsEnabled,
  });
});

app.get('/api/oi/:symbol', (req, res) => {
  const name = req.params.symbol.toUpperCase();
  if (!latest[name]) return res.status(404).json({ error: 'unknown symbol' });
  res.json(latest[name]);
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
const selfUrl = process.env.RENDER_EXTERNAL_URL || 'https://oi-pulse-backend-60u1.onrender.com';
if (selfUrl) {
  const KEEPALIVE_MS = 60 * 1000; // comfortably under the 15 min idle timeout
  setInterval(() => {
    fetch(`${selfUrl.replace(/\/$/, '')}/api/health`).catch((err) => {
      console.error('[keepalive] self-ping failed:', err.message);
    });
  }, KEEPALIVE_MS);
}

app.listen(config.port, () => {
  console.log(`OI Pulse backend listening on :${config.port}`);
  console.log(`Data source: ${source.label}`);
  console.log(`Symbols: ${config.symbols.map((s) => s.name).join(', ')}`);
  console.log(`Push notifications: ${notificationsEnabled ? 'enabled' : 'disabled (set VAPID keys in .env)'}`);
  console.log(`Self-ping keepalive: ${selfUrl ? `enabled (${selfUrl})` : 'disabled (not running on Render)'}`);
  pollLoop();
});
