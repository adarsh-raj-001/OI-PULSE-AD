# OI Pulse Enhancement TODO

- [x] Sync the local repository with the current GitHub main branch and create an isolated working branch.
- [x] Verify Dhan Option Chain fields available for underlying price, option OI, bid, ask, volume, and price changes.
- [x] Define transparent Call/Put market-strength aggregates and scoring rules with clear data-availability fallbacks.
- [x] Add backend market-strength payloads for every supported time window without changing the exact 5m/30m/3h semantics.
- [x] Add frontend strength bar, directional intensity, aggregate driver cards, and unavailable-data messaging.
- [x] Validate calculations with deterministic Dhan-shaped fixtures and document the indicator limitations.
- [x] Commit reviewed changes to the working branch and report the implementation.
- [x] Publish the reviewed market-strength commit to main through a pull request.
- [x] Verify the backend self-ping configuration and identify why the frontend falls back to demo mode.
- [x] Fix live backend connection resilience without embedding a deployment-specific keep-alive URL.
- [x] Make Call/Put volume and bid-ask metrics visibly available in the market-strength dashboard.
- [x] Validate the connection and aggregate display fixes before publication.
- [ ] Publish the validated connection-resilience fix to main through a pull request.
