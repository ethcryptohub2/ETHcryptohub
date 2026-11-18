# Functional Staging — Bybit Readiness and Release Package

> Updated 2026-11-18: the local lifecycle implementation and current safety
> findings are in [Bybit staged lifecycle local validation](BYBIT-STAGED-LIFECYCLE-LOCAL-VALIDATION.md).
> The implementation below describes the earlier read-only release baseline.
> Local mocked execution paths now exist; remote execution remains disabled.
> TP2 replacement remains unsupported and retains the existing protection.

## Status

**Release candidate: BLOCKED.** The current `functional-staging` HEAD is
`861ea5643f58708187ecaf0a848ca340895d1dfe`; the implementation is uncommitted.
The Staging project and migration boundary (`ghecpkpaxbrvehquhzkr`,
`202611100002`) and the Preview deployment details (`cfb0319`) are operator-
supplied context, not independently queried facts in this session.

Read-only provider operations and preflight remain available. No database was
queried or changed, no migration was applied, no exchange order was submitted,
and no commit, push, deployment, or scheduled job was enabled.

## Bybit lifecycle finding

The adapter remains read-only. Bybit V5 documents:

- Position-level `stopLoss`, `takeProfit`, `trailingStop`, and a single
  `activePrice` for a trailing stop:
  <https://bybit-exchange.github.io/docs/v5/position/trading-stop>
- Position reads expose `stopLoss`, `takeProfit`, and `trailingStop`; the
  position response does not expose a distinct TP1/TP2 trailing-stage record:
  <https://bybit-exchange.github.io/docs/v5/position>
- Open-order records expose a trailing-stop `triggerPrice` as its activation
  price, but this represents the one configured trailing stop, not two staged
  TP1/TP2 transitions:
  <https://bybit-exchange.github.io/docs/v5/order/open-order>

Thus a single TP1-activated full-position trailing stop is documented, but
independently verified TP1 and TP2 trailing stages are not. The existing
shared lifecycle records both milestones and expects a provider implementation
to verify its protection state. It would be unsafe to advertise that contract
as fully supported by this one trailing-stop setting. Bybit order execution,
protection installation, close, and reconciliation therefore remain disabled.
The new provider-neutral `POST .../executions` contract rejects execution with
HTTP 503 before repository or exchange access while the capability is false.

### Provider capability matrix

| Provider | Environment | Read / preflight | Execution lifecycle |
|---|---|---|---|
| Binance | Demo | Read and preflight | Disabled in provider-neutral console |
| Bybit | Demo | Read and preflight | Disabled; TP1/TP2 stage verification blocker |
| OKX | Demo | Read | Disabled |
| Gate.io | Testnet | Read | Disabled |
| Bitget | — | Unsupported | Disabled |

No provider falls back to a live endpoint. The environment value `TESTNET` is
kept distinct from `DEMO`.

## Local changes made for this release audit

- Added a strict, Admin/CSRF-protected provider-neutral execution request route.
  It requires an explicit confirmation string and a limit-entry contract, then
  fails closed on the disabled lifecycle capability.
- Fixed reconciliation authorization renewal so the renewed `RECONCILE` grant
  is marked consumed at creation, matching the database authorization RPC's
  existing `consumed_at IS NOT NULL` requirement. A focused regression test
  asserts the persisted and returned state.
- Added read-only pre- and post-migration Staging queries at
  `supabase/verification/functional-staging-release-readiness.sql`.

## Migration audit

The pending sequence after the reported Staging boundary `202611100002` is:

1. `202611100003_multi_exchange_foundation.sql`
2. `202611100004_exchange_execution_defaults_disabled.sql`
3. `202611110001_strategy_profiles.sql`
4. `202611110002_binance_protection_lifecycle.sql`
5. `202611110003_binance_credential_environment_confirmation.sql`
6. `202611110004_admin_binance_demo_testing.sql`
7. `202611110005_admin_binance_demo_rpc_grant.sql`
8. `202611110006_multi_exchange_execution_defaults_disabled.sql`
9. `202611110007_admin_demo_exchange_neutral.sql`
10. `202611140001_password_recovery.sql`

Impact and safety observations:

- No pending migration deletes existing rows. Migration `100003` copies
  Binance credential ciphertext into the provider-neutral credentials table;
  it does not print or decrypt values. Migration `110003` adds an
  `environment_confirmed = FALSE` default, so copied credentials remain
  unusable until explicitly confirmed.
