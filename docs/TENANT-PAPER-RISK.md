# Tenant paper execution and independent risk foundation

This is local, deterministic paper infrastructure. It cannot submit an exchange order: no exchange transport, credential field or exchange API client is present. Remote activation and persistent-worker operation remain disabled pending separate approval and integration review. Simulated balances/fills are not real account balances or exchange performance.

## Components and integration

- `lib/intelligence/risk-governor.ts`: `evaluatePaperRisk`, `defaultPaperRiskPolicy`, `validatePaperRiskPolicy`.
- `lib/intelligence/tenant-paper.ts`: `TenantPaperService`, `MemoryPaperJournal`, `defaultPaperConfiguration`, `verifyPaperDatabaseIsolation`.
- `lib/intelligence/paper-journal.ts`: `AtomicFilePaperJournal` for an approved persistent local/worker disk. Never use it as durable storage on Vercel's ephemeral filesystem.

Every service method requires `PaperActor {userId, tenantId}` with positive safe integers and strict equality. A server must derive both values from its authenticated session; accepting tenantId/userId from a request is prohibited. There is no cross-customer administrator impersonation shortcut. The journal is an internal dependency, not a public API.

Modes are OBSERVE, CONFIRM and PAPER_AUTOPILOT. OBSERVE records evidence without reserving risk and pauses further fills on existing reservations/partial positions; fresh risk-reducing closes remain possible. CONFIRM requires `CONFIRM_PAPER:<idempotencyKey>` and fresh risk validation when confirmed. PAPER_AUTOPILOT reserves simulated exposure only. LIVE_AUTOPILOT is rejected even when passed through untyped JavaScript. No remote enabling flag is added by this module.

Configurations hold paper venue, simulated initial equity and explicit strategy/risk preferences. There are no API keys, secrets or free-text credential fields. Unknown config/policy/intent properties reject before persistence. Initial capital cannot later be reset to hide losses. Idempotency keys bind the exact normalized intent plus signal ID; retries return the original record, while a reused key with a different intent rejects.

## Risk authority

The governor ignores scores/narrative for authorization. Any deterministic rejection overrides READY_FOR_RESEARCH, including stale/future/invalid market timestamps, sequence gaps, unavailable provider, invalid quotes, expired signal, excluded symbols, disallowed strategies, stop direction, per-trade risk, portfolio notional, conservative correlated exposure, daily loss, drawdown, concurrent reservations, margin, leverage, estimated liquidation distance, duplicate reservation, kill switch or repeated-loss cooldown.

All crypto exposures are treated as correlated until a separately reviewed statistical matrix exists; caller-selected labels cannot reduce that limit. Caller liquidation estimates are capped at a conservative `75/leverage` percentage and must remain beyond the stop. This is a paper safety approximation, not an exchange maintenance-margin/liquidation model, and must not be used to enable real trading.

Reservations consume full planned margin/exposure before fills. `fill(actor, orderKey, fillId, quantity, market, now, feeBps)` requires a bounded durable fill identity. The identity binds quantity, fees and the source quote; identical timeout/restart retries return the original acknowledgement without another fill, fee or audit event. A conflicting reuse rejects. Legacy journals without fill identities fail closed rather than guessing which fills were applied. Partial fills use only observed bid/ask, cannot exceed remaining quantity, enforce the limit price, charge explicit fees and rerun risk checks including signal expiry. Existing filled exposure is marked using fresh quotes when adding risk; losses count against daily/drawdown gates. Multi-symbol filled portfolios without a full fresh mark set currently fail closed. Kill switch blocks new reservations/fills but permits a fresh quote to close existing simulated exposure. Stale close quotes reject; a kill switch never invents a liquidation price.

## Durability and restart behavior

The memory journal is test/local process scope only. The file journal hashes tenant IDs into filenames, uses a per-tenant exclusive lock, writes and fsyncs a restrictive temporary file, then atomically renames it. Callback failure does not persist a partial state. Order reservation, fills, history, risk evidence, safety controls and audit sequence are stored together. A new service instance reads the same reservation and cannot create it again. Lock contention fails closed; a leftover crash lock requires an operator to establish no live writer before removing it. No automatic stale-lock deletion risks a second live writer. Disk/power-loss guarantees still depend on the approved filesystem; this is not a distributed database journal.

Each tenant is bounded at 10,000 records / 50,000 audit events. Reaching capacity rejects further changes rather than silently deleting risk/idempotency history. Retention/export is a separately reviewed operational process. Unknown/corrupt/wrong-tenant journal data rejects. No journal directory is created until the explicitly constructed file adapter is used.

## RLS and remote database readiness

No migration or database write was executed. No RLS-backed production datastore is claimed. `verifyPaperDatabaseIsolation` matches the actual two-table review draft: private `paper_account_states` and shared `research_decisions`. Both require explicit enabled and forced RLS metadata plus no browser-role grants. Only `paper_account_states` requires a tenant ownership constraint; shared research must not invent customer ownership. Missing, ambiguous or incomplete evidence rejects. The local journal's actor tests are not proof of database RLS.

Future approved database integration must first resolve the app's integer user IDs versus Supabase Auth UUID identity bridge. Do not pretend `auth.uid()` equals public.users.id. Prefer a service-only repository with session-derived ownership on every read/write and composite tenant/execution constraints; independently inspect table policies, grants, sequences and any RPC grants. Browser PUBLIC/anon/authenticated access must be absent until a verified identity-aware RLS design is reviewed. SQL metadata evidence can be obtained read-only from pg_class.relrowsecurity, pg_constraint and information_schema grants, then supplied to the verifier. Its successful result is necessary metadata evidence, not by itself proof that arbitrary backend SQL cannot leak users' rows.

Activation requires a separately reviewed persistent store/backup/retention design, role/RLS verification, authenticated routing, trusted market marks and operational kill-switch ownership. Existing real-money/customer/Demo execution gates remain untouched. Missing schema does not justify bypassing the remote-disabled boundary.

## Tests and honest limits

Focused tests exercise every governor guard, high-score override rejection, long/short risk, cooldown, tenant denial, clone isolation, OBSERVE/CONFIRM/disabled Live behavior, unknown credential-field rejection, parallel idempotency, pre-fill reservation accounting, partial fills, fees, closes, expiry, kill behavior, unrealized loss, unmarked cross-symbol rejection, actual temporary-file restart/crash-lock recovery and RLS metadata rejection.

No actual exchange fill, real customer trading, liquidation model certification, distributed locking, worker activation or database RLS deployment has been demonstrated. The current one-quote service conservatively blocks additional risk if another filled symbol lacks a fresh mark. The replay module supplies broader historical simulation; these paper execution records remain separate from actual exchange execution.
