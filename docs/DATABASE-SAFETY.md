# Database migration safety

## Migration audit

Review migration filenames and dependencies before a migration review. Repository-only checks cannot establish whether a migration is applied; every migration's database status is **UNKNOWN** until independently verified against the intended database.

For the current `functional-staging` release, target only Supabase project `ghecpkpaxbrvehquhzkr`; Production is `kafsdnzzjawikoavkhvm`. An earlier operator report says 15 migrations are applied through `202611100002_binance_demo_environments.sql`, but this is not independently verified. The release adds `202611140001_password_recovery.sql`, which requires the existing `public.users` table. Do not reapply recorded migrations. Exclude `202611100003_multi_exchange_foundation.sql` and `202611110001`–`202611110005`; migration 003 seeds customer and Demo Binance providers as enabled, contrary to this release's disabled-execution requirement.

The trading migration dependency chain is:

1. `202611100001_live_futures_trading.sql` — requires the existing `users` and `market_signals` tables.
2. `202611100002_binance_demo_environments.sql` — requires Binance credentials and the settings/execution tables from migration 001.
3. `202611100003_multi_exchange_foundation.sql` — requires the Binance tables and environment columns from migrations 001–002; excluded from the current Staging release because it seeds Binance providers as enabled.
4. `202611110001_strategy_profiles.sql` — requires migration 003's exchange settings and provider tables.
5. `202611110002_binance_protection_lifecycle.sql` — requires migration 003 and the `strategy` field from migration 110001.
6. `202611110003_binance_credential_environment_confirmation.sql` — requires the legacy Binance credential table and exchange credential table from migrations 002–003.
7. `202611110004_admin_binance_demo_testing.sql` — requires `users`; creates dedicated Admin Demo account, session, authorization, execution, and event tables. It intentionally has no foreign keys to customer execution, signal, or credential tables.
8. `202611110005_admin_binance_demo_rpc_grant.sql` — requires migration 004; grants the fixed atomic authorization function to Supabase `service_role` only.

The remaining numbered migrations that precede this chain must also be installed in order as documented in [DEPLOYMENT.md](../DEPLOYMENT.md). `202611050002_smartexit.sql` is legacy and is not a substitute for the current chain.

| Migration | Dependency / preservation notes | Read-only verification file |
|---|---|---|
| `202611100001_live_futures_trading.sql` | Existing `users` and `market_signals`; creates settings/execution rows and self-read policies; does not migrate credentials. | `supabase/verification/202611100001_live_futures_trading.sql` |
| `202611100002_binance_demo_environments.sql` | Requires migration 001. Existing Binance keys and executions default to `LIVE`; settings default to `DEMO`; preserves records while changing credential primary key to `(user_id, environment)`. | `supabase/verification/202611100002_binance_demo_environments.sql` |
| `202611100003_multi_exchange_foundation.sql` | Requires migrations 001–002. Copies Binance ciphertext unchanged with `ON CONFLICT DO NOTHING`; creates exchange settings/providers/events and replaces execution uniqueness with `(user_id, signal_id, exchange, environment)`. | `supabase/verification/202611100003_multi_exchange_foundation.sql` |
| `202611110001_strategy_profiles.sql` | Requires migration 003. Backfills Standard from existing settings disabled; backfills signal strategy labels; inserts disabled Standard/High-Risk profiles. | `supabase/verification/202611110001_strategy_profiles.sql` |
| `202611110002_binance_protection_lifecycle.sql` | Requires 003 and 110001. Adds lifecycle IDs/timestamps/locks and replaces the execution-status check; existing unrecognized statuses can make the new check fail. | `supabase/verification/202611110002_binance_protection_lifecycle.sql` |
| `202611110003_binance_credential_environment_confirmation.sql` | Requires credential tables from 002–003. Preserves ciphertext and adds false-by-default re-entry confirmation to existing and copied credentials. | `supabase/verification/202611110003_binance_credential_environment_confirmation.sql` |
| `202611110004_admin_binance_demo_testing.sql` | Requires `users`. Creates isolated, fixed-Binance-DEMO tables; ciphertext is separate from customer credentials; no direct Supabase-client grants or policies; owner confirmation is mandatory for each dedicated test account. | `supabase/verification/202611110004_admin_binance_demo_testing.sql` |
| `202611110005_admin_binance_demo_rpc_grant.sql` | Requires 004's exact authorization function signature; grants only its execute privilege to `service_role`, not browser roles. | `supabase/verification/202611110005_admin_binance_demo_rpc_grant.sql` |

Migration-file validation is static only. It never opens a database or executes SQL; verification statements remain manual, read-only operator checks.

`202611140001_password_recovery.sql` creates the application-only reset-code table after the existing schema. It enables RLS and revokes `anon`/`authenticated` access; the server's database role performs the scoped code, password, and session updates. Its paired verification file checks the RLS flag and client-role grants without reading reset codes.

## Findings

