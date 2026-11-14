# Staging and Vercel Preview setup

Current target: Supabase Staging project `ghecpkpaxbrvehquhzkr`, Vercel branch `functional-staging`, and branch Preview origin `https://cryptohub-git-functional-staging-eth-cryptohub.vercel.app`. The separate Production Supabase project is `kafsdnzzjawikoavkhvm`; do not modify it or the `main` branch. The known Ready Preview deployment uses the earlier commit `06fdb400bbedcf92a248afa155c15c393529e35b`; it is not evidence that the current custom-auth changes are deployed or working. The owner reported sanitized Staging data and an available restorable backup/PITR, but neither was independently verified here.

## Restricted UI-only Preview

For a fast visual review that does not need a Staging database or exchange credentials, enable the separate UI-only path only on one explicitly selected Vercel Preview branch:

1. In the existing `cryptohub` Vercel project, set `SMARTEXIT_UI_PREVIEW_ONLY=true` and `SMARTEXIT_UI_PREVIEW_BRANCH=<exact branch name>` in the **Preview** environment, restricted to that branch. Do not set either variable in Production or All Environments.
2. Leave database, Supabase, application-authentication, exchange, email, and CRON credentials unset for that Preview. Remove any such Preview-scoped values before validating this mode; the validator rejects them rather than ignoring them. Vercel may inject its short-lived `VERCEL_OIDC_TOKEN`; the validator accepts it only when its claims identify this exact project and the Preview environment.
3. Keep Vercel Deployment Protection enabled. This mode does not bypass authentication or make authenticated pages public.
4. Run `npm run validate:ui-preview` in the same Vercel Preview build environment. The build preflight selects this validator only when `SMARTEXIT_UI_PREVIEW_ONLY=true`; otherwise the existing full deployment validator remains in force.
5. In UI-only mode, only the public landing page and static assets are served. API requests are rejected, database access is guarded, and other pages show “Unavailable in UI Preview.” No market data, signals, account data, or trades are simulated.

This mode rejects Production, an unselected/mismatched branch, a pull-request deployment, the wrong Vercel project, enabled trading or CRON gates, and any configured database or private credential. It does not configure or use Supabase, run migrations, contact an exchange, or authorize a deployment. Preview deployment still requires a separate approval.

Local checks cannot establish the remote migration ledger, database reachability, backup restoration, Vercel environment scopes, or Preview deployment status. Those remain unverified until inspected through the authenticated provider consoles or approved CLI/MCP tools.

## 1. Use the existing isolated Supabase Staging project

1. Use project URL `https://ghecpkpaxbrvehquhzkr.supabase.co`; keep the database password and keys private. Compare this reference with Production `kafsdnzzjawikoavkhvm` before any operation.
2. Configure Staging database credentials only in Vercel Preview. Use the Supabase Transaction Pooler for serverless deployments where appropriate; its username should retain the project reference (commonly `postgres.<project-ref>`).
3. Do not restore or copy Production data, user records, or exchange credentials into Staging. The owner reported the Staging dataset is sanitized, but that has not been independently verified here.
4. An earlier operator report says 15 migrations are applied through `202611100002_binance_demo_environments.sql`; that status has not been independently verified against Staging. The custom password-recovery flow requires the new, non-destructive `202611140001_password_recovery.sql` migration. Verify the ledger and recovery point read-only through approved authenticated tooling before applying it; do not reapply recorded migrations.
5. Exclude `202611100003_multi_exchange_foundation.sql` and migrations `202611110001`–`202611110005` from this release. Migration `202611100003` seeds Binance customer and Demo providers as enabled; do not apply it or dependent migrations while trading and automated execution must remain disabled.
6. No restore or migration was run during local preparation because approved authenticated Supabase access was unavailable. Once the target, ledger, and restorable backup are independently verified, the already-authorized non-destructive recovery migration may be applied through an approved migration runner.

## 2. Configure Vercel scopes

In Vercel **Project Settings → Environment Variables**, set values by exact scope:

