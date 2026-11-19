# Public-market pipeline: implemented, inactive

The worker still writes only to local persistent disk. Website cached scanner routes remain unchanged. The components below are now implemented and tested together with local fixtures; none is connected to a remote writer.

## Producer and durable source

The actual worker emits requiredInputTimes for ticker/trade/depth. CLI journal rows now contain version, runId, per-run sequence, per-symbol epoch and observation. PublicMarketTailer reads bounded complete NDJSON rows and proposes batches without acknowledging them. Cursors bind run, epoch, segment, byte offset, sequence and semantic hash. Truncation, missing/rotated segments, sequence gaps, changed anchors and legacy unwrapped files fail closed. Partial current tails wait for completion; corrupted or partial sealed data needs review. See PUBLIC-MARKET-JOURNAL-TAILER.md.

## Credential-separated import boundary

PublicMarketImporter validates strict public-only contracts, original receipt-time coherence, required-input evidence, hashes and cursor ordering before bounded enqueue. No tenant IDs, secrets or unknown metadata are accepted. It invokes an injected source-bound sink, not a network listener or application database. Queue heads are removed only after exact batch/cursor acknowledgement. Lost responses preserve the original identity for reconciliation; there is no automatic retry scheduler. A sourceId string is not authentication: an actual transport must independently authenticate the producer and authorize the fixed source before enqueue. No endpoint, credential, cloud service or transport was provisioned.

## Persistence adapter and recovery

PostgresPublicMarketStore is unwired and takes an injected pool plus explicit Staging target. It validates batches again, serializes first writes with transaction advisory locking, locks the existing row, checks the prior cursor/revision and commits projection plus acknowledged cursor atomically. It handles the latest duplicate without rewriting, discards ambiguous COMMIT connections, and exposes readAcknowledgement for restart. A stale older batch after subsequent progress conflicts instead of rewinding; reconcile the latest durable cursor. Database credentials never belong on the public feed worker.

The targetRef constructor parameter is a trusted caller assertion, not proof of the pool's real connection identity. Before activation, independently verify target/pool provenance and narrowly scoped role permissions. Actual PostgreSQL locks, transaction pooling, RLS/grants, concurrent failure injection and recovery remain untested remotely. The SQL draft supabase/plans/public-market-pipeline.sql is outside automatic migrations and has not been applied. It defaults to browser-denied forced RLS without activated roles/policies/grants. A dedicated reader/writer role design needs separate review and verified backup/recovery.

## Read model and disabled website API

Projection restores original timestamps. With explicit requiredInputTimes it labels only unexpired oldest-input evidence FRESH_OBSERVATION; legacy observations remain RECENT_OBSERVATION with freshness unverified. Expired prices are hidden. This is validated supplied evidence, not independent evidence of a live provider or continuous connection. Ticker-only data cannot enter the importer and never creates research candidates. All-universe ticker coverage is separate; candidates remain empty and execution/continuousFeedVerified remain false.

Authenticated GET /api/intelligence/market is a new, separate read-only interface. SMARTEXIT_PUBLIC_MARKET_READS_ENABLED must be exactly true and the independently configured target must be the exact Staging project. Default is disabled with no market-table query. Production and tenant/source query overrides are rejected or gated. Errors return unavailable without changing cached scanner behavior. POST retains auth/CSRF and always returns PUBLIC_MARKET_INGESTION_DISABLED; no flag/body can activate a writer. No existing scanner query or customer paper/order path was changed. The current scanner UI continues its cached behavior; a future UI consumer can use this separate API after approved storage/read activation.

## Validation and remaining activation work

Integration fixtures exercise actual journal -> tailer -> bounded importer -> transactional adapter double -> website view, including lost COMMIT response, restart, duplicate identity and partial-tail completion. Other tests cover retention gaps, malformed/secret-bearing inputs, stale prices, bounded queues, two authenticated users' override rejection, atomic rollback and disabled/Production read gates. These are local mocks, not installed RLS or live scanning proof.

Still required: reviewed authenticated transport/tailer supervisor, trusted pool provisioning and actual disposable PostgreSQL/RLS fault tests, backup/restore evidence, exact schema/grant and bounded public-data write approval, then separate reader flag activation. Gap recovery must never silently reset a cursor. Research signals additionally need closed bars, strategy processing and durable decisions; no momentum/whale/trade readiness follows from public quotes. Regional probe and 24-hour worker soak approvals are separate; see PUBLIC-MARKET-REGIONAL-PREFLIGHT.md. No infrastructure, probe, service, migration, remote database write, notification, CRON, paper execution, order, credential change or Production deployment was performed.
