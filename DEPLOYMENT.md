# Deployment

For isolated Supabase Staging and Vercel Preview configuration, required project-reference checks, key separation, and preflight behavior, see [STAGING_SETUP.md](./STAGING_SETUP.md). For offline migration file validation, backup, restore, and read-only SQL verification, see [docs/DATABASE-SAFETY.md](./docs/DATABASE-SAFETY.md).

Current `functional-staging` target: Supabase Staging project `ghecpkpaxbrvehquhzkr`, Preview branch origin `https://cryptohub-git-functional-staging-eth-cryptohub.vercel.app`, and separate Production project `kafsdnzzjawikoavkhvm`. The current release must not modify Production or `main`; keep trading and CRON disabled. Do not apply migration `202611100003_multi_exchange_foundation.sql` or migrations `202611110001`–`202611110005`; the first seeds enabled Binance providers and later migrations depend on it. Verify the Staging migration ledger and backup through approved read-only access before any migration.

The Admin Binance Demo migrations (`202611110004_admin_binance_demo_testing.sql` and `202611110005_admin_binance_demo_rpc_grant.sql`) are review-only until a separately approved Staging migration window. A server-only Supabase RPC adapter now targets the fixed authorization function, but it is not called by an Admin execution route; the isolated repository and test-start adapter remain unimplemented. These files do not enable Admin orders or customer execution.

## Architecture

- **Vercel:** Next.js web application and server routes.
- **Supabase:** PostgreSQL database for users, sessions, rate limits, and encrypted exchange API credentials.
- **Resend:** email verification delivery.
- **Vercel Cron + Web Push:** scheduled signal evaluation, per-user notification delivery, and browser push subscriptions.

The application no longer uses a PHP origin, PHP proxy, MySQL database, or PHP runtime.

## 1. Supabase

1. For a new environment, create a dedicated Supabase project and keep its database credentials private. For this Staging release, use only the existing project identified above.
2. For a new environment, apply these migrations in order with an approved authenticated migration runner:
   - `supabase/migrations/202611050001_initial_schema.sql`
   - `supabase/migrations/202611050003_nextjs_auth.sql`
   - `supabase/migrations/202611050004_password_recovery.sql`
   - `supabase/migrations/202611060001_market_research.sql`
   - `supabase/migrations/202611060002_signal_notifications.sql`
   - `supabase/migrations/202611060003_scanner_coin_management.sql`
   - `supabase/migrations/202611060004_subscriptions.sql`
   - `supabase/migrations/202611070001_high_risk_scalping.sql`
   - `supabase/migrations/202611070002_signal_history_performance.sql`
   - `supabase/migrations/202611070003_news_platform.sql`
   - `supabase/migrations/202611070004_seed_news_sources.sql`
   - `supabase/migrations/202611090001_enable_trusted_news_autopublishing.sql`
   - `supabase/migrations/202611090002_news_article_images.sql`
   - `supabase/migrations/202611100001_live_futures_trading.sql`
   - `supabase/migrations/202611100002_binance_demo_environments.sql`
   - `supabase/migrations/202611140001_password_recovery.sql`
   - `202611050002_smartexit.sql` is legacy and is not required by the current app. Do not drop its tables from an existing database; they may contain historical user data.
3. Keep the database reachable only through server-side credentials. The app does not expose database credentials to browser code.
4. The application never applies schema migrations during startup or API requests. A missing table fails the request; apply reviewed migration files only through a separately approved administrative process.
   The signal-history migration extends existing tables and must be applied explicitly as part of that process.
   The current `functional-staging` release includes the non-destructive `202611140001_password_recovery.sql` migration after the existing auth and trading schema. An earlier operator report says 15 migrations are applied through `202611100002_binance_demo_environments.sql`; verify that ledger and the recovery point before applying the pending recovery migration.
   Do not apply `202611100003_multi_exchange_foundation.sql` or migrations `202611110001`–`202611110005`; the first seeds Binance customer and Demo providers as enabled, and dependent migrations are outside this release.
   Those later migrations are not automatically applied. Any future use requires separate review and approval, a verified backup, a migration-ledger check, and a matching application release. Keep all customer execution disabled.
   The strategy profile migration is also manual and depends on migration 003. It preserves current Binance settings in the existing settings tables and copies the active Binance profile into Standard with the strategy disabled until explicit position and daily-loss limits are configured. High-Risk profiles start disabled. Apply it only after backing up and reviewing both pending multi-exchange migrations.
   The Binance protection lifecycle migration depends on migrations 003 and 110001 and records the native TP1-activated trailing order plus reconciliation locks. Apply it manually after backup; the app does not apply it automatically.
   The credential environment confirmation migration depends on migrations 100002 and 100003. It marks pre-existing encrypted credentials as requiring re-entry into their explicit Demo or Live slot; their ciphertext is preserved, but those records cannot be used until the account owner re-enters credentials for the selected environment. Apply it after the other trading migrations before deploying the matching application code.
