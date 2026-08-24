// Single place that assembles config: tunables from config.json,
// secrets from .env. Nothing else in the app should read process.env
// or config.json directly — import from here instead.

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env from this file's own folder (backend/), not from wherever
// the process happens to be started — so `npm start` works the same
// whether run from backend/ or from the project root.
dotenv.config({ path: path.join(__dirname, '.env') });

const tunables = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const dataSource = tunables.dataSource;

export const secrets = {
  // Only required when actually using the Dhan source — the free NSE
  // source needs no credentials at all.
  dhanClientId: dataSource === 'dhan' ? required('DHAN_CLIENT_ID') : process.env.DHAN_CLIENT_ID || null,
  // Two ways to authenticate with Dhan:
  // 1. TOTP auto-refresh (recommended) — set DHAN_PIN + DHAN_TOTP_SECRET,
  //    the backend generates its own fresh 24h token automatically, forever.
  // 2. Static token (manual) — set DHAN_ACCESS_TOKEN, but you must
  //    regenerate and redeploy it by hand every ~24 hours.
  dhanAccessToken: process.env.DHAN_ACCESS_TOKEN || null,
  dhanPin: process.env.DHAN_PIN || null,
  dhanTotpSecret: process.env.DHAN_TOTP_SECRET || null,
  // VAPID keys power push notifications. Optional — notifications just
  // stay disabled until both are set. Generate with: npx web-push generate-vapid-keys
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || null,
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
};

if (dataSource === 'dhan' && !secrets.dhanAccessToken && !(secrets.dhanPin && secrets.dhanTotpSecret)) {
  console.error(
    'Dhan source needs either DHAN_ACCESS_TOKEN, or DHAN_PIN + DHAN_TOTP_SECRET for auto-refresh. Set one in .env.'
  );
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT) || 8787,
  allowedOrigin: process.env.ALLOWED_ORIGIN || '*',

  dataSource,
  symbols: tunables.symbolsBySource[dataSource],
  strikesEachSide: tunables.strikesEachSide,
  pollIntervalMs: tunables.pollIntervalMs,
  optionChainRateLimitBackoffMs: Number(tunables.optionChainRateLimitBackoffMs) || 15_000,
  liveFeedFreshnessMs: Number(tunables.liveFeedFreshnessMs) || 15_000,
  ssePushIntervalMs: tunables.ssePushIntervalMs,
  historyMaxMs: tunables.historyMaxMs,
  historyPersistIntervalMs: Number(tunables.historyPersistIntervalMs) || 5_000,
  // Prefer this explicit name so an unrelated DATABASE_URL cannot silently
  // become the market-history store. DATABASE_URL remains a documented
  // convenience for Render Blueprint users who intentionally provide it.
  historyDatabaseUrl: process.env.OI_HISTORY_DATABASE_URL || process.env.DATABASE_URL || null,
  chartHistoryMaxMs: tunables.chartHistoryMaxMs,
  liveFeedEnabled: dataSource === 'dhan' && tunables.liveFeedEnabled === true && process.env.DISABLE_DHAN_LIVE_FEED !== 'true',
  liveFeedEventBucketMs: Number(tunables.liveFeedEventBucketMs) || 1000,
  thresholds: tunables.thresholds,
  notifyCooldownMs: tunables.notifyCooldownMs,
  paperTrading: {
    enabled: tunables.paperTrading?.enabled === true,
    lots: Number(tunables.paperTrading?.lots) || 10,
    symbolEnabled: tunables.paperTrading?.symbolEnabled || { NIFTY: true, SENSEX: true },
    marketHoursEnabled: tunables.paperTrading?.marketHoursEnabled !== false,
    sessionResetEnabled: tunables.paperTrading?.sessionResetEnabled !== false,
    marketSession: tunables.paperTrading?.marketSession || { timeZone: 'Asia/Kolkata', opensAt: '09:15', closesAt: '15:30' },
    contractLotSizes: tunables.paperTrading?.contractLotSizes || { NIFTY: 65, SENSEX: 20 },
    strengthThreshold: Number(tunables.paperTrading?.strengthThreshold) || 60,
    entryPremiumOffset: Number(tunables.paperTrading?.entryPremiumOffset) || 0,
    targetPoints: Number(tunables.paperTrading?.targetPoints) || 2,
    stopLossPoints: Number(tunables.paperTrading?.stopLossPoints) || 5,
    maxAliveSeconds: Math.max(0, Number(tunables.paperTrading?.maxAliveSeconds) || 0),
    cooldownSeconds: Math.max(0, Number(tunables.paperTrading?.cooldownSeconds) || 0),
  },
};

export const notificationsEnabled = !!(secrets.vapidPublicKey && secrets.vapidPrivateKey);