| Variable | Preview scope | Production scope | Development scope |
|---|---|---|---|
| `SMARTEXIT_STAGING_SUPABASE_PROJECT_REF` | Required staging reference | Not needed | Not needed |
| `SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF` | Required Production reference, for separation check | Required Production reference | Not needed |
| `SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256` | Required SHA-256 fingerprint of the Production encryption key; fingerprint only, never the key | Not needed | Not needed |
| `SUPABASE_DB_URL` or `SUPABASE_DB_HOST`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD` | Staging database only | Production database only | Local development database only |
| `SUPABASE_DB_SSLMODE` | `verify-full` (default) or `require`; both enforce certificate and hostname verification. Insecure modes are rejected. | Same strict TLS requirement | Same strict TLS requirement |
| `NEXT_PUBLIC_SUPABASE_URL` | Staging Supabase URL | Production Supabase URL | Local/test project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Staging anon/publishable key | Production anon/publishable key | Local/test key |
| `SUPABASE_SERVICE_ROLE_KEY` | Private Staging service-role key, required only when the approved Admin Demo authorization RPC is integrated | Do not configure for the Admin Demo feature | Local Supabase service-role key only |
| `SUPABASE_JWT_SECRET` | Not used; news uses the authenticated server API | Not used | Not used |
| `AUTH_SECRET` | Unique staging random secret (32+ characters) | Unique Production random secret (32+ characters) | Local random value |
| `BINANCE_CREDENTIALS_KEY` | Unique staging key (32 random bytes, 64 hex characters) | Unique Production key | Local-only key |
| `CRON_SECRET` | Unique staging secret (32+ characters) | Unique Production secret | Local-only value |
| `SMARTEXIT_CRON_RECONCILIATION_ENABLED` | `false` or unset until the verified target and auth are approved | `false` or unset | `false` |
| `SMARTEXIT_CRON_TARGET_ENVIRONMENT` | GitHub Actions repository variable `staging` only when explicitly enabling the reconciler | Unset | Unset |
| `SMARTEXIT_CRON_BASE_URL` | Exact approved staging Preview origin; do not set until verified | Unset | Unset |
| `SMARTEXIT_STAGING_PREVIEW_URL` | Exact approved staging Preview origin used as the allowlist | Unset | Unset |
| `SMARTEXIT_PRODUCTION_APP_URL` | Production origin used to reject accidental target equality | Production origin | Unset |
| `BINANCE_FUTURES_TRADING_ENABLED` | `false` or unset | `false` or unset | `false` |
| `BINANCE_FUTURES_DEMO_TRADING_ENABLED` | `false` or unset | `false` or unset | `false` |
| `BINANCE_FUTURES_DEMO_VERIFIED` | `false` or unset | `false` or unset | `false` |
| `BINANCE_FUTURES_LIVE_TRADING_APPROVED` | `false` or unset | `false` or unset | `false` |
| `BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED` | `false` or unset | `false` or unset | `false` |

Use Preview scope for branch/deployment previews and Production scope for the Production deployment. Do not attach Production DB credentials, encryption keys, JWT secret, or exchange credentials to Preview. Restrict Preview deployments and environment access to trusted operators; untrusted pull request code must not receive private Preview variables.

To establish the key fingerprint without printing the key, compute SHA-256 over the **32 decoded key bytes** in a trusted local secret-management environment and store only the 64-character lowercase hex digest as `SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256` in Preview. Never paste either key into chat, command-line arguments, logs, or repository files. A fingerprint is a comparison guard, not a substitute for rotating a shared key.

## 3. Verify Preview points only to Staging

1. Set `SMARTEXIT_STAGING_SUPABASE_PROJECT_REF` and `SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF` to the independently verified references.
2. Set `NEXT_PUBLIC_SUPABASE_URL` to the Staging project URL.
3. Set the server database URL/host/user/password to that same Staging project. With a direct Supabase database hostname, use `db.<staging-ref>.supabase.co`; with a pooler, retain `postgres.<staging-ref>` in the username.
4. The Vercel Preview build preflight runs automatically before `next build`. Review its sanitized output; it must fail closed if project refs do not match, required variables are absent, secrets are malformed or shared, or any execution gate is enabled.
5. Inspect the sanitized preflight result and Vercel's environment-variable scope selection. Never print `.env` values or database URLs.
6. Confirm the deployment URL is a Vercel Preview URL and that its environment has no Production credentials. This application-level project check cannot prove the contents of a database; inspect/sanitize the staging data using the approved operator process.

### Where to obtain the missing identities

- **Staging Supabase reference:** Supabase Dashboard → select the dedicated Staging project → Project Settings → General (Reference ID), or copy the reference from that project's `https://<reference>.supabase.co` URL. Add it as `SMARTEXIT_STAGING_SUPABASE_PROJECT_REF` in the Vercel **Preview** scope only.
- **Production Supabase reference:** obtain the Reference ID from the independently identified Production project in Supabase Project Settings. Add `SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF` to Preview for the separation check and to Production for its own target check. Do not send project credentials or database URLs in chat.
- **Vercel Preview URL:** Vercel Dashboard → the SmartExit project → Deployments → choose the intended Preview deployment and copy its deployment URL. Confirm its deployment environment says Preview and associate it with the staging branch/environment before setting `SMARTEXIT_STAGING_PREVIEW_URL`.
- **Environment-variable scope:** Vercel Project Settings → Environment Variables. Choose Preview or Production explicitly when creating/editing each variable; do not select All Environments for database credentials, encryption keys, JWT secrets, or CRON secrets. Redeploy the intended environment after changes.
- **Staging database target:** use the Staging project's Connect → Transaction Pooler details (or the approved staging DB host and user) only in Vercel Preview. Verify the hostname and pooler username contain the same Staging reference; never paste the connection string into a report or chat.
- **Separate staging encryption key:** generate a fresh 32-byte random key in the approved secret manager, store it only as Preview `BINANCE_CREDENTIALS_KEY`, and compute/store its SHA-256 fingerprint locally in the same trusted secret-management workflow. Compare against Production's independently calculated fingerprint. Never expose or send either key value; fingerprints are not credentials but should still be handled internally.

