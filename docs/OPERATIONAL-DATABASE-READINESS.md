# Staging database operation approval packet

Inspected 19 November 2026. Target **SmartExit-Staging**, ref `ghecpkpaxbrvehquhzkr`, organization `ybqfgmywihsbqnlpncdz`, region `ap-southeast-2`, Postgres `17.11.0.019`, ACTIVE_HEALTHY. Production ref `kafsdnzzjawikoavkhvm` is excluded. No SQL, grants, credentials or backup configuration was changed.

## Actual backup evidence — BLOCKED

The authenticated [Scheduled backups page](https://supabase.com/dashboard/project/ghecpkpaxbrvehquhzkr/database/backups/scheduled) identifies ETHcryptohub as **FREE** and states **Free Plan does not include project backups**. The [Point in time page](https://supabase.com/dashboard/project/ghecpkpaxbrvehquhzkr/database/backups/pitr) offers a Pro Plan add-on, starting at $100/month; it does not show an enabled recovery window. No scheduled backup or PITR timestamp/restore point was listed. The dashboard's `main PRODUCTION` badge is the default branch label inside this Staging project, not the separate Production project.

Thus existing managed restore coverage is **not available**, rather than merely unverified. Do not approve migration execution on the assumption that a managed backup exists. No restore/upgrade action was clicked. Dashboard read access and MCP SQL permission do not prove restore permission, billing authority or a successful restore rehearsal.

Minimal operator choice: authorize either (a) a trusted, encrypted logical backup of this Staging database including schema/data/roles and a restore rehearsal into an isolated disposable target, or (b) a paid backup arrangement and independently verify an AVAILABLE pre-change backup with timestamp and authorized restore operator. A plan upgrade by itself does not establish the first completed backup. Preserve database passwords and encryption keys in the approved secret manager; a database backup is not an application-secret backup. No backup export or test-target creation is authorized or performed here. Protect dumps as sensitive data; do not upload to Git/chat/artifacts. Storage object files and external settings require separate backup coverage if in scope.

Official references: [backups and restore limitations](https://supabase.com/docs/guides/platform/backups), [logical backup/restore workflow](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore). Current changelog inspected; CLI v3 changes hosted-target defaults, so discover installed CLI commands with --help and pin the execution tool before approval. Never use an assumed CLI flag or bulk db push for this ledger.

## Fresh ledger and baseline

Read-only MCP query returned 15 entries. Filename identity is in **name**, while **version** contains application-time values. Earliest `20261114105639 / 202611050001_initial_schema`; latest `20261114110131 / 202611100002_binance_demo_environments`. Names match the first 15 ordered repository migration files. No pending migration name appeared. Do not rewrite/repair that ledger to force timestamp equality.

Counts: users 2, legacy user_trading_settings 2, binance_api_credentials 0, trade_executions 0. `public.auth_password_reset_codes` and `public.exchange_api_credentials` absent. Earlier typo queries for password_reset_codes/exchange_credentials were not used as proof; the actual names were rechecked. The private paper draft remains absent and outside this chain.

The localhost-only optional migration checker now normalizes filename-prefixed names to avoid misreporting this ledger shape. `npm run validate:migrations` still performs file validation only unless its explicit local-database option is supplied; it never queries this hosted project automatically.

## Exact migration approval scope

Request approval for the following **files at the reviewed release SHA**, in this order, on Staging only, after backup/restore evidence and fresh preflight pass. Authorization must explicitly cover schema/grant changes and documented data backfills; it must not include orders, credentials, identity provisioning, schedules or worker activation.

| Order | File in supabase/migrations | Dependency / effect |
|---|---|---|
| 1 | 202611100003_multi_exchange_foundation.sql | Existing users, credentials, legacy settings, trade_executions; creates multi-provider schema, copies ciphertext unchanged, disabled/CONFIRM backfill |
| 2 | 202611100004_exchange_execution_defaults_disabled.sql | Immediately follows 100003; all provider/exchange execution flags false, CONFIRM |
| 3 | 202611110001_strategy_profiles.sql | 100003 settings; creates strategy profiles, annotates historical executions against market_signals |
| 4 | 202611110002_binance_protection_lifecycle.sql | trade_executions from 100003/110001; lifecycle fields and stricter status constraints |
| 5 | 202611110003_binance_credential_environment_confirmation.sql | Both legacy and multi-exchange credentials; verification/environment metadata |
| 6 | 202611110004_admin_binance_demo_testing.sql | Existing users/trade types; Admin-only credential/session/authorization/execution/audit tables and atomic RPC; no account seed |
| 7 | 202611110005_admin_binance_demo_rpc_grant.sql | Exact function signature from 110004; restricted service_role EXECUTE |
| 8 | 202611110006_multi_exchange_execution_defaults_disabled.sql | All settings from 100003/110001; disables provider/strategy/exchange/legacy execution after backfills |
| 9 | 202611110007_admin_demo_exchange_neutral.sql | Existing users/service role; provider-neutral identity and composite ownership FKs, audit, scoped authorization RPC; restricted grants; no identity seed |
| 10 (separate feature) | 202611140001_password_recovery.sql | Existing public.users; reset-code table, RLS/browser grants revoked; no notification or password update |

Password recovery depends only on existing users, so the smallest separate approval may apply **only 202611140001**, after backup evidence and matching verification. It need not wait for exchange schema activation. Record that exact file identity without pretending earlier files were applied. Do not sort future execution solely by ledger version.

The private paper SQL plan is **not** included in either approval; transactional adapter, least-privilege role and tenant boundary need separate review.

## Execution and stop conditions (future approval only)

1. Freeze the reviewed Git SHA and SHA-256 for every selected file (`Get-FileHash -Algorithm SHA256`); recompare before each step. Reconfirm URL/ref/host independently, all execution/environment gates false, no automatic migrations. Establish a maintenance window and prevent concurrent credential/settings writers; do not widen account access.
2. Record available recovery timestamp/backup identifier, encrypted backup location, backup completeness, authorized restore operator/access and isolated restore-rehearsal result. If unavailable, stop. Record acceptable recovery-point data loss and recovery-time budget rather than inventing an RTO.
3. Run only baseline section of `supabase/verification/functional-staging-release-readiness.sql`. Check version AND name, object drift, incompatible execution states, environment values, duplicate keys, row counts, zero or preserved ciphertext and expected backfill counts. Current expected counts: 5 disabled providers, 4 exchange settings, 4 strategy profiles, 2 legacy settings. Recompute from fresh rows; do not treat these as constants when data changed.
4. Apply one reviewed file using an explicitly selected migration runner with transaction/error-stop semantics; record returned ledger identity. Keep application execution gates locked throughout. Run its same-named SELECT-only `supabase/verification/<file>.sql` immediately. Never invoke authorization RPC to test grants: it mutates state.
5. Stop on first DDL error, count mismatch, non-disabled flag, browser grant, missing RLS/FK, unexpected identity seed, changed ciphertext, wrong target or drift. Do not continue or auto-retry a partially applied non-idempotent file (110007 uses plain CREATE TABLE). Determine committed state read-only before any approved forward fix.
6. After selected chain, run post-migration section of functional-staging-release-readiness.sql; verify RLS/grants/function signatures/PUBLIC revocation, tenant composite FKs, disabled/CONFIRM settings, expected backfills, unchanged users/credentials and inactive jobs. For recovery-only selection run its dedicated verifier, then harmless readiness GET; no password-reset POST/email needed.
7. Recheck exact Preview target/flags and read-only pages. Schema availability does not approve credential enablement, Admin identity provisioning, remote paper, worker, CRON or orders.

## Recovery

Before commit, an execution transaction failure should roll back that file; verify the runner behavior before use. After commit, do not run ad-hoc DROP or inverse data updates: they can destroy copied credentials, audit evidence or later writes. Lock writers/execution, retain failure evidence, compare baseline, then request explicit approval for either a reviewed forward fix or restore of **Staging only** to the recorded pre-change recovery point. A restore may take the project offline and discards subsequent writes; application deployment rollback alone does not undo database changes. Re-run ledger/schema/default/grant/ciphertext checks after recovery. A restore is not authorized by this preparation task.

## Exact outstanding operator action

Choose and approve a Staging backup method plus isolated restore rehearsal; provide an authorized recovery operator and verify the successful backup/restore evidence privately. Then approve either the nine-file disabled exchange foundation chain, password-recovery-only file, or both explicit scopes above at the reviewed SHA. Current status: **migration execution BLOCKED by absent backup/restore coverage**. No migration was applied.
