import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import webpush from 'web-push';
import { secrets, config, notificationsEnabled } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUBS_FILE = path.join(__dirname, 'data', 'subscriptions.json');

let subscriptions = [];
try {
  subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf-8'));
} catch {
  subscriptions = [];
}

function persist() {
  fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true });
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2));
}

if (notificationsEnabled) {
  webpush.setVapidDetails(secrets.vapidSubject, secrets.vapidPublicKey, secrets.vapidPrivateKey);
} else {
  console.warn('VAPID keys not set — push notifications are disabled. See .env.example.');
}

export function addSubscription(sub) {
  if (!subscriptions.find((s) => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
    persist();
  }
}

export function removeSubscription(endpoint) {
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
  persist();
}

// symbol+window -> last time we notified, for cooldown
const lastNotified = {};

async function sendToAll(title, body, tag) {
  const payload = JSON.stringify({ title, body, tag });
  const dead = [];
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
        else console.error('push send failed:', err.message);
      }
    })
  );
  if (dead.length) {
    subscriptions = subscriptions.filter((s) => !dead.includes(s.endpoint));
    persist();
  }
}

const WINDOW_LABEL = { m5: '5 min', m30: '30 min', h3: '3 hour' };

// Checks a symbol's freshly computed window deltas against configured
// thresholds and fires a (cooldown-limited) push notification per crossing.
export function checkThresholds(symbol, windows) {
  if (!notificationsEnabled || !subscriptions.length) return;

  for (const [key, win] of Object.entries(windows)) {
    if (!win) continue;
    const threshold = config.thresholds[key];
    if (!threshold) continue;

    const bandTotal = win.bandDeltaTotal; // combined OI change across the tracked 7-strike band
    if (Math.abs(bandTotal) < threshold) continue;

    const cooldownKey = `${symbol}:${key}`;
    const now = Date.now();
    if (lastNotified[cooldownKey] && now - lastNotified[cooldownKey] < config.notifyCooldownMs) continue;
    lastNotified[cooldownKey] = now;

    const direction = bandTotal > 0 ? 'built up' : 'unwound';
    const label = WINDOW_LABEL[key] || key;
    sendToAll(
      `${symbol} · OI ${direction} near ATM`,
      `${label}: ${bandTotal > 0 ? '+' : ''}${Math.round(bandTotal).toLocaleString('en-IN')} contracts around the market strike.`,
      cooldownKey
    );
  }
}