Local development without `VERCEL_ENV=preview|production` remains classified as `local`; deployment-only checks are skipped. To test staging checks locally, explicitly set `SMARTEXIT_DEPLOYMENT_ENV=staging` and provide sanitized test values—never use Production secrets in a local shell.

## 4. Binance Demo credentials and CRON

- Add a dedicated API key created for Binance **Demo** to a staging test user's Demo credential row using the application. Do not reuse Testnet or Live credentials and do not put API secrets in Vercel variables.
- Keep all four `BINANCE_FUTURES_*` gates false/unset by default. Never configure a Demo-to-Live fallback.
- Use a unique `CRON_SECRET` for Preview and a separate one for Production. Reconciliation remains disabled unless `SMARTEXIT_CRON_RECONCILIATION_ENABLED=true`, the GitHub Actions repository variable `SMARTEXIT_CRON_TARGET_ENVIRONMENT=staging`, and the HTTPS base URL exactly matches the approved Preview origin. Configure the GitHub Actions repository variable and secrets `SMARTEXIT_CRON_BASE_URL` and `SMARTEXIT_STAGING_PREVIEW_URL` only after that review. The Preview app also needs `SMARTEXIT_PRODUCTION_APP_URL` to prevent origin equality. Manual workflow dispatch additionally requires explicit confirmation. Do not use Production secrets or URL.
- Confirm CRON requests use Bearer authorization and reject missing/invalid secrets. A manual reconciler invocation must be explicitly approved and isolated; do not invoke it during setup or deployment.
- The scheduled five-minute protection workflow is an external GitHub Actions workflow. Vercel's current `vercel.json` does not schedule `/api/cron/binance-protection`.

## 5. Backup/PITR verification

In the Staging Supabase dashboard, verify the plan's backup/PITR capability, retention window, latest successful recovery point, and who can restore it. Record the project reference, timestamp, retention, and restore owner—not credentials—in the change record. Confirm the recovery procedure before applying any migration. This repository cannot verify backup availability or perform a restore.

## 6. Application authentication

The current branch uses application registration, email verification, and database-backed sessions rather than Supabase Auth identities. Configure a Staging-only `AUTH_SECRET` and one verification email transport (`GMAIL_USER` with `GMAIL_APP_PASSWORD`, or `RESEND_API_KEY` with `MAIL_FROM`). Set `APP_URL` to `https://cryptohub-git-functional-staging-eth-cryptohub.vercel.app` so verification links use the stable branch host. The Staging Supabase Auth Site URL is that same origin; the allowlist contains `/auth/callback?flow=signup` and `/auth/callback?flow=recovery`, plus the equivalent localhost development redirects. These provider redirects are retained as configured but are not used by the current custom-auth flow. News updates use the authenticated server API; the app does not open a Supabase Realtime connection or mint Supabase JWTs.

## 7. Readiness boundaries

This guide does not establish a Supabase project, apply migrations, validate account credentials, call Binance, or authorize an exchange order. Keep customer execution and remote test authorization disabled until the owner has confirmed the exact Staging project, Preview target, backup, migration state, Demo-only credential, and separate test approval.
