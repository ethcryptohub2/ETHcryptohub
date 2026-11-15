# Binance Demo lifecycle harness

The reusable harness is in `lib/binance-demo-lifecycle-harness.mjs`. It produces one sanitized result row per lifecycle case with test type, environment, symbol, direction, expected/actual state, exchange and DB verification, PASS/FAIL/BLOCKED, and allowlisted evidence.

## Test classifications

- `MOCKED_UNIT`: controlled in-memory adapter only; no Binance or database request.
- `LOCAL_INTEGRATION`: an explicitly supplied local integration adapter; the report labels this mode and does not call it remote verification.
- `REMOTE_BINANCE_DEMO`: only the fixed Binance Demo endpoint and a dedicated Demo credential may be used. The harness requires an independent authorization flag, explicit operator confirmation, One-way preflight, confirmed-disabled customer execution gates, and explicit proof no Live endpoint/credential was selected.

The cases cover initial SL, TP3 conditional order, dormant trailing order, TP1, TP2, TP3 closure, zero position, protective cleanup, LONG/SHORT directions, restart recovery, timeout recovery, duplicate-event idempotency, and Emergency Stop. An adapter must verify the actual exchange state and the matching database state for every case; otherwise the result cannot be PASS.

## Current limitation and safe usage

This repository currently has no trusted Binance lifecycle test adapter that drives the existing SmartExit execution path end-to-end and proves matching DB state. The Admin Binance Demo preflight is read-only. Therefore the harness unconditionally returns **BLOCKED** for remote lifecycle cases—even if a caller supplies a mock object that claims exchange/DB verification. This avoids turning caller-provided assertions into a false remote pass. Do not treat the current mocked unit tests as remote testing.

Customer protection installation and production reconciliation now use the same injected lifecycle state machine in `lib/execution-lifecycle.ts`. The production reconciliation adapter still binds to the real database and credential-backed Binance Demo client; the automated lifecycle tests use fake ports and do not exercise that remote adapter.

The shared lifecycle now also has an injected `submitAndProtectEntry` operation with idempotent reservation, lookup-before-retry, uncertain timeout handling, partial-fill cancellation/actual-quantity protection, and post-entry position verification. Offline fake-port tests cover it. The Admin-only wrapper can call this generic core, but the operation is not connected to production adapters. Migrations `202611110004_admin_binance_demo_testing.sql` and `202611110005_admin_binance_demo_rpc_grant.sql` define isolated Admin Demo records and the server-only function grant; they are un-applied. `lib/admin-demo-supabase.ts` is a fail-closed server-only RPC adapter but has no execution-route caller. The Admin repository, credential-bound fixed Demo adapter, and Admin execution route are not integrated. No Admin test record may be written to customer `trade_executions`. Customer execution remains deliberately rejected by the strategy service until remote lifecycle verification. Remote testing remains blocked pending migration approval/application, an Admin-only adapter/repository and service integration, staging configuration, and owner approval.

The Admin page intentionally presents Binance remote lifecycle testing as blocked and does not offer a working Start control. The older Bybit Admin lab is separate and does not validate Binance's shared lifecycle.

Nothing invokes the harness on application startup, build, or deploy. Do not set `BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED` for routine deployment. A future remote invocation must be a deliberate operator action and must pass all checks, including:

- `BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED=true` for the single approved test window.
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