5. Copy the PostgreSQL connection string or host, port, database name, user, and password from Supabase project settings.

## 2. Vercel

1. Import `ethcryptohub2/ETHcryptohub` from GitHub and use the repository root. Vercel should detect the Next.js framework.
2. Configure these values as **private Vercel environment variables** for Preview and Production as appropriate:

| Variable | Requirement |
|---|---|
| `SUPABASE_DB_URL` | Supabase Transaction Pooler connection string (port `6543`) for Vercel/serverless; or use `SUPABASE_DB_HOST`, `SUPABASE_DB_PORT=6543`, `SUPABASE_DB_NAME`, `SUPABASE_DB_USER`, and `SUPABASE_DB_PASSWORD` with the Transaction Pooler host |
| `SUPABASE_DB_SSLMODE` | `verify-full` (recommended) or `require`; both enforce TLS with CA and hostname verification. Unset also verifies. Insecure modes are rejected. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL; checked against the approved environment's project reference |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable/anon key; safe for browser use only with the migration's RLS policies |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Staging key for the Admin authorization RPC after its migrations and execution integration are approved; never expose to browser code |
| `SUPABASE_JWT_SECRET` | Not used. News updates use the authenticated server API and do not mint custom Supabase JWTs. Do not configure the legacy JWT secret. |
| `AUTH_SECRET` | At least 32 random characters |
| `APP_URL` | Set to the exact approved Preview origin for staging verification links. Without it, Preview prefers `VERCEL_BRANCH_URL` and never falls back to the Production host |
| `GMAIL_USER` | Gmail address used as the verification-email sender (optional if using Resend) |
| `GMAIL_APP_PASSWORD` | Google App Password for `GMAIL_USER`; requires Google 2-Step Verification. Never use your normal Google password. |
| `GMAIL_SMTP_PORT` | Optional Gmail SMTP port: `465` (SSL, default) or `587` (STARTTLS) |
| `RESEND_API_KEY` | Optional alternative to Gmail SMTP |
| `MAIL_FROM` | Sender address on a domain verified with Resend; used only with `RESEND_API_KEY` |
| `BINANCE_CREDENTIALS_KEY` | 32 random bytes encoded as 64 hex characters; encrypts user and market-research provider credentials |
| `BINANCE_FUTURES_TRADING_ENABLED` | Master order-submission gate; keep `false` or unset by default |
| `BINANCE_FUTURES_DEMO_TRADING_ENABLED` | Demo order-submission gate; enable only after successful Demo API, order, protection, isolation, and history checks |
| `BINANCE_FUTURES_DEMO_VERIFIED` | Operator attestation that the Demo test plan passed; keep `false` or unset until it does |
| `BINANCE_FUTURES_LIVE_TRADING_APPROVED` | Live real-funds gate; keep `false` or unset until separately reviewed and approved |
| `ADMIN_SETUP_TOKEN` | Optional, temporary token for one-time administrator setup |
| `CRON_SECRET` | At least 32 random characters; authorizes scheduled signal scan and news ingestion routes |
| `VAPID_PUBLIC_KEY` | Public key from a VAPID key pair; used to create browser push subscriptions |
| `VAPID_PRIVATE_KEY` | Private VAPID key; server-only, never expose to browser code |
| `VAPID_SUBJECT` | Optional VAPID contact URI such as `mailto:ops@example.com` |
| `SUBSCRIPTION_CONTACT_EMAIL` | Optional support address displayed for manual premium-payment instructions |