- Migration 002 assigns existing Binance credential rows `LIVE` by default, although the original credential table has no environment column. The repository cannot prove the original environment of any stored key. Migration 110003 therefore adds `environment_confirmed` with a false default to both credential tables; legacy rows remain encrypted and preserved, but credential loaders refuse to use them until an owner re-enters credentials into the explicitly selected environment. This is an environment-selection confirmation, not cryptographic proof that a key was issued for that environment.
- Migration 003 copies encrypted credential ciphertext and settings using `ON CONFLICT DO NOTHING`. This preserves existing destination records but copies ciphertext unchanged, so the destination must use the matching encryption key or credentials must be re-saved under a distinct staging key.
- Migration 003 enables RLS and revokes direct `anon`/`authenticated` table grants for exchange and admin event/audit tables, with no user-facing SQL policies. Application routes must enforce `requireAdmin` for admin operations, and only the server-side database role may access these tables.
- Migration 110001 seeds both profiles disabled, copies active Binance settings into Standard without enabling it, and leaves High-Risk disabled. Profiles cannot be enabled while position or daily-loss limits are null. Its named execution constraints now use drop-and-add so rerunning the migration does not fail solely because those constraints already exist.
- Migration 110002 replaces the execution-status constraint and adds reconciliation identifiers/locks and the open-protection index. Validate existing statuses before applying; only `CLOSED` is added to the original status set.
- Migration 110003 adds a false-by-default confirmation marker to legacy and exchange credential rows. Re-entry updates only that row's encrypted values and marks its selected environment confirmed; confirm credential re-entry readiness before applying because old imported credentials will no longer be usable.
- Migration 110004's Admin Demo credentials have their own table and are restricted to Binance Demo by database constraints; credential revocation clears the ciphertext. Sessions, temporary authorizations, test executions, and audit events are isolated from customer data by table design and composite ownership foreign keys. A partial unique index prevents concurrent active sessions for one test account and a second active authorization for one session. RLS is enabled with no client-facing policies and direct `PUBLIC`/`anon`/`authenticated` grants are revoked. A `SECURITY DEFINER` function with a fixed search path atomically consumes a session/Admin/action-scoped `START_TEST` authorization and records the start event; it is not executable by `PUBLIC`, `anon`, or `authenticated`. The app currently does not call this function. Server routes must still call `requireAdmin`, scope every read/write to the server-derived Admin and session, and sanitize evidence. The migration is a review-only file; its existence is not proof it was applied.
- Migration 110005 grants the 110004 authorization function to `service_role` so a server-only Supabase RPC client can call it. The server role key is required only for this server-side integration and must never be exposed to a browser. The new RPC adapter maps missing-function/table responses to a schema-not-ready error and has no in-memory fallback; it is not yet connected to an execution route. Both migrations remain review-only.
- Migrations 001–002 use `citext`/Supabase auth conventions supplied by the existing database. Confirm the migration role has the required extension and schema permissions.

These are static SQL findings, not proof of what is installed in any database. Run the corresponding SELECT-only files in `supabase/verification/` only against a confirmed, approved staging database. They do not reveal credential ciphertext. Migration 110003 verification reports only column metadata, RLS status, and counts of confirmed/unconfirmed rows; it does not select key suffixes, ciphertext, or credential values. Migration 110004 verification reports RLS/grants, constraints, indexes, and aggregate row counts only.

## Backup, migration, and recovery checklist

For the current release, only `202611140001_password_recovery.sql` is in scope. The exchange migrations below are future-only review guidance; do not apply them for this release.

Before any authorized staging migration:

- [ ] Confirm the project reference, project URL, Vercel Preview target, and that all differ from Production.
- [ ] Confirm the staging data is sanitized and contains no Production exchange credentials or customer secrets.
- [ ] Confirm a restorable backup/PITR recovery point and test access to the restore procedure.
- [ ] Capture pre-migration counts for users, Binance credentials grouped by environment, trading settings, executions grouped by environment/exchange/status, and existing strategy profiles if present. Never select credential values.
- [ ] Save the migration files/release revision and a checksum inventory with the recovery record.
- [ ] Keep all execution gates disabled and automatic execution off.
- [ ] Before migration 110003, notify credential owners that existing Binance credential rows will require re-entry into their explicitly selected environment before they can be used again.
- [ ] Before migration 110004, confirm the Admin test-account schema, retention policy, server database role, temporary-authorization expiry policy, and isolated Demo account ownership.
- [ ] Apply exactly one migration at a time, in dependency order, using a migration-capable role. Stop immediately on any error.
- [ ] Run that migration's read-only verification SQL and compare all row counts with the baseline.
- [ ] Confirm RLS flags/policies, foreign keys, unique constraints, indexes, and relevant grants before continuing.
- [ ] Record the operator, timestamp, project reference, migration version, output, and outcome without storing secrets.

The owner reported the staging dataset is sanitized and a restorable backup/PITR is available. These are owner confirmations only; neither this code nor the readiness utility independently verifies the backup or database contents.

Recovery:

- Prefer restoring the pre-migration staging snapshot if the migration failed and no post-migration writes need preservation.
- If new records have been written, do not blindly restore or drop tables: preserve the new data and request a reviewed forward-fix or recovery plan.
- Treat destructive DDL as a separate, explicitly reviewed operation; do not use ad hoc rollback SQL.
- Re-deploy the matching application revision after recovery and rerun the read-only verification.
- Never apply this checklist to Production without a separate approval, backup, and change window.
