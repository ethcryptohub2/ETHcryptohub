# SmartExit staging release review

Date: 2026-11-18. Branch: functional-staging.

The release request authorizes reviewed local implementation, a Git commit/push,
and a staging Preview deployment, contingent on independently verified isolation.
It does not authorize any database migration, exchange order, Demo/Live execution,
Production deployment, or CRON activation.

## Four audit fixes

1. LIMIT capability: the Admin execution service now requires limitEntry rather
   than marketEntry. A composed test drives the actual Bybit adapter through the
   actual Admin service for LONG and SHORT, including entry, SL, TP1, retained
   TP2, TP3, zero position, and cleanup. Provider responses and persistence are
   mocked; this does not establish remote exchange readiness.
2. Missing/partial protection IDs: reconciliation reads native position and
   protection first, recovers verified native identifiers, or performs a scoped
   emergency reduce-only close if the owned position lacks verified coverage.
   No entry is resubmitted. Ambiguous ownership/read failure remains explicitly
   reconciliation-required. Flat native exits also recover bookkeeping and clean
   up. The old partial-ID test no longer accepts a permanently unresolved state.
3. Authorization/lease races: initial execution reserves durably and claims the
   same lease used by recovery. Concurrent execute/reconcile workers return BUSY.
   All worker progress uses that lease token. The real adapter checks authority
   after reads; its low-level client checks again immediately before HTTP POST.
   The final repository check verifies both authorization and lease have at least
   15 seconds remaining, exceeding the 10-second HTTP timeout. Deterministic
   tests expire authority/lease during reads and pause initial execution while
   other workers contend. An already submitted exchange request can still finish
   after client timeout; stable order IDs and uncertain-outcome reconciliation
   remain essential. No distributed database lock can revoke an exchange request.
4. Residual/rejected close: actual remaining signed quantity may be smaller than
   the authorized original position, never larger or reversed. A working/unknown
   close prohibits replacement. Only a terminal prior close permits a new,
   deterministic replacement ID, under fresh authorization and the same lease.
   At most three close IDs are available; exhaustion or untradeable residual
   quantity requires operator review. Timeout recovery finds the replacement ID
   without creating another order. Cleanup still requires independently verified
   zero position.

The singleton native trailing stop remains configured with TP1 activation. TP2
replacement is unsupported and retains protection. REST does not prove native
activation/high-water state. Remote Bybit factory capabilities remain disabled.
The legacy Binance request policy is also hard-disabled for this Preview-only
release, even with valid staging configuration and explicit HTTP confirmation.

## Independently observed staging configuration

Authenticated Vercel inspection confirmed project cryptohub,
`prj_RMBw9wXVJexXUMBGSMYScXNFkatL`, in team eth-cryptohub,
`team_T6PklbE1sH3E3B1cUs8V2q9j`. Its existing functional-staging Preview metadata
matches GitHub repository ethcryptohub2/ETHcryptohub and commit
`861ea5643f58708187ecaf0a848ca340895d1dfe`. The latest existing Preview is READY
at `https://cryptohub-qzkn53lbn-eth-cryptohub.vercel.app`; it does not contain the
pending release changes.

The branch-scoped public Supabase URL resolves to ghecpkpaxbrvehquhzkr. The
configured pooler host plus `postgres.ghecpkpaxbrvehquhzkr` database user identify
the same staging project; the configured Production reference is distinct,
kafsdnzzjawikoavkhvm. Branch-scoped Binance trading, Demo verified, Live enabled,
Live approved, remote test, and reconciliation CRON flags were read and are false.
The service factories keep provider-neutral execution unavailable in this release.

**Push/deployment blocker:** Vercel returns neither the Preview nor Production
encryption-key value (both are non-readable Secret variables). A Production-key
fingerprint config exists, but the branch has no staging-key fingerprint and no
independent evidence that the current runtime keys differ. Separate Secret IDs
alone do not prove separate values. No keys were reset, copied, printed, or changed.
Owner-controlled runtime fingerprint evidence is required before push/deployment.

The branch metadata also lacks SUPABASE_SERVICE_ROLE_KEY, required by the new
server-only provider backend. AUTH_SECRET is configured as a non-readable Secret;
its strength/separation cannot be independently checked from this metadata.
Preview email configuration exists, but delivery/login was not tested against a
new release. Existing credentials were preserved.

The project setting reports Node 26 while the prior package range excluded 25+.
The release now pins package.json and its lockfile to Node 24.x, overriding that
project setting through repository configuration without changing shared Vercel
settings. The bundled Node 24.22.3 runtime is used for final local validation.
See [Vercel Node version selection](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

No new deployment was attempted. Therefore no new deployed SHA, browser acceptance
result, authenticated Admin check, or remote API-readiness claim is made.

## Final local validation

All five requested checks passed on Node 24.22.3: typecheck, lint, build,
test:exchanges, and validate:migrations. The exchange suite has **303 passing
tests, zero failures, zero skipped** (10 additional tests above the audited 293
baseline). git diff --check also passes. Migration validation reports file/order
validity only and leaves database status UNKNOWN. The default system Node is an
unsupported 27 alpha; initial checks passed there too, but the supported Node 24
run is the release evidence. No dependency versions or credentials were changed.

## Migration and release scope

The full pending chain remains unapplied by this work; remote database status is
UNKNOWN. Existing reported boundary 202611100002 has not been independently
queried. Static file/order validation and paired verification SQL do not prove
database application readiness. See functional-staging-release-readiness.sql and
the earlier Bybit report for baseline/post checks and maintenance requirements.

Package build hooks run environment validation and Next.js compilation only;
vercel.json contains no scheduled job or migration command. Database initialization
constructs a pool and does not apply schema. Pending migrations are packaged as
source only. The untracked scheduled Binance workflow is excluded from this
release, along with staging.txt, supabase/.temp, .env secret files, and build/log
artifacts. No main branch changes, force pushes, or history rewrites are allowed.

Next action: provide independently verified runtime encryption-key fingerprints
and complete the missing Preview backend configuration, without changing
Production or enabling execution. The current request already authorizes a
reviewed functional-staging push and Preview deployment after these checks pass.
Migrations, Admin provisioning, transport activation, and one controlled Demo
order lifecycle each remain separate approval scopes.