3. Deploy and verify the landing page and account routes. Apply database migrations before testing signup or login.
4. Create the first staging admin through `/admin/setup` only after Staging schema and Preview settings are verified: configure a private `ADMIN_SETUP_TOKEN` in the Vercel Preview scope, create the administrator with a strong password, then remove the token. Never add this token to Production for the Staging release.
5. Keep Staging CRON disabled. Production scan schedules described below are not authorization to configure or run Staging workflows; do not enable any staging CRON variable, GitHub workflow, or Vercel schedule for this release.
6. Apply `supabase/migrations/202611070003_news_platform.sql`, `supabase/migrations/202611070004_seed_news_sources.sql`, `supabase/migrations/202611090001_enable_trusted_news_autopublishing.sql`, and `supabase/migrations/202611090002_news_article_images.sql`. The trusted-publishing migration enables the platform auto-publishing gate and marks only the seeded CoinDesk and Cointelegraph RSS endpoints trusted and auto-publish enabled; other sources still require explicit trust and auto-publish configuration. Newly fetched articles from eligible sources are published only after the ingestion pipeline verifies and stores them. The image migration adds the nullable `image_url` column used by the redesigned news feed. The feed polls the authenticated server API; it does not open a browser Realtime connection or mint custom Supabase JWTs.
7. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the project URL and publishable/anon key. The news feed polls the authenticated server API; it does not mint custom Supabase JWTs or use a browser Realtime connection. Never expose a service-role key to the browser.
8. Configure the GitHub Actions `CRON_SECRET` secret to match Vercel. The news workflow attempts ingestion every 15 minutes; the Vercel Hobby cron is a once-daily backup. Provider and platform intervals can reduce fetch frequency further. Check `/admin` → News feed management for each source's last success/error and the ingestion log if scheduled imports do not run.

## 3. Email and exchange safeguards

