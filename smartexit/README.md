# SmartExit

SmartExit is a local-first, safety-first **paper-trading** dashboard for testing trade exit rules. It is not connected to an exchange and cannot send live orders.

## What works

- Create simulated LONG and SHORT positions with server-validated entry, stop, target, quantity, and trailing rules.
- Activate a trailing stop at TP1; TP1 and TP2 never sell part of the position. The whole paper position closes at TP3 or a protective stop.
- Sign in through the existing ETHcryptohub account and keep a separate paper portfolio for each PHP user account.
- View live Binance USDⓈ-M contract prices; open-position P&L refreshes about once per second from the public ticker stream, with a REST price fallback, and can trigger simulated TP/stop exits.
- Track the configurable starting USDT paper balance, realized USDT-equivalent P&L, unrealized P&L, quote-asset balances, trade history, risk limits, and an audit timeline.
- Review open and closed paper positions from the dashboard, including each closed trade's outcome, exit price, and realized P&L.
- Reset one signed-in wallet's paper portfolio atomically: remove its open/closed trades, events, realized P&L, and daily stats, restore $10,000 paper balance, and preserve its sign-in and risk limits.
- Persist paper accounts, trades, settings, sessions, and audit events in the project's Supabase Postgres database. Open positions remain open after a restart.
- Use a kill switch and daily loss / per-trade risk controls enforced by the API.
- View an honest `NOT_CONFIGURED` state for NEAR Intents. No token list, quote, swap, or transaction data is fabricated; swap submission is disabled.
- Browse active Binance USDⓈ-M futures contracts by quote asset, symbol, and 24-hour volume. Live data drives paper simulations only; no orders are sent to Binance.
- Scan every eligible Binance USDⓈ-M USDT perpetual using completed futures candles, EMA 9/20/50/100/200, RSI, MACD, rolling VWAP, Bollinger Bands, ADX, swing support/resistance, ATR/Supertrend, 24-hour momentum, and relative volume. Review risk-sized proposals and fill—not submit—the existing paper-trade form.

## ETHcryptohub integration

The protected `smartexit.php` page requires an active, verified ETHcryptohub session. Its same-origin PHP API proxy validates CSRF tokens and signs each request with a private `SMARTEXIT_BRIDGE_SECRET`; the Node API verifies that signature and maps the PHP user ID to an isolated paper portfolio. Keep this secret private and set the same value in the PHP and Node server environments.

The original NEAR wallet authentication code remains in the API, but the ETHcryptohub user interface does not request a second wallet login. Live Binance data is read-only and updates paper simulations only.

NEAR Intents is intentionally **future work**. The official [1Click API quickstart](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction) states that there is no NEAR Intents testnet and lists a JWT for its authenticated fee schedule. SmartExit is a testnet-first, paper-only app, so token swaps remain unavailable and disabled until a separately scoped, mainnet-only integration has explicit user approval, provider configuration, wallet transaction UX, and security review. NEAR Intents does not manage SmartExit paper futures positions.

## Requirements

- Windows 10/11 and PowerShell
- Node.js 22.5 or later (Node 24 LTS recommended)
- npm (included with Node.js)

The production API uses asynchronous PostgreSQL queries with a connection pool. Set `SUPABASE_DB_HOST`, `SUPABASE_DB_PORT`, `SUPABASE_DB_NAME`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD`, and `SUPABASE_DB_SSLMODE`; TLS certificate verification is always enabled, and plaintext/disabled SSL modes are rejected. Apply `supabase/migrations/202611050002_smartexit.sql` to the project's Supabase database before starting the API. Wallet sign-in defaults to NEAR testnet. Set `NEAR_NETWORK=mainnet` in `.env` only when connecting a mainnet wallet; the wallet selector and server-side account-key verification use the same configured network.

## Run on Windows

In PowerShell, install and build the web application once:

```powershell
Set-Location "C:\Users\91797\Ethcryptohub\smartexit"
npm.cmd ci
npm.cmd run build --workspace @smartexit/web
```

Set the Supabase database values in `.env` (copy `.env.example`) and apply the SmartExit migration. Generate a private bridge secret once and save it in your Windows user environment. Close and reopen your terminals so both servers inherit it:

```powershell
$secret = php -r "echo bin2hex(random_bytes(32));"
[Environment]::SetEnvironmentVariable("SMARTEXIT_BRIDGE_SECRET", $secret, "User")

