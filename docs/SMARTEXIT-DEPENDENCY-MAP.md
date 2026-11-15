# SmartExit implementation dependency map

This map describes the current code paths; it is not evidence that any database migration has been applied or any exchange operation has been remotely verified.

## Trading and protection

```text
Customer/API execution requests
  -> app/api/trading/execute/route.ts
  -> lib/trading-execution.ts
       -> lib/execution-lifecycle.ts (injected customer protection lifecycle)
       -> lib/strategy-routing.ts (signal-to-strategy mapping)
       -> lib/strategy-management.ts (per-user/per-strategy profile and safety checks)
       -> lib/binance-futures.ts (per-user/environment credentials, fixed endpoint, signed requests)
       -> lib/binance-algo-orders.ts (Algo payload validation, submit/query/open/cancel/verification)
       -> lib/binance-protection-lifecycle.ts (close verification, protection cleanup, trailing rules)
       -> lib/db.ts (execution persistence and reconciliation lease updates)

Scheduled reconciliation
  -> .github/workflows/binance-protection-reconcile.yml
  -> app/api/cron/binance-protection/route.ts (CRON auth)
  -> lib/trading-execution.ts::reconcileBinanceDemoProtection
  -> lib/execution-lifecycle.ts::reconcile (same protection/closure state machine)
  -> the same Binance credential, Algo-order, protection lifecycle, and DB paths above
```

Customer execution remains blocked independently of environment variables: `executeSignal` requires the execution gate, while `requireExecutableStrategy` still rejects customer execution pending remote lifecycle verification. High-Risk execution is separately unsupported. Do not remove either block to make tests pass.

## Credentials and deployment identity

```text
Credential UI/API
  -> Binance API / exchange credential route
  -> encrypt via BINANCE_CREDENTIALS_KEY
  -> user + exchange + environment database row
  -> environment_confirmed must be true before either credential loader decrypts/uses it

Build/deployment checks
  -> scripts/validate-deployment-env.mjs
  -> scripts/deployment-environment.mjs
  -> fixed Demo source mapping + project-reference/key/gate checks

Offline staging report
  -> scripts/staging-readiness.mjs
  -> reports supplied identities and owner attestations only; no network or DB access
```

Environment confirmation is not proof of API-key issuance origin. Binance Demo testing requires a dedicated Demo-issued key entered into the Demo slot. No credential value is returned to the browser.

## Migration dependencies

```text
202611100001_live_futures_trading.sql
  -> 202611100002_binance_demo_environments.sql
  -> 202611100003_multi_exchange_foundation.sql
  -> 202611110001_strategy_profiles.sql
  -> 202611110002_binance_protection_lifecycle.sql
  -> 202611110003_binance_credential_environment_confirmation.sql
  -> 202611110004_admin_binance_demo_testing.sql
  -> 202611110005_admin_binance_demo_rpc_grant.sql
```

The verification counterparts live in `supabase/verification/` and are not migration inputs. `npm run validate:migrations` only inspects filenames/layout and always leaves database status `UNKNOWN`.

Password recovery is a separate authentication migration: `202611140001_password_recovery.sql`. Its Staging ledger status is unknown until checked remotely.

## Shared lifecycle and remote-test boundary

`lib/execution-lifecycle.ts` owns the injected entry-result, protection-installation, and reconciliation state machine. Customer execution currently calls it for protection installation after the existing customer authorization, release, strategy, risk, and environment checks; the legacy customer entry submission/recovery flow remains in `trading-execution.ts`. Production Binance Demo reconciliation delegates its protection verification, TP progression, close/zero-position verification, and cleanup decisions to the shared state machine while retaining its existing entry-order recovery and lock-token-scoped repository writes. The new generic `submitAndProtectEntry` seam is unit-tested with fakes but has not replaced either production entry adapter.

`createAdminDemoExecutionLifecycle` is a separately authorized entry-point wrapper over that same state machine. The Admin Demo API routes call `createProductionAdminDemoExecutionService`, which wires the owner-scoped repository, dedicated Demo credential loader, fixed Binance Demo adapter, and service-role authorization RPC adapter. Routes require an Admin session and CSRF validation. Migrations 004–005 define the dedicated Admin Demo storage and authorization RPC grant; their Staging ledger status is unknown until checked remotely. Do not route Admin actions through customer `trade_executions`.

Customer execution remains independently blocked pending approved remote verification. The Admin wrapper does not alter that gate. Admin Demo remote verification remains `BLOCKED` until the Staging ledger confirms migrations 004–005, a dedicated Demo credential and isolated test account are configured, and the owner separately approves a remote Demo lifecycle test. Staging configuration and test results remain unverified. No external operation or remote test has occurred.
