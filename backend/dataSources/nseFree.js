// NSE India's public option-chain feed. This is the same JSON endpoint
// nseindia.com's own website calls — free, no signup — but it's
// undocumented and unofficial: NSE can change or block it without notice,
// and it only covers NSE-listed underlyings (so NIFTY/BANKNIFTY, not
// SENSEX — that's BSE). Treat this as a temporary stand-in until you have
// Dhan credentials, not a long-term production source.
//
// It requires a same-session cookie (the site rejects bare requests), so
// we "visit" the homepage first to collect cookies, then reuse them.
// Symbol config shape: { name, nse: { symbol } } e.g. { symbol: "NIFTY" }

const BASE = 'https://www.nseindia.com';
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: `${BASE}/option-chain`,
};

let cookieJar = '';
let cookieFetchedAt = 0;
const COOKIE_TTL_MS = 4 * 60 * 1000; // refresh every 4 min, before NSE expires the session

function collectSetCookies(res) {
  // Node's fetch Headers collapses repeated set-cookie into one string via
  // .get(), but keeps separate entries when iterated — use that to get all of them.
  const cookies = [];
  for (const [key, value] of res.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') cookies.push(value.split(';')[0]);
  }
  return cookies.join('; ');
}

async function refreshCookies() {
  const res = await fetch(`${BASE}/option-chain`, { headers: BROWSER_HEADERS });
  const fresh = collectSetCookies(res);
  if (fresh) {
    cookieJar = fresh;
    cookieFetchedAt = Date.now();
  } else if (!cookieJar) {
    throw new Error('NSE session bootstrap returned no cookies — the site may be blocking this request');
  }
}

async function withSession(fn) {
  if (!cookieJar || Date.now() - cookieFetchedAt > COOKIE_TTL_MS) await refreshCookies();
  const res = await fn();
  if (res.status === 401 || res.status === 403) {
    // session likely expired — refresh once and retry
    await refreshCookies();
    return fn();
  }
  return res;
}

export async function fetchSnapshot(sym) {
  const url = `${BASE}/api/option-chain-indices?symbol=${encodeURIComponent(sym.nse.symbol)}`;
  const res = await withSession(() => fetch(url, { headers: { ...BROWSER_HEADERS, Cookie: cookieJar } }));
  if (!res.ok) throw new Error(`nse option-chain ${sym.name}: ${res.status} ${await res.text()}`);
  const raw = await res.json();

  const records = raw?.records;
  if (!records) throw new Error(`nse option-chain ${sym.name}: unexpected response shape`);
  const nearestExpiry = records.expiryDates?.[0];

  const strikes = {};
  for (const row of records.data || []) {
    if (nearestExpiry && row.expiryDate !== nearestExpiry) continue; // records.data mixes all expiries
    strikes[row.strikePrice] = {
      ce: row.CE?.openInterest ?? 0,
      pe: row.PE?.openInterest ?? 0,
    };
  }
  return { underlyingPrice: records.underlyingValue ?? null, strikes };
}

export const label = 'NSE India (free, unofficial)';
