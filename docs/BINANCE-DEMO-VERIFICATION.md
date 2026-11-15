# Binance USDⓈ-M Futures Demo verification

## Status and safety boundary

The current protection lifecycle has mocked tests only. No Binance order is placed by the Demo preflight, and no part of this document asserts successful remote Demo verification. Keep `BINANCE_FUTURES_TRADING_ENABLED`, `BINANCE_FUTURES_DEMO_TRADING_ENABLED`, and `BINANCE_FUTURES_DEMO_VERIFIED` unset or `false`. Keep Live approval disabled.

The preflight is an Admin-only, read-only endpoint:

```text
GET /api/admin/binance/demo-preflight?environment=DEMO&symbol=BTCUSDT&quantity=0.001
```

It reads only the Binance credential row for the authenticated administrator's `DEMO` environment and uses the fixed `https://demo-fapi.binance.com` endpoint. It does not accept credentials or an endpoint from the request. It checks account `canTrade`, One-way position mode, USDT perpetual eligibility, tick size, `LOT_SIZE`, `MARKET_LOT_SIZE`, mark-price notional, and the reported minimum notional. `ordersPlaced` is always `false`. A `ready` result means these read-only preconditions passed; it does not prove that any order/protection request is compatible or that an order was accepted.

This design prevents the application from selecting its `LIVE` credential row or URL during preflight. It cannot independently establish where an operator originally generated a key if the same key was manually copied into the Demo credential row. Store only Binance Demo-issued credentials there. Never submit production credentials to the preflight or any test.

## Binance API compatibility audit

Official references used for the API contract:

