# Bybit staged lifecycle: local implementation and release audit

Date: 2026-11-18. Branch: `functional-staging`. Local implementation and mocked
validation only. No exchange orders, database queries, migrations, deployment,
push, or scheduled jobs are authorized by this work.

Updated release authorization and subsequent safety fixes are recorded in
`docs/MASTER-STAGING-RELEASE-REVIEW.md`. The 293-test table below records the
earlier local validation baseline, not the latest release validation count.

## Protection contract

One full-position exchange-native stop loss, one native TP3, and one native
trailing stop armed at TP1. TP1 and TP2 are milestones, never partial exits.
An armed trailing stop is not evidence that it has activated. Readback must
establish the configured activation threshold and full-position coverage;
milestone observations must not imply a second trailing order exists.

TP2 trailing replacement is unsupported until the exchange can prove a safe,
non-loosening transition and independently confirm replacement coverage. A
request to replace it must fail closed while retaining SL, TP3, and the existing
trailing stop. Do not cancel an SL to activate or modify trailing protection.

Bybit's [trading-stop documentation](https://bybit-exchange.github.io/docs/v5/position/trading-stop)
defines full-position protection, one trailing distance, one activation price,
and exchange-managed quantity adjustment/cancellation. Its
[order documentation](https://bybit-exchange.github.io/docs/v5/order/create-order)
documents attached TP/SL and asynchronous acceptance. Neither an accepted
request nor a locally crossed threshold proves a fill, active trailing stop,
or flat account. Verify authoritative reads before recording those outcomes.

On transport failure or rate limiting, reconcile the original client ID before
considering another mutation. Never retry an uncertain entry with a new ID.
An emergency close must use the opposite side with reduce-only and the actual
confirmed position quantity; mismatched side/quantity requires operator review.
Protection cleanup follows independently confirmed zero position only.

## Pending migration chain audit

The previously reported staging boundary is `202611100002`; it has not been
queried or independently verified here. The complete pending order is:

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

`100003` was modified before application: provider seeds are disabled,
backfilled exchange settings use CONFIRM/false instead of inheriting automation,
and active preferences start in Demo. It copies encrypted Binance credentials,
retains legacy data, adds the exchange dimension to execution uniqueness, and
enables RLS with browser role privileges revoked. `ON CONFLICT DO NOTHING` does
not repair drift or mismatched existing ciphertext. An already applied version
must never be silently edited/replayed; reconcile migration history first.

`100004` disables all existing provider/exchange execution settings. `110001`
requires foundation tables, creates strategy rows, and backfills strategy from
signals. Its legacy strategy backfill can temporarily inherit automation;
trading traffic must stay stopped through `110006`, which disables legacy,
exchange, provider, and strategy execution together. `110002` constrains existing
execution statuses: incompatible rows block application rather than being
silently coerced. `110003` requires fresh environment confirmation for copied
credentials. `110004` and `110005` add isolated Binance Admin tables and a
service-role authorization grant. `110007` follows those safety migrations and
adds separate provider-neutral Admin identities, credentials, sessions,
authorizations, executions, and audits.

Provider-neutral composite foreign keys bind admin/provider/environment/session
and authorization; default identities are inactive, credentials and executions
disabled, and mode fixed to CONFIRM. RLS is enabled on all six tables, all browser
table grants are revoked, and the authorization function pins search_path and
requires service-role access. An Admin identity foreign key alone does not prove
the application administrator role: independently verify that mapping during
explicit provisioning. These migrations provision no active administrator.

No pending migration deletes application rows. Safety updates deliberately change
existing settings and timestamps. Credential copies, unique constraints, status
constraints, existing table drift, function grants, and RLS require database
verification before declaring the chain ready to apply. Static validation cannot
prove those facts or establish a successful rollback.

Use `supabase/verification/functional-staging-release-readiness.sql` for the
read-only baseline and post-migration checks, plus every paired versioned
verification file. Baseline checks cover history, unexpected pending tables,
row counts, duplicate keys, incompatible statuses, and affected-row estimates.
Post checks cover disabled defaults, identity/provisioning state, provider scopes,
RLS, grants (including sequences), and aggregate ciphertext-copy consistency.
No credential content is returned. Capture a staging backup and restore plan
before an approved maintenance window. Stop on drift, nonzero violations, or
unexpected counts. The migration validator checks files/order only; database
application status remains UNKNOWN.

## Completed implementation and validation

`lib/admin-demo-bybit-adapter.ts` and `lib/exchanges/bybit-demo.ts` implement
validated limit entry with attached initial Full SL/TP3, one-way/decimal filters,
stable client-ID recovery, singleton trailing installation/readback, explicit
unsupported TP2 updates, reduce-only full close, independent zero checks, and
flat-only cleanup. Native trailing is installed with TP1 activation; REST proves
it is armed, not that activation has occurred. Milestone state never asserts
activation from a price crossing alone.

The provider-neutral service composes the actual shared lifecycle contract with
scoped authorization, persistent execution/protection progress, monotonic TP1/TP2
timestamps, audit events, and recovery. Known missing coverage enters emergency
close; unavailable evidence records uncertainty. Authorization is checked before
each mutation. Recovery writes require the current unexpired lease token in the
same database update; stale recovery workers cannot overwrite progress. A request
already in flight cannot be revoked by lease expiry: review request/lease budgets
before any remote activation. The default server factory and remote routes still
fail closed; execution requires explicitly injected local test dependencies.

Final local results:

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS |
| `npm run test:exchanges` | PASS: 293 tests, 0 failures |
| `npm run validate:migrations` | PASS: file/order checks; DB status UNKNOWN |

The prior baseline was 251 tests; the final suite adds 42 passing cases. Coverage
includes actual adapter plus shared lifecycle composition for LONG/SHORT, entry
SL/TP3 attachment, singleton protection, TP1/TP2 observations, retained unsupported
TP2, TP3 close, native stop closure, duplicate conflicts, rejection, accepted
timeouts, restart recovery, zero-position refusal, authorization expiry, stale
leases, safe audit details, unsupported capabilities, and remote/live isolation.
All provider responses are mocked. No migrations or remote operations occurred.

## Remote execution blockers and approval sequence

Remote execution capability and order routes remain disabled. Do not enable a
flag to bypass mock-only restrictions. Before a first controlled Demo test:

1. Review local code/test evidence and accept retaining the TP1 trailing stop at
   TP2. A required TP2 replacement remains unsupported.
2. Separately approve staging-only read-only baseline checks, then the exact
   migration chain during a backed-up maintenance window. Verify post checks.
3. Separately approve the reviewed Preview release and verify its staging target,
   secret separation, and disabled customer/live/automatic/CRON gates.
4. Provision only the verified Admin identity and isolated Demo credential under
   separate approval, with a bounded symbol/quantity and explicit confirmation.
5. Review a dedicated transport-enablement change and authorize one controlled
   Demo lifecycle test, including recovery ownership and post-test flat account.

Estimated remaining engineering before that first test: 2–4 engineer-days for
real readback compatibility, bounded transport enablement, staging reservation/
lease verification, rejection/recovery drills, and release review. This excludes
operator approval and provisioning wait time; TP2 replacement research is extra.
