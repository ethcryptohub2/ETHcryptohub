# ETHcryptohub

ETHcryptohub is a Next.js 16 application for account verification, user settings, administration, public futures market information, and technical scanning.

- Next.js App Router, React, and TypeScript; no PHP runtime or `.php` routes.
- PostgreSQL on Supabase, accessed server-side with parameterized queries.
- Email verification through Resend; password hashes use bcrypt.
- User sessions are stored as hashes in PostgreSQL and protected by secure, HTTP-only cookies.
- Binance API credentials are encrypted at rest. The Binance integration is read-only; live order submission is disabled.
- The scanner uses Binance USDⓈ-M USDT perpetuals as its authoritative market universe. Eligible pairs are synchronized into an admin-managed database table, and scheduled background batches run the existing technical and configured research pipeline. Admin-disabled pairs stay disabled across synchronization. Admins can add encrypted Glassnode, CryptoPanic, and CoinGlass keys for optional research context.
- The verified crypto news feed uses configurable server-side CryptoPanic, RSS/Atom, and mapped JSON adapters. Admin review controls publishing, credentials are encrypted, and the authenticated UI can receive Supabase Realtime updates.
- The application is informational only: paper-trading UI, routes, and wallet features are disabled.

## Local development

Requirements: Node.js 22 or later and npm.

```powershell
npm.cmd ci
Copy-Item .env.example .env.local
npm.cmd run dev
```

Set the database and authentication values in `.env.local` before using database-backed pages. Apply the required migrations listed in [DEPLOYMENT.md](./DEPLOYMENT.md) in order. Do not commit `.env.local`.

Open `http://localhost:3000`. The dashboard provides market information, account settings, and optional Binance API credential entry for read-only connectivity checks.

## Validation

```powershell
npm.cmd run build
npm.cmd run typecheck
npm.cmd run lint
npm.cmd --prefix smartexit run test
```

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Supabase migration and Vercel environment setup. A successful local build does not mean the production site is deployed: database migrations and private Vercel environment variables must be configured before production authentication and email delivery will work.

Never send production credentials, Binance API secrets, or database passwords through chat or commit them to source control.
