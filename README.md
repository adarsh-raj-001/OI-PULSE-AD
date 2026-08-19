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

## Files, and what's a secret vs. a setting

| File | Contains |
|---|---|
| `backend/.env` | **Secrets**: Dhan client ID/token, VAPID push keys. Never commit this. |
| `backend/config.json` | **Tunables**: symbols tracked, strikes-each-side, poll interval, notification thresholds, cooldown. Safe to commit. |
| `backend/config.js` | Loads both of the above — nothing else in the app reads `.env` or `config.json` directly. |

To change how sensitive the alerts are, or add/remove symbols, edit
`config.json` — no code changes needed.

## 1. Get your Dhan credentials

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
