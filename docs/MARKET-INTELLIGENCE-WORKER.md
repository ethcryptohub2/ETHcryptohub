# Shared Binance USD-M market worker

Implemented as a separate persistent Node24 process. It is not started by a page, API route, Vercel build, CRON or GitHub workflow. No live connection or permanent worker was activated during implementation. Validation uses replayed/mock frames and injected transports, clocks, timers, fetch responses and sinks.

## Components and boundaries

- `lib/intelligence/market-feed.ts`: official exchange-info discovery; all-market ticker ingestion; aggregate-trade deduplication and notional samples; snapshot/diff-depth synchronization; bounded order books/buffers; per-symbol freshness and continuity; bounded frame queue.
- `lib/intelligence/market-worker.ts`: explicitly approved lifecycle, routed/sharded sockets, global REST pacing/weight budget, rate-limit backoff, snapshot repair, disconnect/reconnect, stale handshake detection, connection rotation before24hours, serialized sink and visible failures.
- `scripts/market-intelligence-worker.mjs`: opt-in process entry point, exclusive local writer lock, durable segmented observation journal (8×16MiB) and persisted run epochs. Importing it does not connect or create files. Secrets and exchange order endpoints are absent. Atomic health snapshots and a local read-only probe distinguish liveness from full selected-input readiness. See `MARKET-WORKER-OPERATIONS.md` for inactive host configuration, budgets and operational limitations.

Current default eligibility (`DEFAULT_MARKET_ELIGIBILITY`): active USDT- or USDC-quoted perpetuals with the matching stablecoin margin asset, including valid Unicode symbols. `discoverEligibleSymbols(body, policy)` also supports explicit CURRENT_QUARTER/NEXT_QUARTER policies; those are not enabled by default and their expiry context needs downstream strategy review. COIN-M contracts are excluded. Shared ticker/funding updates cover the discovered universe; aggregate trades and depth cover an explicitly chosen1–200symbol list, split into100symbol shards. Symbols without all required fresh streams cannot become research-ready. This is not a claim of every futures-contract type or full-depth/trade research coverage for every discovered symbol. Expanding concurrent coverage needs resource and provider-budget review.

`takeObservation(symbol, now)` emits only after ticker + two-trade warmup + synchronized depth are fresh and sequence-valid. Each emitted quote-volume sample consists solely of new aggregate-trade notional since the prior publication;24hour ticker volume is separate health metadata. Buyer-maker trades count as aggressive sells. Bid/ask depth is quote notional of the top20known levels, not total exchange liquidity or wallet attribution. Optional funding is omitted when stale. Open-interest REST enrichment is not implemented here; its absence is not invented as zero.

Observation `eventTime` is the latest participating exchange event time, and `receivedAt` is projection assembly time. `volumeIntervalMs`, when measurable, is the actual elapsed publication window, not an assumed fixed cadence. Old unpublished notional is discarded after the freshness bound; it cannot become a new volume spike after recovery. The first zero-duration sample omits the interval rather than inventing one. Optional funding is withheld while its event timestamp is in the future. The optional `feedEpoch` changes after resets/gaps; downstream research must clear prior per-symbol history on epoch change. The CLI reserves a new persisted epoch range before connecting. Runtime buffers/books are rebuilt after restart, never reclassified fresh from an old journal. A gap in aggregate trades starts a new window rather than claiming repaired historical continuity.

## Protocol evidence

Current official docs, checked19November2026, distinguish `/market` (tickers/trades) and `/public` (depth) routing. The worker uses those routes explicitly. All-market ticker arrays contain changed tickers; missing symbols age independently. See [Binance connection documentation](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Connect) and [USD-M market stream reference](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market).

Depth is buffered before a REST snapshot. Initial events bridge the snapshot's update ID; subsequent `pu` must match prior `u`. A gap discards book readiness and pending notional, then requires resynchronization. Quantities are absolute; zero removes a level. See [official local-book procedure](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly).

The service uses URL-composed subscriptions instead of sending control messages repeatedly. Its shards remain far below the documented1024stream connection ceiling. Transport adapters must correctly handle protocol ping/pong; the CLI uses Node's built-in standards-compatible WebSocket. Real ping/pong interoperability, region access, reconnect load and provider delivery completeness remain unverified until an explicitly approved live soak. No alternate exchange or fabricated-price fallback exists.

## Backpressure and failure behavior

Default queue:256frames/8MiB, maximum accepted frame4MiB, at most128frames processed per cycle. Overflow invalidates continuity, clears queued frames and requires fresh synchronization. Books/buffers have hard caps; capacity overflow resynchronizes rather than trimming away evidence while claiming continuity. REST calls use a conservative300weight/minute local budget,1second pacing, explicit public GET allowlist, streamed4MiB response cap and10second request deadline.429/418 honor bounded backoff. Depth snapshots use limit100 with weight5; snapshots/retries are serialized. No claim is made that local budgeting overrides shared-IP/provider rules. The WebSocket frame cap is checked after the transport assembles a message; a hardened hosting transport with preassembly payload limits remains a deployment consideration.

Disconnects clear the global queue and invalidate coverage, so already-queued frames cannot warm a new feed epoch. Socket callbacks from old generations are ignored, and an in-flight REST snapshot started before a disconnect or queue resynchronization is discarded. Concurrent starts are rejected synchronously; stopping during discovery cancels that start before subscriptions open. Sink failures are tracked per symbol until that same symbol is successfully written; a different symbol's success cannot acknowledge the failure. A failed sink can lose that unpublished sample; it is not silently retried as exactly-once delivery. A downstream durable transport with acknowledgments is required before any exactly-once claim. Local journal retention now rotates only the oldest named segments, preserving unrelated and legacy files;128MiB is local retained history, not an archive. Failed writes/syncs/rotations poison the writer until reopen and operator review; incomplete tails fail closed. Graceful close waits for queued writes. Abrupt-process lock recovery is manual: verify no worker is active before removing a stale lock. Journal storage is local foundation persistence, not a deployed database/production HA system.

## Activation is a separate operator decision

After approval of persistent hosting, network/region access, selected symbols, resource/provider budgets, durable sink, monitoring and retention, all of the following are required to start the supplied process:

```
SMARTEXIT_DEPLOYMENT_ENV=staging
SMARTEXIT_MARKET_WORKER_APPROVAL=START_STAGING_PUBLIC_MARKET_WORKER
SMARTEXIT_MARKET_SYMBOLS=<explicit comma-separated discovered symbols>
node scripts/market-intelligence-worker.mjs --activate-approved-worker
```

Optional output directory: `SMARTEXIT_MARKET_OUTPUT_DIRECTORY` (default ignored `storage/market-intelligence`). These commands were NOT run with activation enabled. Vercel environments are rejected by the CLI. No database migrations, remote worker deployment, subscriptions, scheduled jobs, credentials or orders are authorized by this document.

## Replay verification

```
node --test lib/intelligence/market-feed.test.mjs lib/intelligence/market-worker.test.mjs
```

Tests cover symbol discovery, current endpoint topology, snapshot bridging/sequence gaps, disjoint notional and event deduplication, stale/future/mismatched-universe rejection, reset epochs, book/queue bounds, actual mocked worker-to-sink flow, activation guard, reconnect/handshake handling and sink rejection. Mock results establish component behavior, not a working24/7 live feed or current market prices in Preview.