- For Gmail SMTP, enable Google 2-Step Verification, create an App Password, then set `GMAIL_USER` and `GMAIL_APP_PASSWORD` as private Vercel environment variables. Do not use or share your regular Google password.
- If using Resend instead, verify the sender domain before testing signup or resend-verification.
- Binance credentials are encrypted at rest in separate per-user `DEMO` and `LIVE` rows. The pre-existing credential row is migrated as `LIVE`, preserving existing live settings. Keep withdrawal permissions disabled.
- Every account request is routed by a server-side fixed mapping: Demo `https://demo-fapi.binance.com`, Live `https://fapi.binance.com`. No client URL or Demo-to-Live fallback exists. The active environment defaults to Demo; switching to Live requires an explicit confirmation.
- Keep all four `BINANCE_FUTURES_*` gates false/unset initially. Demo account reads and credential tests use Demo credentials and the fixed Demo host, but Demo order submission requires `BINANCE_FUTURES_TRADING_ENABLED=true`, `BINANCE_FUTURES_DEMO_TRADING_ENABLED=true`, and `BINANCE_FUTURES_DEMO_VERIFIED=true`. Only set the verification flag after the complete Demo test plan passes. These variables are private Vercel settings.
- Live order submission requires `BINANCE_FUTURES_TRADING_ENABLED=true` and `BINANCE_FUTURES_LIVE_TRADING_APPROVED=true`; Live uses only the Live credential row and fixed Live endpoint. This is a real-funds capability. Keep it disabled until independently reviewed, keep withdrawal permission disabled, and use the explicit Live confirmation in the UI.
- Demo and Live Auto-Trade have independent off-by-default settings, execution modes, and emergency stops. The scan worker uses only each enabled environment's credential adapter and gate. Enabling Live Auto-Trade requires a separate explicit confirmation and a successful Live test-order permission check; leave the Live gate off until the Demo test plan and independent Live review have passed.
- `/binance` has separate Demo API and Live API tabs. Each tab independently saves, tests, and deletes encrypted credentials. The credential form never places orders. `/settings` selects the active trading environment; balance and exchange positions show only that account, while execution history offers separate environment filters and statistics.
- Apply `supabase/migrations/202611060001_market_research.sql` before using admin provider settings. Admins can enter Glassnode, CryptoPanic, and CoinGlass API keys at `/admin`; keys are encrypted at rest and never returned to the browser. Configure the private `BINANCE_CREDENTIALS_KEY` before saving keys.
- Apply `supabase/migrations/202611060002_signal_notifications.sql` before using notifications. Generate a VAPID key pair (for example, `npx web-push generate-vapid-keys`) and set both keys as private Vercel variables. Never put the private key in a `NEXT_PUBLIC_*` variable.
- Apply `supabase/migrations/202611060003_scanner_coin_management.sql` before using Scanner Management. The admin can use **Sync Now** to seed the Binance USDⓈ-M USDT perpetual universe; the protected cron also synchronizes it at least every 15 minutes. Automatic sync preserves manual admin disables and records audit history.
- The admin **System health** panel checks database connectivity, required configuration presence, Binance reachability, and the latest scanner sync. **Attempt safe scanner recovery** synchronizes the pair universe and runs one signal scan; it does not place trades or repair arbitrary application, deployment, or configuration errors. Use the displayed recommendations and server/deployment logs for issues outside those checks.
- Apply `supabase/migrations/202611060004_subscriptions.sql` before deploying subscription-gated scanner and notification features. New accounts receive a seven-day trial; accounts that existed when this migration runs receive a one-time seven-day launch grace period beginning at migration time. License codes are stored as hashes keyed with `AUTH_SECRET`, and `SUBSCRIPTION_CONTACT_EMAIL` is optional.
- The protected `/api/cron/signal-scan` endpoint scans a bounded batch of up to 10 enabled pairs on one supported timeframe (5m, 15m, 1h, 4h) and persists results for the user scanner to read. On the free setup, GitHub Actions triggers it every 15 minutes (with possible schedule delays) and Vercel Cron provides a once-daily backup. Set the GitHub Actions `CRON_SECRET` repository secret to the same value as Vercel's Production `CRON_SECRET`. Coverage depends on the enabled-pair count; lifecycle checks run on each successful invocation. Admins can run a one-off 15-minute batch from Scanner Management after syncing the universe. A Vercel Pro upgrade is not required, but the scan cadence is slower and less exact than the original one-minute schedule.
- Standard Signals supports 5m, 15m, 1h, and 4h timeframes. Default signal validity is 10, 25, 60, and 240 minutes respectively; administrators can change these values from `/admin`. The standard scanner does not include 1m or 3m.
- High-Risk Scalping is an independent, disabled-by-default scanner with 1m, 3m, 5m, and 15m settings, its own signal history and per-user entered state. Apply `supabase/migrations/202611070001_high_risk_scalping.sql`, then enable it from `/admin` to start scanning. It checks up to 10 rotating pairs across each enabled timeframe per scheduled run. GitHub Actions' five-minute schedule is best-effort: delays may skip short entry windows, and lifecycle changes are recorded on the next successful scan, not continuously. The High-Risk tab is informational only and never places orders.
- Apply `supabase/migrations/202611070002_signal_history_performance.sql` before deploying unified signal history, lifecycle, performance, or admin monitoring code. It preserves legacy High-Risk records while backfilling them into the shared history. `/scanner/history` and `/scanner/performance` provide premium-gated history and metrics; `/admin/signals` provides admin-only persistence monitoring. High-Risk signals complete at TP2; Standard signals complete at TP3. Simulated outcomes are one-unit trigger-price estimates without fees, funding, or leverage.
- News administrators use `/admin` → **News management** to configure providers, categories, trusted-source auto-publication, review status, settings, and ingestion logs. API credentials are encrypted with `BINANCE_CREDENTIALS_KEY`; configure it before adding provider credentials. RSS/Atom endpoints use HTTPS. Mapped JSON sources use the configured field mapping; keep provider quotas and terms in mind. The default flow queues content for review; automatic publication requires both global publishing and a trusted source with its own auto-publish option enabled.
- `/news` shows only verified, published articles. Sentiment is explicitly rule-based and informational; it is not connected to either signal generator. `maximum_articles` caps total stored articles and limits each ingestion run; existing historical rows are never deleted automatically. The **Fetch sources now** button is admin-only and limited to one run every five minutes.
- `/positions` shows real exchange positions for only the active environment alongside separate user-recorded signal entries.
- Entry invalidation uses a configurable entry band of ±0.25 ATR around the generated reference entry by default. It is an informational invalidation rule, not an order trigger.
- Foreground notification history synchronizes through the authenticated API; the dashboard refreshes it every 12 seconds. Web Push uses the service worker for background delivery where the browser and operating system support it. Browser/OS permission must be granted; no notification or sound is guaranteed when permission or system audio is disabled. Browser audio starts only after explicit user interaction.
- Push subscriptions are stored server-side with user ownership. Invalid push endpoints are deleted. Quiet hours and Do Not Disturb suppress push and in-page sound; in-app history remains available.
- Scanner prices, exchange eligibility, and candles use Binance USDⓈ-M Futures. Binance public market endpoints require no private API key; scanner requests do not fall back to another exchange. CryptoPanic, Glassnode, and CoinGlass feeds remain unavailable until their keys are set by an admin. CoinGlass heatmap access depends on its provider plan.
- Glassnode exchange netflow is on-chain exchange-flow context, not verified smart-wallet attribution. CryptoPanic votes are community votes, not independently verified sentiment. Provider keys remain server-side.
- Binance credential connection checks are read-only. Manual orders and Auto-Trade remain unavailable until the selected environment's deployment gates are deliberately enabled. Do not infer Demo order verification from a successful account connection.
- Do not create a shared default user or password. Provision accounts through signup and the protected admin setup.