- The pending `100003` foundation now seeds all provider gates disabled,
  copies no automatic-execution permission into new exchange settings, forces
  `CONFIRM`, and initializes the active exchange preference to `DEMO`. Keep
  application trading traffic stopped throughout the migration window until
  the later all-row safety migration `110006` has completed and verified;
  legacy settings are intentionally not rewritten by foundation migration
  `100003`.
- `100004` updates every `exchange_provider_settings` and
  `user_exchange_trading_settings` row, setting provider gates and automatic
  execution off and mode to `CONFIRM`.
- `110006` again updates every provider/settings row and also every
  `user_strategy_settings` and `user_trading_settings` row to disabled /
  `CONFIRM`. These updates change `updated_at`; expected affected-row counts
  are the table counts captured immediately before the maintenance window.
- `110001` backfills strategy only for executions that join a signal and
  inserts missing default strategy rows. `110002` installs a stricter
  `trade_executions.execution_status` check; the baseline query must return no
  incompatible statuses before it is applied.
- `110004` creates Binance-only Admin Demo tables and an authorization
  function; `110005` grants only `service_role` execution. `110007` creates
  exchange-neutral Admin Demo tables with inactive identities, disabled
  credentials/sessions/executions, `CONFIRM` mode, RLS enabled, browser
  privileges revoked, and a service-role-only authorization RPC.
- Admin identities are not provisioned by these migrations. Provisioning and
  activation require a separate, explicit operator action for a verified
  administrator after Staging schema validation. Do not set `is_active=TRUE`
  or enable credentials until the lifecycle blocker is resolved and approval
  is recorded.
- The code defect fixed here concerns renewed authorizations only; the schema
  is unchanged. No migration was executed.

Run the baseline SQL before migration approval and the post-migration section
after an approved migration window. The script is SELECT-only and uses
read-only transactions. It intentionally reports counts and grants, never
credential contents. The existing `validate:migrations` command only validates
file/order metadata unless its localhost-only status option is explicitly
requested; it does not verify remote Staging.

## Staging backup and recovery

Before any operator-approved migration window:

1. Confirm the target is Staging project `ghecpkpaxbrvehquhzkr`, not Production.
2. Capture a Supabase backup/snapshot and verify the available point-in-time
   recovery window. Record the restore owner and recovery decision deadline.
3. Run and retain the baseline query output, especially migration versions,
   execution status distribution, duplicate-key check, strategy backfill
   count, and table row counts.
4. Apply migrations in the exact order above using the approved migration
   process; stop on any unexpected row count, constraint error, or nonzero
   safety check.
5. Run the post-migration SQL and the existing per-migration verification SQL.
6. If validation fails, stop application rollout and restore the Staging
   snapshot or use an approved forward correction. Do not hand-edit rows or
   drop tables as an ad-hoc rollback.

## Admin and Preview gates

- **Admin identity:** provision only the specifically approved Staging admin;
  verify the application admin role and identity mapping independently. Keep
  the provider-neutral identity inactive until approval. The migration itself
  creates no active identity.
- **Credentials:** credentials are stored encrypted and initially disabled.
  There is no provider-neutral credential-enable route yet. Any enablement
  requires a separate reviewed operator action after the lifecycle blocker is
  resolved; no browser route should expose ciphertext, plaintext, or
  service-role material.
- **Preview:** use the Vercel dashboard at <https://vercel.com/dashboard>, open
  project `cryptohub`, then verify the `functional-staging` Preview deployment,
  commit SHA, and Preview-scoped variables. The Preview Supabase URL and
  project reference must resolve only to `ghecpkpaxbrvehquhzkr`; explicitly
  compare them with Production project `kafsdnzzjawikoavkhvm` and stop if any
  Preview value points to Production. Do not display or copy secret values.
- **Exact readiness variables:** configure `SMARTEXIT_STAGING_SUPABASE_PROJECT_REF`,
  `SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF`, `SMARTEXIT_STAGING_PREVIEW_URL`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `AUTH_SECRET`,
  `SUPABASE_SERVICE_ROLE_KEY`, `BINANCE_CREDENTIALS_KEY`, and the server DB
  target via `SUPABASE_DB_URL`/`DATABASE_URL` or `SUPABASE_DB_HOST` plus
  `SUPABASE_DB_USER`. Vercel must report
  `VERCEL_ENV=preview`. Keep `SMARTEXIT_DEPLOYMENT_ENV=staging` consistent
  where used. Configure verification email using either `RESEND_API_KEY` and
  `MAIL_FROM`, or both `GMAIL_USER` and `GMAIL_APP_PASSWORD`.