# Terminal 1
# Open a new PowerShell window first.
Set-Location "C:\Users\91797\Ethcryptohub\smartexit"
npm.cmd run dev --workspace @smartexit/api

# Terminal 2
# Open another new PowerShell window.
Set-Location "C:\Users\91797\Ethcryptohub"
php -S 127.0.0.1:8000
```

Sign in at **http://127.0.0.1:8000/login.php**, then open **http://127.0.0.1:8000/smartexit.php** or select **SmartExit** from the user dashboard. The API listens on **http://127.0.0.1:3001** by default. `HOST` is configurable; use `HOST=0.0.0.0` on Railway so the service is reachable through its private network.

Copy `.env.example` to `.env` for local Node settings. `HOST` defaults to loopback locally; no local SQLite data file is used by the API.

For production, set `NEAR_NETWORK` deliberately and set `APP_ORIGIN` to the exact HTTPS frontend origin (for example `https://smartexit.example`). The frontend and API must be deployed on a compatible same-site origin for the Strict session cookie. The built-in rate limiter is per-process and in-memory; multi-instance deployments need a shared rate-limit store. Do not expose the API publicly without HTTPS and a deployment-specific review of proxy, rate-limit, and origin settings.

## Verify the project

Run these commands from the project directory:

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

The API tests use an isolated in-memory SQLite adapter only; production persistence is PostgreSQL. Tests do not connect to Supabase or require cloud credentials.

## Try the paper-trading flow

1. Sign in to ETHcryptohub. SmartExit uses that account and does not ask users to sign in to a second wallet.
2. Set your starting paper balance in USDT, then select **Trade intents** to create a LONG or SHORT paper setup.
3. Keep the app open to receive the Binance ticker stream or its one-second REST price fallback. Price changes update paper P&L and automatically simulate TP1/trailing/TP2/TP3 or stop transitions. The full paper position closes at TP3 or a stop.
4. Visit **Risk guardian** to change your paper equity and account-specific limits or test the kill switch. The kill switch pauses automatic price processing and blocks new trades.
5. Restart the API and sign in again to confirm account positions and portfolio balances persist.
6. Visit **NEAR Intents** to see why swaps are intentionally unavailable: the official service has no testnet, and this paper-only project does not request real-asset transactions.

The **Live trades** page remains disabled. SmartExit currently cannot place exchange orders or move wallet funds. Mainnet order execution, per-account live opt-in, exchange permission verification, protective-order placement, fill reconciliation, and continuous live-position monitoring are not implemented; do not treat saved Binance credentials as enabling live trades.

The prefilled form is a convenience/demo template only; its values are not market data. A paper position starts at the entry price you confirm. Manual simulated-price submission remains available for testing.

The **Risk guardian** page includes a wallet-scoped reset with a confirmation prompt. Resetting removes that wallet's open and closed trades, associated events, realized P&L, and daily risk statistics, then restores its paper balance to $10,000. Sign-in, other wallets, and configured risk limits are preserved.

The market selector reads public Binance USDⓈ-M contract metadata and 24-hour tickers; the browser uses Binance's public all-symbol WebSocket stream and polls its all-symbol price endpoint once per second if the stream is unavailable. Pairs are ordered by quote volume only within the selected quote asset. The selected live price is reference data and is copied into the editable paper entry only when you choose the price button. If both live sources are unavailable, displayed values can become stale and automatic paper exits pause; no fabricated fallback price is used.

## Market Scanner

Open **Market scanner** after signing in. The API ranks a configurable volume pool and adds up to five top gainers and five top losers from active Binance USDⓈ-M perpetuals. It requests up to 240 completed OHLCV candles with bounded concurrency. EMA 20/50/200, Wilder ATR/Supertrend, relative volume, and confirmed candle-swing support/resistance are displayed with timestamps, score coverage, warnings, and source. LONG/SHORT proposals require a clean EMA stack, matching Supertrend, aligned 24-hour momentum, relative volume at or above its 20-candle baseline, sufficient room to the nearest opposing swing pivot when one exists, and a score above the configured minimum. WAIT, stale, and unavailable signals are hidden; READY signals count down to the next candle close and expire when that candle closes. Stale data, insufficient candle history, and provider failures cannot create a proposal.