### Demo acceptance checklist

Before setting `BINANCE_FUTURES_DEMO_VERIFIED=true`, use separate Binance Demo credentials and verify each item directly against the Demo account:

1. Save, test, update, and delete Demo credentials; repeat independently for Live and confirm each operation leaves the other row unchanged.
2. Verify Demo account-read connection and `/fapi/v3/balance` use `https://demo-fapi.binance.com`; verify Live uses only `https://fapi.binance.com`.
3. Confirm Demo/Live active-environment switching, including explicit Live confirmation, and verify missing selected-environment credentials fail closed.
4. On Demo only, verify leverage setting, LONG entry, SHORT entry, take-profit and stop-loss algo orders, and inspect position/order status on the Demo exchange.
5. Verify Demo open positions and Demo execution history are isolated; verify a Demo signal can also have a separate Live execution record without sharing orders or balances.
6. Verify Demo Auto-Trade remains off by default, turns on only after its explicit opt-in and Demo permission test, processes new signals through the Demo adapter, and is stopped only by the Demo emergency stop.
7. Verify wrong/missing Demo keys, timeouts, duplicate signal execution, partial fills, and protection failures do not reach the Live endpoint or retry uncertain entries.
8. Use network mocks or request tracing in a controlled test environment to assert a Demo request never calls the Live host and a Live request never calls the Demo host. Never use real-funds orders for this isolation test.

The code build and public Demo market-data reachability are not evidence that these signed-account/order tests passed. Keep all order gates disabled until the owner runs and records the signed Demo checks.

## 4. Production verification

1. Check `/`, `/login`, and `/signup`.
2. Register with a mailbox you control and verify delivery in Gmail Sent or Resend's event log, and the recipient inbox.
3. Verify that unverified accounts cannot sign in and that resend verification works.
4. Sign in and test `/dashboard`, `/settings`, `/binance`, `/scanner`, and `/admin`.
5. In `/admin`, synchronize the Binance Futures universe, verify the pair count exceeds the old fixed list, and test individual and bulk enable/disable. Confirm admin-disabled pairs stay disabled after sync. In `/scanner`, verify background batch results use Binance data, stale results are non-actionable, and configured research feeds show LIVE only when provider data validates.
6. To verify High-Risk Scalping, enable it explicitly in `/admin`, then check the separate tab and the scheduled Action run. Treat this as a best-effort scanner, not a real-time or automated trading system.
7. Confirm paper-trading and wallet routes return `410 Gone`. Keep Futures order submission locked unless the full Demo acceptance checklist above has passed.

Do not treat a successful Vercel build or local server as proof of production deployment. Public deployment also requires the GitHub push, Vercel project configuration, applied database migrations, and private provider credentials.

## Multi-exchange release status and rollback

