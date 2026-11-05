# SmartExit

SmartExit is a safety-first **paper-trading** workspace integrated with the ETHcryptohub Next.js app. Market data is read-only; the application does not send live exchange orders.

## Features

- Paper LONG and SHORT trade intents with server-validated entries, stops, targets, and trailing rules.
- User-scoped paper portfolios, balances, risk settings, and audit events stored in Supabase PostgreSQL.
- Binance USDⓈ-M market data and paper-position monitoring.
- Risk Guardian controls, daily loss limits, and a kill switch.
- Binance futures scanner for eligible USDT perpetual pairs.
- Live order placement and NEAR Intents transactions remain disabled.

## Run the API locally

Requirements: Node.js 22 or later and npm.

1. Apply `supabase/migrations/202611050002_smartexit.sql` and configure the `SUPABASE_DB_*` variables in the API environment.
2. Set `SMARTEXIT_BRIDGE_SECRET` to the same private value configured in the root Next.js app and set `APP_ORIGIN` to `http://localhost:3000`.
3. From the repository root, install the SmartExit workspace dependencies and run the API:

```powershell
npm.cmd --prefix smartexit ci
npm.cmd --prefix smartexit run dev --workspace @smartexit/api
```

The API listens on `http://127.0.0.1:3001` by default. In the root `.env.local`, set `SMARTEXIT_API_URL=http://127.0.0.1:3001`. The Next.js bridge permits local HTTP for development; deployed services must use HTTPS.

## Validate

From the repository root:

```powershell
npm.cmd --prefix smartexit run test
npm.cmd --prefix smartexit run lint
npm.cmd --prefix smartexit run typecheck
```

The API tests use an isolated test database adapter. They do not connect to production Supabase.

## Safety status

SmartExit remains paper-only. Binance key storage and account access checks do not enable trading. Do not enable withdrawal permissions. Live order execution, exchange-side protective orders, fill reconciliation, and continuous live-position monitoring are not implemented.
