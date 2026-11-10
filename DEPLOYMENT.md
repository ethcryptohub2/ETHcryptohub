# Deployment

## Architecture

- **Vercel:** Next.js web application and server routes.
- **Supabase:** PostgreSQL database for users, sessions, rate limits, and encrypted Binance API credentials.
- **Resend:** email verification delivery.
- **Vercel Cron + Web Push:** scheduled signal evaluation, per-user notification delivery, and browser push subscriptions.

The application no longer uses a PHP origin, PHP proxy, MySQL database, or PHP runtime.

## 1. Supabase

1. Create a Supabase project and keep its database credentials private.
2. Apply these migrations in order using the SQL editor or a trusted migration runner:
   - `supabase/migrations/202611050001_initial_schema.sql`
   - `supabase/migrations/202611050003_nextjs_auth.sql`
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
   - `202611050002_smartexit.sql` is legacy and is not required by the current app. Do not drop its tables from an existing database; they may contain historical user data.
3. Keep the database reachable only through server-side credentials. The app does not expose database credentials to browser code.
4. On first access, the server can apply the matching scanner, subscriptions, notification, market-research, or scalping migration when a required feature table is missing. Manually applying migrations in order remains the recommended production setup.
   The signal-history migration extends existing tables and therefore must be applied explicitly; the automatic missing-table migration helper does not upgrade existing tables.
5. Copy the PostgreSQL connection string or host, port, database name, user, and password from Supabase project settings.

## 2. Vercel

1. Import `ethcryptohub2/ETHcryptohub` from GitHub and use the repository root. Vercel should detect the Next.js framework.
2. Configure these values as **private Vercel environment variables** for Preview and Production as appropriate:

| Variable | Requirement |
|---|---|
| `SUPABASE_DB_URL` | Supabase Transaction Pooler connection string (port `6543`) for Vercel/serverless; or use `SUPABASE_DB_HOST`, `SUPABASE_DB_PORT=6543`, `SUPABASE_DB_NAME`, `SUPABASE_DB_USER`, and `SUPABASE_DB_PASSWORD` with the Transaction Pooler host |
| `SUPABASE_DB_SSLMODE` | `require` enables TLS encryption without certificate verification; unset to verify the server certificate using Node's trusted CAs |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL; public project metadata used by the browser Realtime client |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable/anon key; safe for browser use only with the migration's RLS policies |
| `SUPABASE_JWT_SECRET` | Private HS256 Supabase JWT signing secret used only to issue short-lived authenticated Realtime tokens; this implementation requires the project to accept HS256-signed JWTs. Never expose or use the service-role key in the browser |
| `AUTH_SECRET` | At least 32 random characters |
| `APP_URL` | Optional canonical public app origin for activation links, e.g. `https://cryptohub.vercel.app`; defaults to Vercel's production host |
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
4. Create the first admin through `/admin/setup`: add a private `ADMIN_SETUP_TOKEN` of at least 32 characters to the Vercel Production environment, redeploy, then create the administrator with a strong password. Remove `ADMIN_SETUP_TOKEN` and redeploy after provisioning. Admins can manually mark a pending user's email as verified from `/admin`; confirm the account belongs to the user before using this bypass.
5. On the free Vercel Hobby plan, configure the GitHub repository Actions secret `CRON_SECRET` to the same value as the Vercel Production environment variable. Separate GitHub Actions workflows call the protected standard signal scan every 15 minutes and the high-risk scalping scan every 5 minutes. GitHub scheduled workflows can be delayed, and the standard free private-repository Actions allowance is shared across workflows. Vercel itself is configured with a once-daily backup invocation for each scanner because Hobby does not support more frequent Vercel Cron schedules.
6. Apply `supabase/migrations/202611070003_news_platform.sql`, `supabase/migrations/202611070004_seed_news_sources.sql`, `supabase/migrations/202611090001_enable_trusted_news_autopublishing.sql`, and `supabase/migrations/202611090002_news_article_images.sql`. The trusted-publishing migration enables the platform auto-publishing gate and marks only the seeded CoinDesk and Cointelegraph RSS endpoints trusted and auto-publish enabled; other sources still require explicit trust and auto-publish configuration. Newly fetched articles from eligible sources are published only after the ingestion pipeline verifies and stores them. The image migration adds the nullable `image_url` column used by the redesigned news feed. In Supabase, confirm `news_articles` and `news_notifications` are in the `supabase_realtime` publication. The news migration adds tables, indexes, policies and publication membership when available. Policies use a short-lived signed `app_user_id` claim issued only after the app's verified session check; the browser receives only the anon key and never the JWT secret.
7. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the project URL and publishable/anon key. Set the private `SUPABASE_JWT_SECRET` to the project JWT signing secret. Do not use a service-role key for browser Realtime.
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
