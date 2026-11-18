# Staging Preview bug fixes — 19 November 2026

## Scanner evidence and scope

Read-only Staging inspection found exactly20 saved15m snapshots, dated15November2026 10:03–13:18UTC, with0recent rows. The approved Preview's GET scanner route reads `scanner_candidate_snapshots`; its30second browser refresh does not call Binance, scan candles or write new snapshots.

The producer is `runSignalScan` in `lib/signal-scan.ts`: pair discovery → enabled symbol selection (10symbols per rotating batch) → Binance public exchange/ticker/candle fetch → technical processing and setup generation → saved snapshots and signal persistence. Markets and candle caches apply only to that producer, not the saved-row GET route. API failures/retries and bounded rotation can affect producer coverage; no evidence establishes a current provider outage as the cause of these four-day-old rows. No scan or recovery was executed to conceal that gap. Background jobs remain disabled for this release. Existing20snapshot rows are not evidence that all522enabled pairs have current data.

Fixes:
- Validate both save time and candle time; invalid/future/old times fail closed.
- Do not restore previously STALE/DATA_UNAVAILABLE setups merely because a row was recently saved.
- Withhold cached price/change and entry targets when stale; keep old scan date visible.
- Identify recent rows as cached, label price as price-at-scan, and explain that reloading is not market-data refresh.
- Pair-discovery diagnostics warn after30minutes and explicitly do not certify scan freshness.

This fixes misleading presentation and freshness validation, not the absent producer runs. Fresh market results require a separately authorized bounded scan/recovery review; `runSignalScan` also persists signals/processes lifecycle and notifications, so it is not a read-only request and was not invoked. No CRON, autonomous trading or fabricated prices/signals are introduced.

## Mobile overflow

Before: authenticated `/admin/exchanges` at390px had scrollWidth548/clientWidth375, caused by long schema-warning filenames and intrinsic width. Shared warning/error wrapping and min-width constraints now allow text to fit, with warning children wrapping rather than expanding the page. No overflow is hidden to mask the defect. Acceptance must measure320,375,393,768 and desktop against the new deployed SHA.

## Database readiness — no migration execution

Fresh Staging ledger remains15 entries ending version20261114110131/name202611100002_binance_demo_environments. Exchange credentials, provider-neutral Admin identity/credential tables and password-reset-code table are absent. Exchange Balance and Admin Demo schema errors are expected; a generic503 does not independently prove that the saved service-role key authenticates. No credential was enabled or submitted.

Future separately approved order:
1. `202611100003_multi_exchange_foundation.sql`
2. `202611100004_exchange_execution_defaults_disabled.sql`
3. `202611110001_strategy_profiles.sql`
4. `202611110002_binance_protection_lifecycle.sql`
5. `202611110003_binance_credential_environment_confirmation.sql`
6. `202611110004_admin_binance_demo_testing.sql`
7. `202611110005_admin_binance_demo_rpc_grant.sql`
8. `202611110006_multi_exchange_execution_defaults_disabled.sql`
9. `202611110007_admin_demo_exchange_neutral.sql`
10. `202611140001_password_recovery.sql`, only if that feature is included in approval.

Before execution: independently verify a restorable Staging recovery point and restore access; pause credential writers; recheck ledger/schema and ciphertext counts; checksum reviewed files. Backup/PITR evidence remains unavailable through current connected tools. Do not blindly dbpush or repair the application-time ledger.

Apply one reviewed file at a time under later explicit approval and run its matching `supabase/verification/<same-name>.sql`. Baseline-derived expected changes are5disabled providers,4exchange settings,4strategy settings and2legacy settings; repeat counts before applying.100004and110006must follow their respective backfills and retain CONFIRM/disabled defaults.110007requires RLS, restricted service-role grants/RPC and separately approved identity provisioning. Postchecks in `supabase/verification/functional-staging-release-readiness.sql` cover defaults, grants, ownership and ciphertext. Its baseline ledger query now reads version AND name, since filename prefixes are in name for this target. Recovery is a separately approved pre-change Staging restore/forward fix, not an ad-hoc DROP rollback.

## Acceptance limits

Seven new regression checks cover stale/invalid/future saved data, non-resurrection, sync freshness and actual CSRF helper behavior (same-origin valid token, cross-origin/protocol rejection, missing/mismatched token rejection). Full suite currently310tests passes. These are mock/local checks, not a claim that non-admin browser isolation, email delivery, session expiry or all Admin Demo APIs work against the unmigrated database. Authorized non-admin test account/mailbox testing is planned after deployment. Exchange order execution, credential submission and preflight that needs real credentials remain excluded.
