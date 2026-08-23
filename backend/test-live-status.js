import assert from 'node:assert/strict';
import { isLiveFeedFresh, resolveDashboardStatus } from './liveStatus.js';

const now = 1_000_000;
const freshFeed = { state: 'connected', lastEventAt: now - 2_000 };
const silentFeed = { state: 'connected', lastEventAt: now - 16_000 };

assert.equal(isLiveFeedFresh(freshFeed, now, 15_000), true);
assert.equal(isLiveFeedFresh(silentFeed, now, 15_000), false);

assert.deepEqual(
  resolveDashboardStatus({ restState: 'rate-limited', liveFeedStatus: freshFeed, now, freshnessMs: 15_000 }),
  { status: 'live', source: 'live-feed', restState: 'rate-limited' },
  'a fresh Dhan feed must not be labelled stale due only to REST reconciliation throttling',
);
assert.deepEqual(
  resolveDashboardStatus({ restState: 'rate-limited', liveFeedStatus: silentFeed, now, freshnessMs: 15_000 }),
  { status: 'stale', source: 'rest-rate-limited', restState: 'rate-limited' },
);
assert.deepEqual(
  resolveDashboardStatus({ restState: 'live', liveFeedStatus: { state: 'reconnecting', lastEventAt: now - 20_000 }, now, freshnessMs: 15_000 }),
  { status: 'live', source: 'rest', restState: 'live' },
);
assert.deepEqual(
  resolveDashboardStatus({ restState: 'starting', liveFeedStatus: { state: 'waiting', lastEventAt: null }, now, freshnessMs: 15_000 }),
  { status: 'connecting', source: 'starting', restState: 'starting' },
);

console.log('live status tests passed');
