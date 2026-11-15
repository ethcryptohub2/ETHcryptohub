# ETHcryptohub

ETHcryptohub is a Next.js 16 application for account verification, user settings, administration, public futures market information, and technical scanning.

- Next.js App Router, React, and TypeScript; no PHP runtime or `.php` routes.
- PostgreSQL on Supabase, accessed server-side with parameterized queries.
- Email verification through Resend; password hashes use bcrypt.
- User sessions are stored as hashes in PostgreSQL and protected by secure, HTTP-only cookies.
- Binance API credentials are encrypted at rest in separate Demo and Live records. Futures order placement and per-environment auto-trading require explicit deployment gates and user confirmation; all order-submission gates are off by default.
- The scanner uses Binance USDⓈ-M USDT perpetuals as its authoritative market universe. Eligible pairs are synchronized into an admin-managed database table, and scheduled background batches run the existing technical and configured research pipeline. Admin-disabled pairs stay disabled across synchronization. Admins can add encrypted Glassnode, CryptoPanic, and CoinGlass keys for optional research context.
- The verified crypto news feed uses configurable server-side CryptoPanic, RSS/Atom, and mapped JSON adapters. Admin review controls publishing, credentials are encrypted, and the authenticated UI can receive Supabase Realtime updates.
- Signal and market data are informational. The gated Futures order flows route through fixed, environment-specific Demo/Live adapters; automatic signal processing is environment-specific and remains off by default. Do not enable either environment until its deployment and exchange checks pass.
- Binance remains the only customer-ready SmartExit execution integration. A fixed-endpoint Bybit V5 Demo adapter and Admin-only Demo testing lab are implemented, but Bybit customer execution is not wired into the SmartExit engine and remains disabled. OKX, Bitget, and Gate.io are registry-only and disabled.
- Standard and High-Risk strategy profiles are stored separately and shown in Settings. Customer execution remains locked pending Binance Demo verification of the native TP1-activated 1% trailing-stop lifecycle, the scheduled protection reconciler, and strategy-specific tests; High-Risk signals do not currently provide a verified TP3 execution path.

## Local development

Requirements: Node.js 22 or later and npm.

```powershell
npm.cmd ci
Copy-Item .env.example .env.local
npm.cmd run dev
```

Set the database and authentication values in `.env.local` before using database-backed pages. Apply the required migrations listed in [DEPLOYMENT.md](./DEPLOYMENT.md) in order. Do not commit `.env.local`.

Open `http://localhost:3000`. The dashboard provides market information, account settings, and optional separate Demo/Live Binance API credential entry. The Exchange Connections page lists provider availability; Bybit Demo API operations can only be exercised by an Admin in the testing lab and require that Admin's own Demo credentials. Do not enable Futures order submission without completing the Demo and production safeguards in [DEPLOYMENT.md](./DEPLOYMENT.md).

## Validation

```powershell
npm.cmd run build
npm.cmd run typecheck
npm.cmd run lint
npm.cmd --prefix smartexit run test
```

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Supabase migration and Vercel environment setup. A successful local build does not mean the production site is deployed: database migrations and private Vercel environment variables must be configured before production authentication and email delivery will work.
See [STAGING_SETUP.md](./STAGING_SETUP.md) for isolated Supabase/Vercel Preview configuration and fail-closed deployment preflight requirements.

Never send production credentials, Binance API secrets, or database passwords through chat or commit them to source control.
