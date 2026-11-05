# Deployment

## Architecture

- **Vercel:** Next.js web application and server routes.
- **Supabase:** PostgreSQL database for users, sessions, rate limits, and SmartExit paper-trading data.
- **Resend:** email verification delivery.
- **Optional Node service:** SmartExit paper-trading API. It can be hosted on a separate Node-capable provider; the Next.js bridge accepts signed requests over HTTPS.

The application no longer uses a PHP origin, PHP proxy, MySQL database, or PHP runtime.

## 1. Supabase

1. Create a Supabase project and keep its database credentials private.
2. Apply these migrations in order using the SQL editor or a trusted migration runner:
   - `supabase/migrations/202611050001_initial_schema.sql`
   - `supabase/migrations/202611050002_smartexit.sql`
   - `supabase/migrations/202611050003_nextjs_auth.sql`
3. Keep the database reachable only through server-side credentials. The app does not expose database credentials to browser code.
4. Copy the PostgreSQL connection string or host, port, database name, user, and password from Supabase project settings.

## 2. Vercel

1. Import `ethcryptohub2/ETHcryptohub` from GitHub and use the repository root. Vercel should detect the Next.js framework.
2. Configure these values as **private Vercel environment variables** for Preview and Production as appropriate:

| Variable | Requirement |
|---|---|
| `SUPABASE_DB_URL` | PostgreSQL connection string; or use the `SUPABASE_DB_HOST`, `SUPABASE_DB_PORT`, `SUPABASE_DB_NAME`, `SUPABASE_DB_USER`, and `SUPABASE_DB_PASSWORD` variables |
| `SUPABASE_DB_SSLMODE` | `require` enables TLS encryption without certificate verification; unset to verify the server certificate using Node's trusted CAs |
| `AUTH_SECRET` | At least 32 random characters |
| `GMAIL_USER` | Gmail address used as the verification-email sender (optional if using Resend) |
| `GMAIL_APP_PASSWORD` | Google App Password for `GMAIL_USER`; requires Google 2-Step Verification. Never use your normal Google password. |
| `GMAIL_SMTP_PORT` | Optional Gmail SMTP port: `465` (SSL, default) or `587` (STARTTLS) |
| `RESEND_API_KEY` | Optional alternative to Gmail SMTP |
| `MAIL_FROM` | Sender address on a domain verified with Resend; used only with `RESEND_API_KEY` |
| `BINANCE_CREDENTIALS_KEY` | 32 random bytes encoded as 64 hex characters |
| `ADMIN_SETUP_TOKEN` | Optional, temporary token for one-time administrator setup |

3. Deploy and verify the landing page and account routes. Apply database migrations before testing signup or login.
4. Create the first admin through `/admin/setup`: add a private `ADMIN_SETUP_TOKEN` of at least 32 characters to the Vercel Production environment, redeploy, then create the administrator with a strong password. Remove `ADMIN_SETUP_TOKEN` and redeploy after provisioning. Admins can manually mark a pending user's email as verified from `/admin`; confirm the account belongs to the user before using this bypass.

## 3. Optional SmartExit API

The SmartExit UI includes portfolio, trade-intent, risk, market, and audit views. Its API is a separate Node service and must be deployed if those features are needed in production.

Configure the Next.js deployment with:

- `SMARTEXIT_API_URL`: the SmartExit API's public HTTPS origin, with no path or credentials.
- `SMARTEXIT_BRIDGE_SECRET`: a private random secret of at least 32 characters.

Configure the SmartExit API with the same `SMARTEXIT_BRIDGE_SECRET`, the Supabase database settings, `APP_ORIGIN` set to the exact HTTPS Vercel origin, and `NODE_ENV=production`. The API authenticates bridge calls with an HMAC signature; do not expose this secret or put it in a `NEXT_PUBLIC_*` variable. The API should only be deployed over HTTPS.

If these values are not configured, SmartExit returns an explicit unavailable response; the rest of the Next.js app can still run.

## 4. Email and exchange safeguards

- For Gmail SMTP, enable Google 2-Step Verification, create an App Password, then set `GMAIL_USER` and `GMAIL_APP_PASSWORD` as private Vercel environment variables. Do not use or share your regular Google password.
- If using Resend instead, verify the sender domain before testing signup or resend-verification.
- Binance credentials are encrypted at rest and account connectivity checks are read-only. Keep withdrawal permissions disabled.
- Live trading is not implemented or enabled. SmartExit's trade intents are paper-only.
- Do not create a shared default user or password. Provision accounts through signup and the protected admin setup.

## 5. Production verification

1. Check `/`, `/login`, and `/signup`.
2. Register with a mailbox you control and verify delivery in Gmail Sent or Resend's event log, and the recipient inbox.
3. Verify that unverified accounts cannot sign in and that resend verification works.
4. Sign in and test `/dashboard`, `/settings`, `/binance`, `/scanner`, `/smartexit`, and `/admin`.
5. Confirm the scanner reports errors when market data, account risk settings, or the database are unavailable; it must not substitute guessed risk values.
6. Confirm SmartExit reports paper mode and `liveOrdersEnabled: false`.

Do not treat a successful Vercel build or local server as proof of production deployment. Public deployment also requires the GitHub push, Vercel project configuration, applied database migrations, and private provider credentials.
