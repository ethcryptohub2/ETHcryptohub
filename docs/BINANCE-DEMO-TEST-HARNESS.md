# Binance Demo lifecycle harness

Release note (2026-11-18): remote Admin Demo execution is hard-disabled by the
Preview release policy, including valid staging targets with explicit request
confirmation. The workflow file is excluded from the reviewed release. The
instructions below describe future separately approved operations, not actions
enabled by this release. Current evidence is in MASTER-STAGING-RELEASE-REVIEW.md.

The reusable harness is in `lib/binance-demo-lifecycle-harness.mjs`. It produces one sanitized result row per lifecycle case with test type, environment, symbol, direction, expected/actual state, exchange and DB verification, PASS/FAIL/BLOCKED, and allowlisted evidence.

## Test classifications

- `MOCKED_UNIT`: controlled in-memory adapter only; no Binance or database request.
- `LOCAL_INTEGRATION`: an explicitly supplied local integration adapter; the report labels this mode and does not call it remote verification.
- `REMOTE_BINANCE_DEMO`: only the fixed Binance Demo endpoint and a dedicated Demo credential may be used. The harness requires an independent authorization flag, explicit operator confirmation, One-way preflight, confirmed-disabled customer execution gates, and explicit proof no Live endpoint/credential was selected.

The cases cover initial SL, TP3 conditional order, dormant trailing order, TP1, TP2, TP3 closure, zero position, protective cleanup, LONG/SHORT directions, restart recovery, timeout recovery, duplicate-event idempotency, and Emergency Stop. An adapter must verify the actual exchange state and the matching database state for every case; otherwise the result cannot be PASS.

## Current limitation and safe usage

This repository currently has no trusted Binance lifecycle test adapter that drives the existing SmartExit execution path end-to-end and proves matching DB state. The Admin Binance Demo preflight is read-only. Therefore the harness unconditionally returns **BLOCKED** for remote lifecycle cases—even if a caller supplies a mock object that claims exchange/DB verification. This avoids turning caller-provided assertions into a false remote pass. Do not treat the current mocked unit tests as remote testing.

Customer protection installation and production reconciliation use the injected lifecycle state machine in `lib/execution-lifecycle.ts`. The production reconciliation adapter binds to the real database and credential-backed Binance Demo client; lifecycle tests use fake ports and do not exercise that remote adapter.

The shared lifecycle has an injected `submitAndProtectEntry` operation with idempotent reservation, lookup-before-retry, uncertain timeout handling, partial-fill cancellation/actual-quantity protection, and post-entry position verification. The Binance Admin Demo service, repository, credential-bound Demo adapter, protected API routes, and console are connected to that lifecycle. Admin execution records are isolated from customer `trade_executions`; the mocked integration suite exercises the complete lifecycle offline. The staging migration chain is still unapplied, so remote Admin Demo use must remain blocked until the schema is reviewed and applied to Staging and the post-migration checks pass. No multi-exchange Admin Demo adapters are implemented; the existing Bybit Demo adapter is a separate testing lab.

Nothing invokes the lifecycle harness on application startup, build, or deploy. The harness's `BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED` flag is for the harness only; deployment validation rejects it when true, and the Admin Demo service also rejects a persistent true value. The Admin service uses separate controls: owner-confirmed dedicated credentials, an atomically consumed `START_TEST` authorization, approved Staging target verification, explicit operator confirmation, and disabled customer/Live gates. Reconciliation recovery requires a fresh, time-limited `RECONCILE`-only authorization; it cannot start a new session. A future remote harness invocation remains a deliberate operator action and must pass all checks, including:

- `BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED=true` in the trusted harness process only; never persist it in Vercel Preview or Production.
- Explicit confirmation value `RUN_BINANCE_DEMO_LIFECYCLE`.
- `preflight.environment=DEMO`, fixed endpoint `https://demo-fapi.binance.com`, `credentialSource=DEDICATED_BINANCE_DEMO`, and `positionMode=ONE_WAY`.
- `customerExecutionEnabled=false`; all customer `BINANCE_FUTURES_*` gates remain unset/false.
- Explicit `liveEndpointSelected=false` and `liveCredentialSelected=false`.
- A remote adapter whose `kind` is `remote-binance-demo`.

The remote flag is not a trading gate and does not unlock customer execution. It is an additional necessary condition, not sufficient authorization by itself.

## Manual reconciler invocation

Do not invoke this as part of setup. After the owner separately approves staging and the Preview target, use the Preview deployment's configured staging `CRON_SECRET` in a trusted shell and manually call the protected route:

```powershell
$headers = @{ Authorization = "Bearer $env:CRON_SECRET" }
Invoke-RestMethod -Method Get -Uri "$env:SMARTEXIT_CRON_BASE_URL/api/cron/binance-protection" -Headers $headers
```

Set `SMARTEXIT_CRON_BASE_URL` only to the independently verified Preview URL. Do not print either secret or run the command against Production. The reconciliation route may close a position if it detects missing protection, so this is an operational action, not a harmless health check. Verify unauthorized requests are rejected in a local test before manually invoking it. The five-minute GitHub workflow has `workflow_dispatch`, but its configured URL/secrets must be staging-only before dispatch.

Remote Demo orders, migrations, CRON calls, and deployment actions were not executed while preparing this harness.
