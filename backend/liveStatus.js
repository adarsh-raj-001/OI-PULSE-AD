export function isLiveFeedFresh(liveFeedStatus, now = Date.now(), freshnessMs = 15_000) {
  const lastEventAt = Number(liveFeedStatus?.lastEventAt);
  return liveFeedStatus?.state === 'connected'
    && Number.isFinite(lastEventAt)
    && now - lastEventAt >= 0
    && now - lastEventAt <= freshnessMs;
}

export function resolveDashboardStatus({ restState, liveFeedStatus, now = Date.now(), freshnessMs }) {
  if (isLiveFeedFresh(liveFeedStatus, now, freshnessMs)) {
    return { status: 'live', source: 'live-feed', restState };
  }
  if (restState === 'live') return { status: 'live', source: 'rest', restState };
  if (restState === 'starting') return { status: 'connecting', source: 'starting', restState };
  if (restState === 'rate-limited') return { status: 'stale', source: 'rest-rate-limited', restState };
  return { status: 'stale', source: 'rest-error', restState: restState || 'error' };
}
