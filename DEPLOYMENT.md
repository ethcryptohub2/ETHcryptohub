# ETHcryptohub deployment

## Architecture

- **GitHub:** source repository `ethcryptohub2/ETHcryptohub` (public, as requested).
- **Supabase:** PostgreSQL database for ETHcryptohub accounts and SmartExit paper-trading records.
- **Railway:** PHP/Apache application and private SmartExit Node API services.
- **Vercel:** same-origin reverse proxy to the Railway PHP application.

Vercel does not run the PHP application directly. Its proxy requires `PHP_ORIGIN` to be set to the HTTPS origin Railway assigns to the PHP service. The proxy has a 60-second function limit; some Vercel plans impose a lower maximum duration. If SmartExit market scans time out through Vercel, use the Railway URL directly or configure a static external rewrite after the Railway origin is known.

## 1. Supabase

1. Create a Supabase project in **South Asia (Mumbai)**. Keep the database password private; do not put it in this repository or send it in chat.
2. In the SQL editor, run `supabase/migrations/202611050001_initial_schema.sql`, then `supabase/migrations/202611050002_smartexit.sql`.
3. Keep automatic exposure of new tables to the Data API disabled. The migrations enable RLS and revoke access from `anon` and `authenticated`; the server connects directly using PostgreSQL credentials.
4. Copy the database host, port, database name, and username from **Project Settings → Database**. Use the session-pooler connection details if the direct database host is unreachable from Railway.

The initial migration creates the account, OTP, admin-rate-limit, and encrypted Binance-credential tables. The second migration creates the user-scoped SmartExit portfolio and paper-trading tables. Applying migrations does not copy local SQLite records or create a production administrator.

## 2. Railway

Create two services from the GitHub repository:

### PHP web service

- Repository: `ethcryptohub2/ETHcryptohub`.
- Root directory: `/`.
- Builder: Dockerfile (`/Dockerfile`).
- Generate a public domain and keep one replica until shared PHP session storage is configured.

Set these variables in the Railway service; enter secret values directly in Railway:

| Variable | Value |
|---|---|
| `SUPABASE_DB_HOST` | Supabase database host |
| `SUPABASE_DB_PORT` | Supabase database port (usually `5432`; use the port from connection details) |
| `SUPABASE_DB_NAME` | `postgres` unless Supabase specifies otherwise |
| `SUPABASE_DB_USER` | Supabase database username |
| `SUPABASE_DB_PASSWORD` | Database password entered privately |
| `SUPABASE_DB_SSLMODE` | `require` |
| `SMARTEXIT_API_URL` | `http://<private-node-service>.railway.internal:3001` |
| `SMARTEXIT_BRIDGE_SECRET` | A random secret of at least 32 characters |
| `REQUIRE_VERCEL_PROXY` | `1` |
| `PHP_PROXY_SECRET` | A separate random secret of at least 32 characters |
| `BINANCE_CREDENTIALS_KEY` | 32 random bytes encoded as 64 hex characters |
| `RESEND_API_KEY` | Optional Resend key for production email |
| `MAIL_FROM` | Optional sender on a Resend-verified domain |

### SmartExit API service

- Use the same repository.
- Root directory: `/smartexit`.
- Builder: Dockerfile (`/smartexit/Dockerfile`).
- Enable private networking; do not generate a public domain for this service.
- Set `SUPABASE_DB_*` to the same database connection, `SMARTEXIT_BRIDGE_SECRET` to the exact same secret as the PHP service, `HOST=0.0.0.0`, and `APP_ORIGIN` to the Vercel HTTPS origin.
- Set `NEAR_NETWORK=testnet` unless mainnet access is separately approved.

The Node API uses the same Supabase project but only accepts PHP-signed user requests through Railway private networking. It remains paper-only and does not place exchange orders.

Generate secrets locally instead of reusing passwords:

```powershell
php -r "echo bin2hex(random_bytes(32)), PHP_EOL;"
```

Use one generated value for `SMARTEXIT_BRIDGE_SECRET` and a separate generated value for `BINANCE_CREDENTIALS_KEY`. Paste each directly into the appropriate Railway variable fields. Never expose the Binance key or secret in application logs; Binance withdrawal permission must remain disabled.

## 3. Vercel

1. Import `ethcryptohub2/ETHcryptohub` from GitHub.
2. Use the repository root and the Vercel Node.js runtime for `api/proxy.js`.
3. Add `PHP_ORIGIN` as the Railway PHP service's HTTPS origin, with no trailing path or credentials (for example `https://your-php-service.up.railway.app`).
4. Add `PHP_PROXY_SECRET` with the exact secret configured on the Railway PHP service.
5. Deploy and confirm that `/`, `/login.php`, `/signup.php`, and `/dashboard.php` resolve through the proxy. The PHP service rejects direct requests that do not carry the signed proxy header.
6. Add the final Vercel origin to the Node API's `APP_ORIGIN`, redeploy that service, and verify SmartExit's authenticated API calls.

The proxy preserves methods, request bodies, cookies, status codes, and response headers. Do not expose the SmartExit API publicly.

## 4. Initial admin account

After deployment, use the existing protected admin setup flow to create the first administrator. Do not seed a shared/default password. Store the administrator credentials in a password manager and remove or disable any one-time setup route as directed by its page.

## 5. Verification

1. Confirm the Vercel landing page and PHP health route load.
2. Register a new account and verify that the Resend sender is configured before testing real inbox delivery. A local development OTP is never shown in production.
3. Sign in, open settings, and verify account changes persist after a service restart.
4. Open SmartExit and confirm its health status reports a connected database and `liveOrdersEnabled: false`.
5. Verify an account cannot read another user's SmartExit portfolio.

## Data and secret handling

- The public repository excludes `.env`, SQLite databases, database dumps, Node dependencies, built assets, and private key files.
- The database migrations contain schema only. Local accounts, trades, Binance credentials, passwords, and API keys are not uploaded.
- Rotate any secret that was ever committed or shared. Use Railway/Vercel/Supabase secret-variable interfaces for production values.