- **Owner-only confirmations:** set
  `SMARTEXIT_STAGING_AUTH_SECRET_SEPARATE_CONFIRMED`,
  `SMARTEXIT_STAGING_DATA_SANITIZATION_CONFIRMED`, and
  `SMARTEXIT_STAGING_BACKUP_PITR_OWNER_CONFIRMED` only after the responsible
  operator verifies each condition. Keep
  `SMARTEXIT_STAGING_BINANCE_CREDENTIALS_KEY_SHA256` distinct from
  `SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256`; actual encryption
  keys remain private and must not be copied between projects.
- **Validator evidence:** `npm run validate:staging-readiness` was run in the
  local process environment and returned `READY_FOR_STAGING_REVIEW: NO`.
  `SMARTEXIT_STAGING_SUPABASE_PROJECT_REF`, production reference, Preview URL,
  Preview classification, both database targets, realtime public key,
  `AUTH_SECRET`, verification email, encryption separation, and three
  owner-confirmation gates were missing/unconfirmed there. Migration status was
  `UNKNOWN`, remote Demo status `BLOCKED`, CRON `DISABLED`, and customer gates
  `DISABLED`. This reports the local shell only; it does not prove that the
  Vercel Preview settings are missing.
- **Deployment:** the known Preview URL and `cfb0319` commit came from prior
  operator context and were not checked against Vercel in this session. A new
  Preview deployment is not authorized by this task.
- Keep `SMARTEXIT_CRON_RECONCILIATION_ENABLED` false. Exclude
  `.github/workflows/binance-protection-reconcile.yml` from any release change
  unless CRON is separately approved.
- Keep `SMARTEXIT_BYBIT_DEMO_ORDER_SUBMISSION_ENABLED` unset or false. Setting
  it true would violate the readiness gate and would not make the unsupported
  provider-neutral lifecycle available.

## Validation and release plan

Run locally before any commit:

```text
npm run typecheck
npm run lint
npm run build
npm run test:exchanges
npm run validate:migrations
```

Results for this task:

- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `npm run build` — PASS; Next.js included
  `/api/admin/demo/providers/[provider]/executions`
- `npm run test:exchanges` — PASS, 251 tests, 0 failures
- `npm run validate:migrations` — PASS for migration filenames, order, and
  verification-file presence. Database status remains UNKNOWN because no
  database was queried.
- Focused provider repository/service/route tests — PASS, 26 tests, 0 failures.

No commit is created here. When separately authorized, create a reviewable
commit on `functional-staging` containing only the reviewed SmartExit source,
test, migration, verification, and documentation changes. Exclude
`staging.txt`, `supabase/.temp/`, and the scheduled workflow. Recheck the staged
diff for secrets and unrelated files. Do not amend the existing HEAD.
Deployment target, only after separate approval: Vercel Preview for
`functional-staging`, not Production.

## First controlled Bybit Demo test

**Not ready.** Before any order is considered:

1. Decide whether one full-position trailing stop activated at TP1 and retained
   through TP2 is acceptable, or whether distinct TP1 and TP2 trailing-stage
   actions are mandatory. The latter remains unsupported by the verified
   provider contract.
2. Implement and mock-test the Bybit lifecycle and atomic authorization /
   execution reservation; prove entry idempotency, native SL/TP/trailing
   readback, TP3 full close, zero-position confirmation, stale-protection
   cleanup, and timeout reconciliation.
3. Keep the provider capability false until those tests pass and a security
   review confirms there is no Live endpoint fallback.
4. Obtain explicit approval for migrations and Preview deployment. Verify the
   Preview commit and Staging Supabase project independently.
5. Provision the one approved Admin identity and isolated Bybit Demo
   credentials; keep automatic execution and CRON disabled.
6. Perform a separate operator-approved, explicitly confirmed controlled Demo
   test with a bounded quantity and verify the audit trail and flat account.

No order can be placed through the current provider-neutral execution route;
it returns unavailable while lifecycle capability is disabled.
