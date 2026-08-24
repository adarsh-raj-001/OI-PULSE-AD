// Dhan option chain source. Two auth modes — see config.js for details:
// TOTP auto-refresh (DHAN_PIN + DHAN_TOTP_SECRET) or a static
// DHAN_ACCESS_TOKEN you regenerate by hand every ~24h.
// Symbol config shape: { name, dhan: { securityId, segment } }

import { authenticator } from 'otplib';
import { config, secrets } from '../config.js';
import { normalizeLeg } from './dhanNormalization.js';

const DHAN_BASE = 'https://api.dhan.co/v2';
const AUTH_URL = 'https://auth.dhan.co/app/generateAccessToken';

const usingTotp = !!(secrets.dhanPin && secrets.dhanTotpSecret);
// In-memory token cache — refreshed proactively before expiry, or
// immediately on a 401 from Dhan.
let cachedToken = secrets.dhanAccessToken || null;
let tokenExpiresAt = 0; // epoch ms; 0 means "unknown / refresh on first use"
let lastRefreshAttemptAt = 0;
const MIN_REFRESH_INTERVAL_MS = 90 * 1000; // Dhan allows a new token once per ~2 min; stay safely under that
const REQUEST_TIMEOUT_MS = 15_000;

function dhanError(message, response) {
  const error = new Error(message);
  error.status = response?.status;
  if (response?.status === 429) error.retryAfterMs = config.optionChainRateLimitBackoffMs;
  return error;
}

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function refreshTokenViaTotp() {
  const now = Date.now();
  if (now - lastRefreshAttemptAt < MIN_REFRESH_INTERVAL_MS) {
    // Don't hammer Dhan's auth endpoint — reuse whatever we have, even if stale,
    // rather than risk a rate-limit block. The next poll cycle will retry once
    // the cooldown has passed.
    if (cachedToken) return;
    throw new Error(
      `TOTP refresh on cooldown (${Math.round((MIN_REFRESH_INTERVAL_MS - (now - lastRefreshAttemptAt)) / 1000)}s left) and no cached token yet`
    );
  }
  lastRefreshAttemptAt = now;

  const totp = authenticator.generate(secrets.dhanTotpSecret);
  const url = `${AUTH_URL}?dhanClientId=${encodeURIComponent(secrets.dhanClientId)}&pin=${encodeURIComponent(secrets.dhanPin)}&totp=${totp}`;
  const res = await fetchWithTimeout(url, { method: 'POST' });
  if (!res.ok) throw new Error(`TOTP token refresh: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.accessToken) {
    throw new Error(`TOTP token refresh: no accessToken in response. Raw response: ${JSON.stringify(data)}`);
  }
  cachedToken = data.accessToken;
  // Refresh 30 minutes before Dhan's stated expiry, not exactly at it.
  tokenExpiresAt = data.expiryTime ? new Date(data.expiryTime).getTime() - 30 * 60 * 1000 : Date.now() + 23 * 60 * 60 * 1000;
  console.log(`Dhan access token refreshed via TOTP, valid until ${data.expiryTime || '(unknown)'}`);
}

async function getAccessToken(forceRefresh = false) {
  if (!usingTotp) return secrets.dhanAccessToken; // static mode — never auto-refreshes
  if (forceRefresh || !cachedToken || Date.now() >= tokenExpiresAt) await refreshTokenViaTotp();
  return cachedToken;
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'access-token': token,
    'client-id': secrets.dhanClientId,
  };
}

const expiryCache = {};

async function fetchExpiry(sym, token) {
  const res = await fetchWithTimeout(`${DHAN_BASE}/optionchain/expirylist`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ UnderlyingScrip: sym.dhan.securityId, UnderlyingSeg: sym.dhan.segment }),
  });
  if (!res.ok) throw dhanError(`expirylist ${sym.name}: ${res.status} ${await res.text()}`, res);
  const data = await res.json();
  const dates = data?.data || [];
  if (!dates.length) throw new Error(`no expiries returned for ${sym.name}`);

  // Dhan normally returns active expiries in ascending order. Filter out any
  // stale values defensively so an old first entry cannot pin the cache.
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const nearest = dates.map(String).find((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today);
  return nearest || String(dates[0]);
}

async function fetchOptionChainOnce(sym, token) {
  if (!expiryCache[sym.name]) expiryCache[sym.name] = await fetchExpiry(sym, token);

  const res = await fetchWithTimeout(`${DHAN_BASE}/optionchain`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      UnderlyingScrip: sym.dhan.securityId,
      UnderlyingSeg: sym.dhan.segment,
      Expiry: expiryCache[sym.name],
    }),
  });
  return res;
}

export async function fetchSnapshot(sym) {
  let token = await getAccessToken();
  let res = await fetchOptionChainOnce(sym, token);

  // On a 401, refresh the token for the next serialized poll. Do not issue an
  // immediate second Option Chain request that could violate Dhan's cadence.
  if (res.status === 401 && usingTotp) {
    await getAccessToken(true);
    expiryCache[sym.name] = null;
    throw dhanError(`optionchain ${sym.name}: 401 token refreshed; retrying on the next scheduled poll`, res);
  }

  if (!res.ok) {
    if (res.status === 400 || res.status === 404) expiryCache[sym.name] = null; // expiry may have rolled
    throw dhanError(`optionchain ${sym.name}: ${res.status} ${await res.text()}`, res);
  }
  const raw = await res.json();

  const lastPrice = Number(raw?.data?.last_price);
  const oc = raw?.data?.oc;
  if (!Number.isFinite(lastPrice)) {
    throw new Error(`optionchain ${sym.name}: response has no valid underlying price`);
  }
  if (!oc || typeof oc !== 'object') {
    throw new Error(`optionchain ${sym.name}: response has no option-chain data`);
  }

  const strikes = {};
  for (const [strikeStr, legs] of Object.entries(oc)) {
    const strike = Number(strikeStr);
    if (!Number.isFinite(strike)) continue;
    strikes[strike] = {
      ce: normalizeLeg(legs?.ce),
      pe: normalizeLeg(legs?.pe),
    };
  }
  if (!Object.keys(strikes).length) {
    throw new Error(`optionchain ${sym.name}: response contains no valid strikes`);
  }
  return { underlyingPrice: lastPrice, strikes, expiry: expiryCache[sym.name] };
}

// Reuses the same cached, TOTP-capable Dhan token path as the REST Option
// Chain adapter. The WebSocket client imports this rather than owning a second
// refresh mechanism, so a reconnect cannot expose a stale browser-side token.
export async function getLiveFeedCredentials(forceRefresh = false) {
  return {
    clientId: secrets.dhanClientId,
    accessToken: await getAccessToken(forceRefresh),
  };
}

export const label = usingTotp ? 'Dhan (official, TOTP auto-refresh)' : 'Dhan (official, static token)';