- The multi-exchange schema is additive for credentials, preferences, per-exchange settings, provider control, and Admin test events. It copies existing Binance credentials/settings and keeps Binance executions labeled `BINANCE`; verify row counts and a database backup before applying it.
- Before applying `202611100003_multi_exchange_foundation.sql`, disable order submission through the existing Binance deployment gates and take a restorable Supabase backup/PITR recovery point. Apply the migration manually as part of the matching release; the application does not apply it automatically.
- After migration, verify the `trade_executions.exchange` column, Binance Demo/Live records, and Admin Exchange Control before enabling any order path. Keep Binance gates unchanged/off during validation. Never enable Bybit customer trading or any new Live provider as part of this release.
- Bybit Demo uses the fixed `https://api-demo.bybit.com` host. Its encrypted credentials reuse `BINANCE_CREDENTIALS_KEY`; no Bybit-specific endpoint or encryption environment variable is accepted. Remote Demo tests require an administrator-owned Bybit Demo API key with read and derivatives-trading permissions only. Remote API tests are not run by the automated suite.
- Strategy profiles require `max_open_positions` and `max_daily_loss_percent` before enabling. The profile UI and storage do not make Bybit customer trading or any Live execution available. Binance customer execution remains locked until the native trailing order, reconciliation, and recovery paths pass remote Demo verification.
- The current application deliberately refuses to enable or execute either customer strategy: the Binance Demo TP/SL lifecycle still requires remote Demo verification and operational scheduling, High-Risk lacks a verified customer execution lifecycle, and execution previews report `canExecute: false`. Do not change deployment gates or database profile flags to bypass this application gate.
- Binance Demo entries install the initial stop, full-position TP3 close, and a reduce-only 1% trailing-stop market order with TP1 as its activation price. The CRON-protected route `/api/cron/binance-protection` reconciles Demo positions and protections, closes residual positions reduce-only if protection is missing, and cancels stored protective orders only after Binance confirms the position is flat. The GitHub Actions workflow invokes it every five minutes; scheduled workflow delays are possible, so monitor failures and keep native exchange protection active independently. It is not added to Vercel Cron because the current Hobby configuration supports only daily Vercel schedules.
- The reconciler verifies the trailing algo order's active status, activation price, 1% callback rate, side, and full-position quantity. The app does not obtain Binance's dynamically changing internal trailing trigger price or exact activation event from that order query; TP1/TP2 history timestamps are sampled during reconciliation, not exchange event timestamps. Do not represent these values as an exact current trailing stop price or as evidence of remote validation.
- The scheduled GitHub Actions reconciler is disabled unless repository variable `SMARTEXIT_CRON_RECONCILIATION_ENABLED=true`, repository variable `SMARTEXIT_CRON_TARGET_ENVIRONMENT=staging`, and secrets `CRON_SECRET`, `SMARTEXIT_CRON_BASE_URL`, and `SMARTEXIT_STAGING_PREVIEW_URL` are configured. The workflow requires an exact HTTPS Preview-origin match and manual dispatch confirmation. Keep it disabled until the Staging database, Preview routes, and Demo lifecycle are separately verified; never point it at Production.
- OKX, Bitget, and Gate.io remain `NOT IMPLEMENTED — DISABLED`. Before future adapters are enabled, verify each exchange's current official API docs for credential fields, signature/timestamp rules, Demo/Testnet endpoints, quantity filters, position mode, protection, and reconciliation behavior. Their registry endpoints are not evidence of readiness.

### Staging migration procedure

1. Use only Supabase Staging project `ghecpkpaxbrvehquhzkr` and confirm the Preview deployment targets that project; never paste credentials into source control or chat.
2. Verify the migration ledger and a restorable backup/PITR point through approved authenticated CLI/MCP tooling. Do not use the SQL Editor. The earlier report of 15 migrations applied through `202611100002_binance_demo_environments.sql` remains unverified.
3. If and only if `202611140001_password_recovery.sql` is absent from the ledger, apply that non-destructive migration with the approved migration runner. It creates a reset-code table, enables RLS, and revokes direct `anon`/`authenticated` access.
4. Run `supabase/verification/202611140001_password_recovery.sql` read-only and confirm RLS is enabled with no grants to `anon` or `authenticated`. Do not select or report reset-code values.
5. Do not apply `202611100003_multi_exchange_foundation.sql` or `202611110001`–`202611110005`; migration 003 seeds customer and Demo Binance providers as enabled and later migrations are outside this release.
6. Keep trading, Demo execution, automatic orders, and CRON disabled. Do not restore or mutate Production data or switch to `main`.

### Rollback

1. Immediately turn off the Binance order-submission deployment gates and any provider/environment access, then stop traffic to order routes.
2. If the migration has **not** been applied, roll the application back normally; no database rollback is needed.
3. If the migration **has** been applied, do not roll back only the application: the previous release targets the old `trade_executions` uniqueness constraint. Restore the verified pre-migration Supabase recovery point first, then roll back the application to the matching release.
4. If restoring a snapshot is not possible, keep order routes disabled and deploy a reviewed forward-fix/rollback migration made against a backup of the actual schema and data. Do not drop the new tables, remove exchange history, or guess at constraint changes in production.
5. Re-verify Binance credential rows, settings, execution history, and Demo/Live isolation before reopening any order route. Keep all new exchange and Live trading paths disabled.
6. Migrations `202611110001_strategy_profiles.sql` and `202611110002_binance_protection_lifecycle.sql` are additive and can be rolled back only with a reviewed SQL script and a verified pre-migration backup. Because they add profile, order, and lifecycle metadata, do not drop their columns or tables if post-migration records exist; restore the pre-migration recovery point or use a reviewed forward fix instead.
