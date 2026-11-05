# ETHcryptohub

ETHcryptohub is a Next.js 16 application for account verification, user settings, administration, Binance USDⓈ-M market scanning, and SmartExit paper trading.

- Next.js App Router, React, and TypeScript; no PHP runtime or `.php` routes.
- PostgreSQL on Supabase, accessed server-side with parameterized queries.
- Email verification through Resend; password hashes use bcrypt.
- User sessions are stored as hashes in PostgreSQL and protected by secure, HTTP-only cookies.
- Binance API credentials are encrypted at rest. The Binance integration is read-only; live order submission is disabled.
- SmartExit's existing paper-trading API can run as a separate Node service and is called through an authenticated Next.js server-side bridge.

## Local development

Requirements: Node.js 22 or later and npm.

```powershell
npm.cmd ci
Copy-Item .env.example .env.local
npm.cmd run dev
```

Set the database and authentication values in `.env.local` before using database-backed pages. Apply the Supabase migrations in order: `202611050001_initial_schema.sql`, `202611050002_smartexit.sql`, and `202611050003_nextjs_auth.sql`. Do not commit `.env.local`.

Open `http://localhost:3000`. To use the full SmartExit paper-trading desk, run its Node API separately and set `SMARTEXIT_API_URL` and `SMARTEXIT_BRIDGE_SECRET` in the Next.js environment. The API requires the same bridge secret and the app origin; see [SmartExit setup](./smartexit/README.md).

## Validation

```powershell
npm.cmd run build
npm.cmd run typecheck
npm.cmd run lint
npm.cmd --prefix smartexit run test
```

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Supabase migration, Vercel environment, and SmartExit API setup. A successful local build does not mean the production site is deployed: database migrations and private Vercel environment variables must be configured before production authentication and email delivery will work.

Never send production credentials, Binance API secrets, or database passwords through chat or commit them to source control.
