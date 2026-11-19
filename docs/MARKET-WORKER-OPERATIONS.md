# Staging worker deployment readiness — not activated

## Dedicated host choice and cost

Recommendation: one Linux DigitalOcean Basic Droplet, 1 vCPU / 1GiB / 25GiB, **USD6/month** compute, initially at most20 explicit trade/depth symbols. This is a low-cost test-host recommendation, not proof the instance can sustain that workload. A 2GiB / 1vCPU / 50GiB Droplet is **USD12/month** if measured headroom requires it; 200-symbol depth coverage needs a separate load and architecture review, not just a RAM upgrade. Taxes, transfer overage, optional backups and operator time are excluded. Current official [Droplet pricing](https://www.digitalocean.com/pricing/droplets), checked19November2026. Weekly VM backup adds20% (USD1.20 or2.40/month); a VM backup does not replace the separate Supabase recovery gate.

Select a legal/provider-supported region only after an approved public-feed connectivity check. No region has been tested here. No host was purchased, configured or started. Do not use a free service that sleeps or Vercel request handlers for permanent WebSockets.

## Prepared deployment files

- `deploy/market-worker/smartexit-market-worker.service`: dedicated unprivileged user, read-only application, persistent `/var/lib/smartexit-market`, no extra capabilities, memory/task ceilings, SIGTERM and bounded restart attempts. No boot-enable target. Requires an approval sentinel and an environment file; neither exists as part of this release.
- `market-worker.conf.example`: intentionally NOT_APPROVED with no selected symbols. No exchange/database credentials or Supabase access is needed for the local-journal worker.
- `journald-retention.conf`: proposed128MiB /7day host log limit. Review host-wide effects before installing.
- `scripts/check-market-worker-health.mjs <persistent-directory>`: local read-only readiness probe; `--liveness` checks heartbeat/running instead. No HTTP listener, public port, notifications, schedule or network call is created.

Future approved installation: install a reviewed Node24 binary at `/usr/bin/node`, exact reviewed repository under `/opt/smartexit`, create the dedicated user and persistent state directory, install the unit and environment file, choose explicit symbols, set the activation phrase and sentinel only with the separate approval, then manually start the service. Do not run these operations under this implementation approval. No package-install or migration hook belongs in ExecStart.

## Health and recovery

Atomic `health.json` is fsynced every15seconds, and on normal stop. Probe rejects missing/corrupt/future or older-than45second heartbeat. Readiness additionally requires all selected symbols synchronized/fresh, all transports connected, healthy sink and queued-frame age at most1second. Liveness alone never means research-ready. Metrics distinguish universe ticker coverage (fresh/stale/unseen), selected full-input coverage, queue bytes/age/drops, processed frames, socket message ages, cycle duration and last/max sink timing. Saved ticker count never implies fresh trades/depth.

Transport reconnects use bounded exponential delays, 15second handshake/60second socket-idle checks, 23hour rotation, invalidation and discarded pre-gap queues/snapshots. Restart reserves a new durable epoch and rebuilds books/trade warmup; old journals never become current prices. Standard-compliant native Node WebSocket transport is used; actual provider ping/pong and region behavior remain untested.

**Crash recovery remains fail closed:** the exclusive writer file lock deliberately survives abrupt death. systemd retries are bounded; a stale lock prevents startup. Operator must stop the unit, verify no process writes the state directory, preserve the journal/epoch, inspect the incomplete tail if any, then remove only the stale worker.lock and start after review. No unsafe automatic lock stealing or deletion of incomplete evidence is implemented. A kernel-fenced supervisor is a future improvement before unattended HA claims. Graceful SIGTERM cleans the lock automatically. This single-disk single-host design is not HA or exactly-once downstream delivery.

Retention now uses8 segments ×16MiB (at most128MiB observation payload after a successful write). Only exact `observations.<12digits>.ndjson` files in the locked state directory are rotated; unrelated files and the legacy observations.ndjson are preserved. Legacy files must be inventoried separately for host disk budgeting. Epoch/health/lock metadata are bounded independently. An incomplete current tail or oversized existing segment fails closed for operator review. Per-record fsync favors durability over throughput; retention intentionally discards oldest local history and is not an archival system. Approval must explicitly accept the128MiB local history policy or commission durable acknowledged archival before operation.

## 522-symbol architecture and realistic budgets

522 is the application's last observed enabled-universe count, not a newly measured Binance exchangeInfo count. At startup the worker independently discovers eligible active stablecoin-margined perpetuals; counts may differ. One shared ticker/funding connection handles that discovered universe. An offline522-symbol fixture verifies independent ticker freshness and proves all522 remain research-unready without their trade/book inputs.

Trade/depth selection is1–200 symbols in100-symbol shards. At200: five sockets total (one two-stream ticker/funding socket, two100-stream trade sockets and two100-stream depth sockets). The API rejects522 selected trade/depth symbols. Current official [USD-M connection documentation](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Connect) specifies24hour lifetime, server ping every3minutes with10minute response deadline,10 incoming messages/second and1024 streams/connection. These provider inbound/control limits are not a guarantee of market-event rate. Current routed `/market` versus `/public` endpoints are used. No rapid control-message subscription loop is sent.

The worker drains at most128frames per cycle, with100ms scheduling after cycle completion: **1280frames/second is only a zero-work upper bound**, lower once REST and fsync take time. 200 symbols at one depth update per100ms alone would produce2000frames/second before trades, so the current maximum configuration cannot be certified as sustainable. The new synthetic overload regression demonstrates queue rejection in precisely that scenario. A 256frame/8MiB queue is a burst buffer, not permission to accumulate stale work. Overflow invalidates continuity and resynchronizes rather than silently dropping data as fresh.

Snapshots are serialized at least1second apart with300weight/minute local budget and weight5 per100-level depth snapshot. Ideal minimum warmup is roughlyNseconds forN selected symbols before retries, and a256-event per-symbol depth buffer at10events/second spans only25.6seconds. Hence200 selected symbols can repeatedly overflow before warmup; use a small explicit list first, and do not promise200symbol readiness. At20symbols, worst-case depth scenario is200frames/second plus actual trade arrivals; this is a starting hypothesis only. Exchange ticker freshness is5seconds per symbol; unchanged ticker arrays omit symbols, so quiet symbols age stale conservatively.

Proposed acceptance budget, **not achieved live evidence**: initial20-symbol soak24hours including reconnect/rotation; zero unhandled queue drops in steady state; selected fresh coverage at least95% of monitored windows after warmup, report every exception; queued frame age p95 below250ms and never over1second while ready; exchange-to-assembled-observation lag p95 below2seconds with5second fail-closed threshold; CPU below70%, RSS below600MiB, disk headroom at least2GiB. Record rates/bytes/cycle/sink/fsync delays and actual region RTT. A gap or stale input must reduce readiness regardless of percentages. No event latency, completeness, ping interoperability or host capacity has been verified against live Binance in this session. Open-interest enrichment, closed-bar supply and remote research/storage wiring remain separate work.

## Offline verification

`node --test lib/intelligence/market-feed.test.mjs lib/intelligence/market-worker.test.mjs lib/intelligence/market-worker-operations.test.mjs`

Tests use injected transport/clock/timers and temporary local directories only:522ticker coverage, selected shard limits, overload rejection, journal retention/restart/incomplete-tail handling, health/liveness separation, existing reconnect/backpressure/generation/snapshot and activation guards. No remote worker or public feed was activated.
