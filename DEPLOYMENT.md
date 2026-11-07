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
| `AUTH_SECRET` | At least 32 random characters |
| `APP_URL` | Optional canonical public app origin for activation links, e.g. `https://cryptohub.vercel.app`; defaults to Vercel's production host |
| `GMAIL_USER` | Gmail address used as the verification-email sender (optional if using Resend) |
| `GMAIL_APP_PASSWORD` | Google App Password for `GMAIL_USER`; requires Google 2-Step Verification. Never use your normal Google password. |
| `GMAIL_SMTP_PORT` | Optional Gmail SMTP port: `465` (SSL, default) or `587` (STARTTLS) |
| `RESEND_API_KEY` | Optional alternative to Gmail SMTP |
| `MAIL_FROM` | Sender address on a domain verified with Resend; used only with `RESEND_API_KEY` |
| `BINANCE_CREDENTIALS_KEY` | 32 random bytes encoded as 64 hex characters; encrypts user and market-research provider credentials |
| `ADMIN_SETUP_TOKEN` | Optional, temporary token for one-time administrator setup |
| `CRON_SECRET` | At least 32 random characters; authorizes the scheduled signal scan routes |
| `VAPID_PUBLIC_KEY` | Public key from a VAPID key pair; used to create browser push subscriptions |
| `VAPID_PRIVATE_KEY` | Private VAPID key; server-only, never expose to browser code |
| `VAPID_SUBJECT` | Optional VAPID contact URI such as `mailto:ops@example.com` |
| `SUBSCRIPTION_CONTACT_EMAIL` | Optional support address displayed for manual premium-payment instructions |

3. Deploy and verify the landing page and account routes. Apply database migrations before testing signup or login.
4. Create the first admin through `/admin/setup`: add a private `ADMIN_SETUP_TOKEN` of at least 32 characters to the Vercel Production environment, redeploy, then create the administrator with a strong password. Remove `ADMIN_SETUP_TOKEN` and redeploy after provisioning. Admins can manually mark a pending user's email as verified from `/admin`; confirm the account belongs to the user before using this bypass.
5. On the free Vercel Hobby plan, configure the GitHub repository Actions secret `CRON_SECRET` to the same value as the Vercel Production environment variable. Separate GitHub Actions workflows call the protected standard signal scan every 15 minutes and the high-risk scalping scan every 5 minutes. GitHub scheduled workflows can be delayed, and the standard free private-repository Actions allowance is shared across workflows. Vercel itself is configured with a once-daily backup invocation for each scanner because Hobby does not support more frequent Vercel Cron schedules.

## 3. Email and exchange safeguards

