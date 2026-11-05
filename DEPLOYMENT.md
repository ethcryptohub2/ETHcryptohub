# Deployment

## Architecture

- **Vercel:** Next.js web application and server routes.
- **Supabase:** PostgreSQL database for users, sessions, rate limits, and encrypted Binance API credentials.
- **Resend:** email verification delivery.

The application no longer uses a PHP origin, PHP proxy, MySQL database, or PHP runtime.

## 1. Supabase

1. Create a Supabase project and keep its database credentials private.
2. Apply these migrations in order using the SQL editor or a trusted migration runner:
   - `supabase/migrations/202611050001_initial_schema.sql`
   - `supabase/migrations/202611050003_nextjs_auth.sql`
   - `202611050002_smartexit.sql` is legacy and is not required by the current app. Do not drop its tables from an existing database; they may contain historical user data.
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
| `APP_URL` | Optional canonical public app origin for activation links, e.g. `https://cryptohub.vercel.app`; defaults to Vercel's production host |
| `GMAIL_USER` | Gmail address used as the verification-email sender (optional if using Resend) |
| `GMAIL_APP_PASSWORD` | Google App Password for `GMAIL_USER`; requires Google 2-Step Verification. Never use your normal Google password. |
| `GMAIL_SMTP_PORT` | Optional Gmail SMTP port: `465` (SSL, default) or `587` (STARTTLS) |
| `RESEND_API_KEY` | Optional alternative to Gmail SMTP |
| `MAIL_FROM` | Sender address on a domain verified with Resend; used only with `RESEND_API_KEY` |
| `BINANCE_CREDENTIALS_KEY` | 32 random bytes encoded as 64 hex characters |
| `ADMIN_SETUP_TOKEN` | Optional, temporary token for one-time administrator setup |

3. Deploy and verify the landing page and account routes. Apply database migrations before testing signup or login.
4. Create the first admin through `/admin/setup`: add a private `ADMIN_SETUP_TOKEN` of at least 32 characters to the Vercel Production environment, redeploy, then create the administrator with a strong password. Remove `ADMIN_SETUP_TOKEN` and redeploy after provisioning. Admins can manually mark a pending user's email as verified from `/admin`; confirm the account belongs to the user before using this bypass.

## 3. Email and exchange safeguards

- For Gmail SMTP, enable Google 2-Step Verification, create an App Password, then set `GMAIL_USER` and `GMAIL_APP_PASSWORD` as private Vercel environment variables. Do not use or share your regular Google password.
- If using Resend instead, verify the sender domain before testing signup or resend-verification.
- Binance credentials are encrypted at rest and account connectivity checks are read-only. Keep withdrawal permissions disabled.
- Binance API credentials are used only for read-only connectivity checks; the app does not create simulated or live orders.
- Do not create a shared default user or password. Provision accounts through signup and the protected admin setup.

## 4. Production verification

1. Check `/`, `/login`, and `/signup`.
2. Register with a mailbox you control and verify delivery in Gmail Sent or Resend's event log, and the recipient inbox.
3. Verify that unverified accounts cannot sign in and that resend verification works.
4. Sign in and test `/dashboard`, `/settings`, `/binance`, `/scanner`, and `/admin`.
5. Confirm the scanner reports errors when Binance market data is unavailable and that technical reference levels load without paper-account settings.
6. Confirm paper-trading and wallet routes return `410 Gone`.

Do not treat a successful Vercel build or local server as proof of production deployment. Public deployment also requires the GitHub push, Vercel project configuration, applied database migrations, and private provider credentials.