- [USDⓈ-M Futures New Algo Order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Algo-Order)
- [Query Algo Order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Query-Algo-Order)
- [Current All Algo Open Orders](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Current-All-Algo-Open-Orders)
- [Cancel Algo Order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Cancel-Algo-Order)
- [Official Binance Futures Python connector order method](https://github.com/binance/binance-futures-connector-python/blob/main/binance/um_futures/account.py)

The conditional Algo API contract is distinct from standard `/fapi/v1/order`: use `/fapi/v1/algoOrder` for submission/query/cancel and `/fapi/v1/openAlgoOrders` for active Algo orders. Close-all STOP_MARKET and TAKE_PROFIT_MARKET orders use `triggerPrice` and `closePosition=true` without `quantity` or `reduceOnly`. TRAILING_STOP_MARKET uses `activatePrice`, `callbackRate=1` (one percent, range 0.1–20), full position quantity and `reduceOnly=true`. Under One-way Mode the close side is SELL for LONG and BUY for SHORT, with `positionSide=BOTH`; TP1 activation is rounded above the current mark for LONG and below it for SHORT.

| Operation | Current code path | Audit result |
|---|---|---|
| Initial STOP_MARKET | `POST /fapi/v1/algoOrder`, `triggerPrice`, `closePosition=true`, `positionSide=BOTH` | Payload is now built by a strict schema; quantity and reduceOnly are excluded. The response is queried by Algo ID/client Algo ID and fully checked before protection is accepted. |
| TP3 TAKE_PROFIT_MARKET | `POST /fapi/v1/algoOrder`, `triggerPrice`, `closePosition=true`, `positionSide=BOTH` | Same close-all payload constraints as the initial stop. |
| TP1-armed trailing stop | `POST /fapi/v1/algoOrder`, `activatePrice`, `callbackRate=1`, full quantity, `reduceOnly=true`, `positionSide=BOTH` | The incorrect `activationPrice` request and non-contract `priceRate` response fallback were removed. The response must match activation, rate, quantity, side, type, status and position mode. |
| Algo query/open/cancel | `GET /fapi/v1/algoOrder`, `GET /fapi/v1/openAlgoOrders`, `DELETE /fapi/v1/algoOrder` | Query and cancel use `algoId` (or `clientAlgoId` when POST outcome is unknown). Open order reconciliation requires one unique matching active order and verifies all expected protection fields. |
| Market entry and reduce-only close | `POST /fapi/v1/order` | Uses the standard order endpoint, not the Algo endpoint. Existing execution explicitly rejects Hedge Mode; Algo conditional protection is explicitly `positionSide=BOTH` for One-way Mode. |
| Precision and minimums | `exchangeInfo` symbol filters | Preflight reports tick size, LOT_SIZE, MARKET_LOT_SIZE, and minimum notional for the chosen quantity. This does not replace server-side validation immediately before a real order. |

**Remaining release blocker:** mocked HTTP responses verify implementation conformance to the documented contract, not Binance Demo's current runtime acceptance. Keep order gates disabled until an explicitly approved controlled Demo test exercises each lifecycle request and verifies exchange state.

## Controlled lifecycle test matrix

All rows below are future, explicitly approved **Demo-only** order tests. Use a dedicated Demo account with no unrelated positions or orders, a staging database, and a single operator. Capture sanitized request/response evidence; never retain signatures, API keys, or secrets. Do not run these tests against Live.

| Test | Preconditions | Expected request / exchange state | Expected DB state | Failure handling and pass evidence |
|---|---|---|---|---|
| Initial SL | Preflight ready; no open position; approved small Demo test | Filled entry followed by a full-position close-all STOP_MARKET conditional using the corrected Algo payload. | `ENTRY_FILLED` until queried order and position are exchange-confirmed; then `PROTECTED`. Store actual `algoId`. | If rejected, timed out, or unqueryable, do not claim protection; retain all possibly accepted orders, stop entries, reconcile by `clientAlgoId`, and capture sanitized rejection/order query plus matching DB row. |
| Dormant trailing order | Initial SL verified; TP1 not reached | One full-size reduce-only trailing stop with TP1 activation, callback 1%; remains pending/dormant before activation. | `PROTECTED`, then `TRAILING` only when observed activation conditions meet the implemented rule. | No inferred internal trailing trigger price. Pass requires official query showing correct active conditional, activation and callback fields, full quantity, and unchanged position. |
| LONG TP1 | LONG position and initial protection verified; mark below TP1 | No close order at TP1; trailing protection activates at TP1 with correct tick rounding. | Position quantity unchanged; `tp1_reached_at` set once; `protection_status=TRAILING`. | Any reduction or missing/uncertain trailing order fails; preserve protection and reconcile. Capture before/after positions, orders, mark and DB row. |
| SHORT TP1 | SHORT position and protection verified; mark above TP1 | No close order at TP1; directionally correct trailing activation. | Position quantity unchanged; TP1 timestamp set once; trailing status. | Same as LONG; prove negative position amount remains unchanged. |
| LONG/SHORT TP2 | Corresponding position has crossed TP1 and TP2 | No close or partial exit. Keep existing 1% trailing order; never replace it with a looser stop. | TP2 timestamp set once; still-open execution, same full quantity and protection IDs unless an exchange-confirmed safe update is needed. | Compare protection before/after and confirm no duplicate order or weaker protection. Missing protection fails closed. |
| TP3 full close | Valid full-size position with exchange-side protection | Submit at most one reduce-only full-remaining-quantity market close using the persisted client order ID. | Remain open/failed until exchange position is queried as exactly zero; only then set `CLOSED`. | API success alone is not pass. Capture terminal order status and a subsequent zero-quantity position response. Uncertain outcome: query same ID; never blind-retry. |
| Zero-position confirmation | Close or TP3 order is terminal | Query actual position and require exact zero before cleanup. | `CLOSED` only after zero is confirmed. | Nonzero, malformed, or unavailable position keeps the execution open/failed and all protective orders retained. |
| Protective cleanup | Exchange confirms exact zero | Cancel only the execution's known obsolete Algo order IDs/client IDs; re-query open Algo orders. | Closed state only after cleanup result is reconciled; record cleanup failure explicitly. | On cancel timeout/rejection or lingering order, query again; do not report cleanup success. Evidence is zero position plus absence of those IDs. |
| Partial entry fill | Demo order partially fills | Cancel the remaining entry quantity, re-query its terminal state and actual position, install/verifiably maintain protection or reduce-only close the actual residual. | Never mark `PROTECTED` for the requested quantity if exchange quantity differs. Record partial/failed recovery. | No reversal or duplicate entry. Evidence includes cancel/query results and actual residual quantity. |
| Duplicate reconciliation | Same execution selected by overlapping invocations | Only one worker claims its row lock; same client order IDs are reused for any known close recovery. | One lock token owns the row at a time; no duplicate close/order IDs. | Simultaneous test must show one claim and one skipped worker. Keep protection if lock or exchange outcome is uncertain. |
| API timeout/retry | Use a controlled network fault before/after a Demo request | On unknown POST outcome, query by the same client Algo/order ID. Never submit a second order merely because the response timed out. | Store pending/failure state until exchange reconciliation; no false protection/closure. | Prove one submission in request logs and query outcome; if query unavailable, stop and retain protection. |
| Restart/recovery | Persist execution/order IDs, then stop worker between exchange action and DB update | Restart reconciler queries existing exchange order and position before any recovery action. | Reconcile from exchange-confirmed state; clear lease after processing or let its 75-second lease expire after a crash. | Never assume absent based on a network timeout. Capture pre/post restart DB, lock and exchange state. |
| Emergency stop | Active protected Demo position; stop flag enabled | New entries are rejected. Existing SL/TP/trailing orders remain untouched; no blind cancel or automatic flatten. | Record the emergency-stop reason/result; existing execution remains protected/open until normal reconciliation. | If protection cannot be verified, report failure and escalate; do not disable protection. Evidence: rejected entry, unchanged open protection, audit/history row. |
| LONG and SHORT filters | Separate clean Demo test runs | Round stop/TP/activation in the direction required by tick size; validate quantity step/min/max and mark notional before submission. | Persist exact exchange-accepted values and actual filled quantity. | Reject invalid filters before order placement. Record `exchangeInfo`, preflight, and accepted order query. |

For TP1/TP2, current code uses a native trailing-stop order whose callback rate is `1` (one percent). The code does not obtain Binance's changing internal trailing trigger price or an exact exchange event timestamp from the current query path; do not describe the returned activation threshold as the current trailing stop price.

## Reconciler and five-minute schedule

- The route is `GET /api/cron/binance-protection`, requires `Authorization: Bearer <CRON_SECRET>`, and returns 401 when missing or wrong. Do not expose the secret in logs, tickets, or URLs.
- The reconciler selects only `exchange='BINANCE' AND environment='DEMO'`. It creates adapters from each row's DEMO credential entry and has no Live fallback.
- Each row is claimed with a database lock token and 75-second lease. Competing invocations must atomically claim only one row. The lease is released in `finally`; after process termination it becomes claimable after 75 seconds.
- The GitHub Actions workflow serializes its own invocations. Its `workflow_dispatch` and scheduled route calls are state-mutating: a missing protection can initiate a reduce-only recovery close. Do not run an authorized invocation against any staging database with unreviewed open execution rows.
- To test schedule configuration, first use a separate Preview deployment and staging Supabase project, keep order gates off, verify the staging table has no open execution rows, configure Preview `CRON_SECRET`, and set the Actions secret `SMARTEXIT_CRON_BASE_URL` only to that Preview URL. Send one unauthenticated request and verify 401. Only after separately approving a controlled Demo reconciliation, dispatch the workflow manually; verify workflow success, HTTP response, one lock claim per row, and sanitized DB state. Wait through two five-minute intervals to observe scheduled dispatches; GitHub may delay schedules. Disable the workflow/secret immediately after the staging exercise.
- Never point the scheduled workflow at Production as part of this verification. Its `curl` call has a 110-second client timeout while the Next route is capped at 60 seconds; per-row API calls are sequential, so monitor returned processed counts and avoid assuming every backlog is completed in one invocation.

## Migration review and staging-only procedure

Relevant dependency chain:

1. `supabase/migrations/202611100001_live_futures_trading.sql` — baseline settings and execution tables.
2. `supabase/migrations/202611100002_binance_demo_environments.sql` — environment-specific Binance credentials/settings and Demo/Live execution uniqueness; requires the prior trading tables.
3. `supabase/migrations/202611100003_multi_exchange_foundation.sql` — exchange credentials/preferences/settings/provider events, copies existing Binance credentials/settings, adds exchange/environment columns and uniqueness; requires the prior tables.
4. `supabase/migrations/202611110001_strategy_profiles.sql` — independent strategy profiles and execution metadata; explicitly requires 003.
5. `supabase/migrations/202611110002_binance_protection_lifecycle.sql` — lifecycle IDs/locks/status index; explicitly requires 003 and 110001.

The migrations are additive and do not delete existing Binance rows. Migration 003 copies encrypted Binance credential ciphertext and settings into new exchange tables with `ON CONFLICT DO NOTHING`, leaving original records intact; it changes the execution unique constraint to `(user_id, signal_id, exchange, environment)`. Migration 110001 copies settings to a disabled Standard profile and seeds disabled High-Risk profiles; `max_open_positions` and `max_daily_loss_percent` remain unset until explicitly configured. Migration 110002 adds order IDs, lifecycle timestamps, and reconciliation lock columns. Back up the entire staging database and record Binance credential/settings/execution counts before applying. Review the exact SQL and schema before applying each file, one at a time, in order; stop on any error.

RLS is enabled on the foundation tables and strategy profiles; SQL grants are revoked from `anon`/`authenticated`, and the strategy table also defines self-ownership JWT policy. Existing `trade_executions` retains its owner-read policy. Confirm the server connection role and staging RLS behavior before testing. No migration has been applied by this task.

**Rollback:** do not drop tables/columns or restore only the application after writing new strategy/execution data. With no post-migration writes, restore a verified pre-migration staging snapshot and deploy the matching app release. With post-migration writes, keep order routes disabled and use a reviewed forward migration or restore a reviewed snapshot after preserving required data. Never apply this migration chain to Production without separate explicit approval.

## Evidence classification

- Automated tests below are local mocked tests; no order endpoint or Supabase migration is invoked.
- The Admin preflight is read-only and makes signed Demo account GETs plus public market-data GETs only.
- Actual remote Binance Demo order/protection verification is still required and is not authorized by this task.
- Production readiness/customer execution unlock remains blocked until all matrix cases pass in Binance Demo, CRON/recovery behavior is verified in staging, and a separate release approval is given.
