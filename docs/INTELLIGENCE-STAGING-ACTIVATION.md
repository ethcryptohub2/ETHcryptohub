# Intelligence and paper foundation: implementation versus activation

This release adds local market ingestion, deterministic research/risk and paper replay modules. It does not start a worker, schedule, remote paper account or exchange order. The authenticated research workspace reports actual saved snapshot coverage and explicitly labels the continuous worker inactive. It never displays test fixture prices as current market data.

## Current Staging database boundary

Read-only inspection on 19 November 2026 IST: 15 applied migrations; password recovery, provider-neutral identity and credential tables absent; users 2, legacy settings 2. The existing ordered chain and verification are in `STAGING-PREVIEW-BUGFIX-ACCEPTANCE.md` and `supabase/verification/functional-staging-release-readiness.sql`. Neither schema nor grants were changed.

The first nine pending files remain, in order: 100003 multi-exchange foundation; 100004 disabled defaults; 110001 strategy profiles; 110002 protection lifecycle; 110003 credential environment confirmation; 110004 Admin Demo harness; 110005 RPC grant; 110006 disabled defaults; 110007 provider-neutral Admin. Prefixes are 202611. `202611140001_password_recovery.sql` follows separately if password recovery is approved. Apply exact reviewed files one at a time only after a verified restorable Staging backup/PITR point and restore access. Do not blindly dbpush or repair the application-time ledger. Paired SELECT-only verification checks cover dependency order, RLS/grants, disabled/CONFIRM defaults and preserved ciphertext. Existing observed backfill impact: 2 legacy settings, expected 5 disabled providers/4 exchange settings/4 strategy profiles; repeat counts before applying.

Backup/PITR readiness has not been independently proved by connected metadata. Approval requires a recovery timestamp/window and an operator authorized to restore **Staging only**. Failed migrations stop the chain. Recovery is a separately approved pre-change restore or reviewed forward fix, not destructive inverse SQL. Admin identity provisioning and credential enablement are distinct later operations.

## Private paper storage draft

`supabase/plans/intelligence-paper-foundation.sql` is deliberately outside automatic migration discovery and has **not** been executed. It proposes credential-free per-tenant JSON journals and shared research evidence in a private schema, RLS enabled/forced and browser roles denied. Run `supabase/verification/intelligence-paper-readiness.sql` read-only to distinguish absence from installed policy state. No claim is made that unapplied RLS has been tested against rows.

Existing authentication uses custom numeric app identities, not a Supabase `auth.uid()` mapping. Do not invent a UUID-to-customer mapping or allow a browser to set a tenant session variable. A future database journal adapter must derive tenant ID from verified server identity, lock one tenant row transactionally and compare revisions. Privileged database roles bypass RLS, so explicit application authorization remains necessary. Remote paper remains hard-disabled until that adapter, privileges and migration are reviewed. Atomic local file journals belong on persistent worker disks, never Vercel ephemeral storage.

## Exact activation decisions still required

1. Approve a dedicated persistent worker host, public feed connections, selected depth/trade coverage, storage, retention, monitoring, restart policy and resource/rate budgets. Review official endpoint versions in the worker document. Do not run a permanent WebSocket process in Vercel request handlers.
2. Approve the applicable Staging migration list and private storage design only after backup/recovery evidence; repeat ciphertext inventory. No credential rotation is bundled with this release.
3. Review a transactional durable database journal and account-to-tenant authorization/RLS boundary before remote paper activation. Verify restart/idempotency, fees, funding, loss limits and emergency lock using replay first.
4. Keep LIVE_AUTOPILOT disabled and exchange Demo/customer orders prohibited. Local paper results are simulations, not verified exchange results. No guaranteed win rate or required daily trade count is asserted.

Password recovery now checks schema availability before account lookup, returning the same unavailable status for known/unknown addresses when the table is missing. This removes a missing-schema enumeration distinction without disabling verification, CSRF or rate limits. Mock delivery tests do not prove live email delivery. Live signup/verification still needs an unused authorized test identity and mailbox access; actual session expiry needs a controlled expiry fixture.