The score normalizes the available evidence: EMA alignment (30%), Supertrend alignment (20%), 24-hour momentum (15%), relative volume (15%), and support/resistance room (20% when a confirmed opposing pivot exists). Missing swing levels are excluded rather than counted as positive evidence. Price/volume indicators are not verified news/social sentiment, exchange inflow/outflow, or liquidation heatmaps; those are not included. Binance public market data cannot prove "smart money" activity. The score is not a probability of profit, and no scanner can guarantee near-perfect trades.

Proposals use the current ticker reference price, a stop distance of 1.5 × ATR, take-profit levels at 1R/2R/3R, and a quantity sized to the account's existing per-trade risk budget. Non-USDT quote budgets require a current Binance quote-to-USDT conversion. The Risk Guardian can suppress proposals when its kill switch, daily loss limit, or open-position cap blocks new trades. Clicking **Fill Paper Trade Form** only copies editable values into the existing form; the user must review and manually submit, and the API reruns all trade validations. Binance requests are read-only, and no exchange orders are sent.

## Safety and calculation limitations

- **Paper mode only. The Binance connection is read-only market data. No exchange order, wallet transaction, transfer, leverage, or real-money execution is implemented.**
- NEAR sign-in verifies a wallet signature and the public key's account association on the configured NEAR network (testnet by default). Portfolio funds are simulated only. Cookies are HttpOnly and SameSite; trade, event, risk, and portfolio data are scoped to the signed-in NEAR account.
- NEAR session mutations require an allowed `Origin`; sign-in challenges and logins are rate-limited per client IP. Production startup requires an explicit HTTPS `APP_ORIGIN`. These local safeguards do not replace a deployment security review.
- Each paper balance is denominated in USDT. Non-USDT quote assets remain separately displayed in their own units; their realized P&L is converted to USDT using the available live quote/USDT rate. An unavailable conversion blocks opening a position rather than silently mixing units.
- Live market prices can simulate TP/stop execution while the app is open. WebSocket/REST failures or network delays can affect simulation timing; these are not exchange fills or guaranteed execution prices.
- A TP1 or TP2 milestone retains the full simulated quantity. A stop wins over a target if both are determined to trigger on the same update.
- Simplified P&L is `(exit or current price - entry price) × quantity` for LONG and the inverse for SHORT. It excludes fees, funding, slippage, and liquidation; contract multipliers are not modeled.
- A simulated result is not a quote, trade, investment recommendation, or financial advice.
- Scanner levels are proposals based on delayed public market data and simplified paper sizing. The backend validates submitted values again; tick-size rounding, fees, funding, slippage, liquidation, and contract multipliers are not modeled.
- NEAR Intents token swaps are a separate integration and do not manage centralized-exchange futures positions.

## Project layout

- `apps/web`: responsive React + Vite + TypeScript UI
- `apps/api`: Express + TypeScript API, SQLite migration, risk checks, and trade state machine
- `data`: ignored local SQLite files
- `docs`: architecture, API, test, demo, build-status, and source specification

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/API.md](./docs/API.md), and [docs/TEST_PLAN.md](./docs/TEST_PLAN.md).

## Configuration and troubleshooting

The app runs without credentials. If `node:sqlite` is unavailable, install a supported Node.js version (22.5 or later), close old terminals, and reopen PowerShell. If ports 3001 or 5173 are in use, stop the conflicting local service or change `PORT` / the Vite proxy in the local configuration. Do not put credentials in the project; none are required.

If the browser says it cannot connect, the app's local servers are not running. From a new PowerShell window, run `Set-Location "$HOME\Downloads\SMARTEXIT"` and then `npm.cmd run dev`; keep that window open while using the dashboard. Leaving the browser tab open does not keep the local servers running.

The complete build specification is retained at [docs/SMARTEXIT_COPILOT_AGENT_PROMPTS.md](./docs/SMARTEXIT_COPILOT_AGENT_PROMPTS.md).
