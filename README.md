# OI Pulse

Live NIFTY / SENSEX open-interest tracker: OI change at the at-the-money
(ATM) strike plus 3 strikes above and 3 strikes below, for 5 min / 30 min /
3 hour windows — with push notifications when a window's change crosses
your threshold.

- **backend/** — Node server holding your Dhan credentials, polling the
  option chain, and streaming computed OI deltas over Server-Sent Events.
- **frontend/** — a static web app (`index.html` + `sw.js`). Open it in
  Safari on your iPhone and "Add to Home Screen" for a full-screen app icon.

Runs in **demo mode** (simulated data) until you point it at a live
backend, so you can preview the UI immediately.

## What the app displays

When the backend is connected to Dhan, the app shows **5-minute, 30-minute,
and 3-hour** open-interest changes for the current ATM strike and the three
strikes above and below it. Each strike shows separate **Call OI (CE)**,
**Put OI (PE)**, and **Total** changes. Each time-window card also shows the
aggregate call, put, and total change across the full ATM ±3 band.

The windows are calculated from snapshots collected by the backend, not from
Dhan's `previous_oi` field. The 5-minute card becomes available after at least
5 minutes of history, the 30-minute card after at least 30 minutes, and the
3-hour card after at least 3 hours. This prevents a short warm-up interval
from being mislabeled as a full time window.

## Market strength panel

Each available window now includes a **market-strength bar**. It is a compact
summary of the data currently available across the same ATM ±3 strike band;
it is not a signal to buy, sell, or hold. The panel always states the selected
window and a data-confidence percentage so a 5-minute read is not confused
with a 3-hour read.

| Input | Calculation | How it is used |
|---|---|---|
| Underlying movement | Underlying `last_price` change from the beginning of the exact window, shown in basis points. | Directional component. |
| Option premium movement | Volume-weighted CE `last_price` change versus volume-weighted PE `last_price` change. | Directional component. |
| Best quote imbalance | Depth-weighted `(top_bid_quantity - top_ask_quantity) / (top_bid_quantity + top_ask_quantity)` for CE and PE. | Directional component when valid quotes are present. |
| Window OI and session OI | Exact-window CE/PE OI changes from OI Pulse snapshots, plus Dhan's current-vs-previous-day OI change. | Activity context; not treated as direction by itself. |
| Current OI PCR and volume PCR | Put totals divided by Call totals across the tracked band. | Positioning and participation context. |
| Liquidity and IV | Best bid/ask spreads, quote coverage, and OI-weighted implied volatility. | Quality/context indicators. |

The direction score is a confidence-weighted blend of underlying return (45%),
relative Call-versus-Put premium movement (35%), and the difference between
Call and Put best-quote imbalance (20%). If quote or premium fields are absent,
the unavailable component is removed and the confidence score falls. A label
such as **Strong upward pressure**, **Mild downward pressure**, or
**Balanced / mixed** describes only the current inputs; it is not a prediction.

> **Important:** OI cannot identify whether a position was opened long or
> short without trade classification and order-flow context. A Call/Put OI
> activity imbalance, PCR, premium move, or top-of-book imbalance can change
> rapidly and should not be used alone to infer future market direction.

The expanded aggregate panel includes direct **Call/Put volume**, **top bid and
ask quantities**, **bid-minus-ask quantity difference**, **depth-weighted bid
and ask prices**, and the bid-ask spread. These values are summarized across
the tracked ATM ±3 strike band and should be read with quote coverage and
spread: a low-coverage or wide-spread book is less informative.

The repository contains two synchronized static frontend copies:

- `frontend/` is the source copy for Netlify, Vercel, or another static host.
- `docs/` is the GitHub Pages-ready copy. Keep both copies synchronized when
  changing the client.

## Files, and what's a secret vs. a setting

| File | Contains |
|---|---|
| `backend/.env` | **Secrets**: Dhan client ID/token, VAPID push keys. Never commit this. |
| `backend/config.json` | **Tunables**: symbols tracked, strikes-each-side, poll interval, notification thresholds, cooldown. Safe to commit. |
| `backend/config.js` | Loads both of the above — nothing else in the app reads `.env` or `config.json` directly. |

To change how sensitive the alerts are, or add/remove symbols, edit
`config.json` — no code changes needed.

## 1. Get your Dhan credentials

Dhan's Option Chain endpoint is a **Data API**. Confirm that your Dhan account
has an active Data API subscription before deployment; Dhan documents this
requirement in its [authentication guide](https://dhanhq.co/docs/v2/authentication/).
The project uses Dhan's official `POST /v2/optionchain` and
`POST /v2/optionchain/expirylist` endpoints, whose response includes
strike-wise CE/PE `oi` values and the underlying `last_price`. Dhan also
documents CE/PE `last_price`, `volume`, `implied_volatility`, `previous_oi`,
and top bid/ask prices and quantities, which power the market-strength
aggregates; see the [official Option Chain documentation](https://dhanhq.co/docs/v2/option-chain/).

1. Log into `web.dhan.co` → **My Profile → DhanHQ Trading APIs**.
2. Copy your **Client ID**.
3. Choose an auth mode (see `.env.example` for exact field names):
   - **Recommended: TOTP auto-refresh.** Enable TOTP under **Optional Settings → Set-up TOTP**, save the secret key it shows you (not just the QR code). Put your Client ID, 6-digit PIN, and that TOTP secret in `.env`. The backend then generates its own fresh 24-hour token automatically, forever — no manual steps, no expiry surprises.
   - **Simpler but manual: static token.** Generate an Access Token from the same page and paste it into `.env`. Works fine, but expires in ~24h and you have to regenerate + redeploy by hand each time it does.

## 2. (Optional) Enable push notifications

1. Run `npx web-push generate-vapid-keys` (needs Node, no install required
   beyond npx) — it prints a public and private key.
2. Paste them into `.env` as `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, and
   set `VAPID_SUBJECT` to `mailto:youremail@example.com`.
3. Leave both blank if you don't want notifications yet — everything else
   works fine without them, the app just won't offer the "Enable" toggle.

## 3. Run the backend

```bash
cd backend
npm install
npm start
```

Starts on `http://localhost:8787`. Check `http://localhost:8787/api/health`.

The backend polls each configured underlying every 4 seconds. Dhan documents a
limit of one unique Option Chain request every 3 seconds, so the default
interval leaves headroom while NIFTY and SENSEX remain separate underlying
requests. The backend also prevents overlapping polls for the same symbol.

### Keeping a Render service awake

On Render, the backend requests its own `/api/health` endpoint once a minute
using the built-in `RENDER_EXTERNAL_URL`. This avoids a hardcoded deployment
URL. If another host does not provide that variable, set `SELF_PING_URL` to
the public backend URL. The browser now preserves the last live state and
retries an interrupted SSE connection with capped exponential backoff instead
of falling back to simulated data after four seconds. A service that is already
asleep still needs an external uptime monitor or a non-sleeping hosting plan.

**To use from your iPhone**, deploy it somewhere reachable over the
internet — localhost won't reach your phone:

- [Render.com](https://render.com) — "New Web Service", point at `backend/`,
  set the env vars from `.env` in its dashboard, deploy.
- [Railway.app](https://railway.app) — similar flow, free tier available.
- Your own VPS if you have one.

You'll end up with a URL like `https://oi-pulse-backend.onrender.com`.

## 4. Run the frontend

`frontend/index.html` and `frontend/sw.js` must be hosted **together, at
the same site root** (the service worker needs to be served from `/sw.js`
for push notifications to work) — GitHub Pages, Netlify, or Vercel static
hosting all do this by default if you upload the `frontend/` folder as-is.

1. Open the hosted URL in Safari on your iPhone.
2. Tap ⚙, paste your backend URL, save.
3. Optionally tap **Enable** under push notifications and allow the
   permission prompt.
4. Tap **Share → Add to Home Screen**.

## How the ATM band works

Each poll, the backend finds the strike closest to the current underlying
price (the ATM strike), then walks `strikesEachSide` (default 3) strikes
up and down using the *actual* strike spacing read from that day's chain —
so it stays correct even if NSE/BSE revise strike intervals. For each of
those 7 strikes it diffs current OI against the OI recorded at the start of
each window, giving you a real per-strike OI change, not a chain-wide total.

## Notifications

`config.json`'s `thresholds` (in OI contracts) are checked against the
combined change across all 7 tracked strikes, per window, per symbol. When
crossed, every subscribed device gets a push notification. `notifyCooldownMs`
stops the same symbol+window from re-notifying more than once per that
interval while a move stays above threshold (default 10 min).

## Notes on correctness

- Security IDs are set in `config.json`: NIFTY = 13, SENSEX = 51, both on
  the `IDX_I` segment — confirmed against Dhan's own API docs. Cross-check
  against Dhan's instrument master CSV if OI data ever looks off; brokers
  do occasionally revise these.
- Dhan's option chain endpoint is rate-limited to 1 request per 3 seconds
  **per unique underlying+expiry** — NIFTY and SENSEX are polled in
  parallel each cycle since they're separate buckets, not shared.
- Expiry is auto-selected as the nearest available for each symbol.
# OI-PULSE-AD
OI PULSE