- For Gmail SMTP, enable Google 2-Step Verification, create an App Password, then set `GMAIL_USER` and `GMAIL_APP_PASSWORD` as private Vercel environment variables. Do not use or share your regular Google password.
- If using Resend instead, verify the sender domain before testing signup or resend-verification.
- Binance credentials are encrypted at rest and account connectivity checks are read-only. Keep withdrawal permissions disabled.
- Apply `supabase/migrations/202611060001_market_research.sql` before using admin provider settings. Admins can enter Glassnode, CryptoPanic, and CoinGlass API keys at `/admin`; keys are encrypted at rest and never returned to the browser. Configure the private `BINANCE_CREDENTIALS_KEY` before saving keys.
- Apply `supabase/migrations/202611060002_signal_notifications.sql` before using notifications. Generate a VAPID key pair (for example, `npx web-push generate-vapid-keys`) and set both keys as private Vercel variables. Never put the private key in a `NEXT_PUBLIC_*` variable.
- Apply `supabase/migrations/202611060003_scanner_coin_management.sql` before using Scanner Management. The admin can use **Sync Now** to seed the Binance USDⓈ-M USDT perpetual universe; the protected cron also synchronizes it at least every 15 minutes. Automatic sync preserves manual admin disables and records audit history.
- The admin **System health** panel checks database connectivity, required configuration presence, Binance reachability, and the latest scanner sync. **Attempt safe scanner recovery** synchronizes the pair universe and runs one signal scan; it does not place trades or repair arbitrary application, deployment, or configuration errors. Use the displayed recommendations and server/deployment logs for issues outside those checks.
- Apply `supabase/migrations/202611060004_subscriptions.sql` before deploying subscription-gated scanner and notification features. New accounts receive a seven-day trial; accounts that existed when this migration runs receive a one-time seven-day launch grace period beginning at migration time. License codes are stored as hashes keyed with `AUTH_SECRET`, and `SUBSCRIPTION_CONTACT_EMAIL` is optional.
- The protected `/api/cron/signal-scan` endpoint scans a bounded batch of up to 10 enabled pairs on one supported timeframe (5m, 15m, 1h, 4h) and persists results for the user scanner to read. On the free setup, GitHub Actions triggers it every 15 minutes (with possible schedule delays) and Vercel Cron provides a once-daily backup. Set the GitHub Actions `CRON_SECRET` repository secret to the same value as Vercel's Production `CRON_SECRET`. Coverage depends on the enabled-pair count; lifecycle checks run on each successful invocation. Admins can run a one-off 15-minute batch from Scanner Management after syncing the universe. A Vercel Pro upgrade is not required, but the scan cadence is slower and less exact than the original one-minute schedule.
- Standard Signals supports 5m, 15m, 1h, and 4h timeframes. Default signal validity is 10, 25, 60, and 240 minutes respectively; administrators can change these values from `/admin`. The standard scanner does not include 1m or 3m.
- High-Risk Scalping is an independent, disabled-by-default scanner with 1m, 3m, 5m, and 15m settings, its own signal history and per-user entered state. Apply `supabase/migrations/202611070001_high_risk_scalping.sql`, then enable it from `/admin` to start scanning. It checks up to 10 rotating pairs across each enabled timeframe per scheduled run. GitHub Actions' five-minute schedule is best-effort: delays may skip short entry windows, and lifecycle changes are recorded on the next successful scan, not continuously. The High-Risk tab is informational only and never places orders.
- Apply `supabase/migrations/202611070002_signal_history_performance.sql` before deploying unified signal history, lifecycle, performance, or admin monitoring code. It preserves legacy High-Risk records while backfilling them into the shared history. `/scanner/history` and `/scanner/performance` provide premium-gated history and metrics; `/admin/signals` provides admin-only persistence monitoring. High-Risk signals complete at TP2; Standard signals complete at TP3. Simulated outcomes are one-unit trigger-price estimates without fees, funding, or leverage.
- Entry invalidation uses a configurable entry band of ±0.25 ATR around the generated reference entry by default. It is an informational invalidation rule, not an order trigger.
- Foreground notification history synchronizes through the authenticated API; the dashboard refreshes it every 12 seconds. Web Push uses the service worker for background delivery where the browser and operating system support it. Browser/OS permission must be granted; no notification or sound is guaranteed when permission or system audio is disabled. Browser audio starts only after explicit user interaction.
- Push subscriptions are stored server-side with user ownership. Invalid push endpoints are deleted. Quiet hours and Do Not Disturb suppress push and in-page sound; in-app history remains available.
- Scanner prices, exchange eligibility, and candles use Binance USDⓈ-M Futures. Binance public market endpoints require no private API key; scanner requests do not fall back to another exchange. CryptoPanic, Glassnode, and CoinGlass feeds remain unavailable until their keys are set by an admin. CoinGlass heatmap access depends on its provider plan.
- Glassnode exchange netflow is on-chain exchange-flow context, not verified smart-wallet attribution. CryptoPanic votes are community votes, not independently verified sentiment. Provider keys remain server-side.
- Binance API credentials are used only for read-only connectivity checks; the app does not create simulated or live orders.
- Do not create a shared default user or password. Provision accounts through signup and the protected admin setup.

## 4. Production verification

1. Check `/`, `/login`, and `/signup`.
2. Register with a mailbox you control and verify delivery in Gmail Sent or Resend's event log, and the recipient inbox.
3. Verify that unverified accounts cannot sign in and that resend verification works.
4. Sign in and test `/dashboard`, `/settings`, `/binance`, `/scanner`, and `/admin`.
5. In `/admin`, synchronize the Binance Futures universe, verify the pair count exceeds the old fixed list, and test individual and bulk enable/disable. Confirm admin-disabled pairs stay disabled after sync. In `/scanner`, verify background batch results use Binance data, stale results are non-actionable, and configured research feeds show LIVE only when provider data validates.
6. To verify High-Risk Scalping, enable it explicitly in `/admin`, then check the separate tab and the scheduled Action run. Treat this as a best-effort scanner, not a real-time or automated trading system.
7. Confirm paper-trading and wallet routes return `410 Gone`.

Do not treat a successful Vercel build or local server as proof of production deployment. Public deployment also requires the GitHub push, Vercel project configuration, applied database migrations, and private provider credentials.
