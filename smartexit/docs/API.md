# HTTP API

Base URL: `http://localhost:3001/api`. JSON responses use `{ "data": ... }` on success and `{ "error": { "code": "...", "message": "..." } }` for errors. Validation errors include safe field-level details. No API performs live exchange orders.

## Routes

| Method | Path                                       | Purpose                                                                         |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------- |
| GET    | `/health`                                  | PAPER mode and SQLite availability                                              |
| GET    | `/auth/near/config`                        | Wallet network selected by `NEAR_NETWORK`                                       |
| POST   | `/auth/near/challenge`                     | Create a short-lived NEP-413 wallet sign-in challenge                           |
| POST   | `/auth/near/login`                         | Verify the wallet signature and set an HttpOnly account session cookie          |
| GET    | `/auth/me`                                 | Read the current signed-in account, or `null`                                   |
| POST   | `/auth/logout`                             | Revoke the current account session                                              |
| GET    | `/portfolio`                               | Read USDT balance/P&L and separate balances for other quote assets              |
| POST   | `/portfolio/reset`                         | Delete this wallet's paper history and restore its balance to $10,000           |
| PUT    | `/portfolio/balance`                       | Set the account's starting simulated USDT balance                               |
| GET    | `/trades?limit=50&offset=0`                | Recent paper trades                                                             |
| POST   | `/trades`                                  | Create a risk-checked paper trade                                               |
| GET    | `/trades/:id`                              | Read a trade                                                                    |
| POST   | `/trades/:id/price`                        | Process one idempotent simulated price update                                   |
| POST   | `/trades/market-prices`                    | Apply Binance stream prices to this account's open paper trades                 |
| POST   | `/trades/:id/cancel`                       | Close an open paper position at its current simulated price and record an event |
| GET    | `/risk`                                    | Settings, open positions, and UTC daily risk                                    |
| PUT    | `/risk`                                    | Update validated paper risk settings                                            |
| POST   | `/risk/kill-switch`                        | Set `{ "enabled": true }` or `false`                                            |
| GET    | `/events?limit=50&offset=0&tradeId=<uuid>` | Read audit events                                                               |
| GET    | `/markets/futures-symbols`                 | Read live, volume-ranked Binance USDⓈ-M futures contracts                       |
| GET    | `/market-scanner/candidates`               | Authenticated, risk-aware market scan and paper-trade proposals                 |
| GET    | `/near-intents/status`                     | Honest provider status                                                          |
| GET    | `/near-intents/tokens`                     | Empty list while not configured                                                 |
| POST   | `/near-intents/quote`                      | Explicit unavailable response                                                   |
| POST   | `/near-intents/swap`                       | Disabled response                                                               |

Trade creation requires `side`, `entryPrice`, `quantity`, `initialStop`, `tp1`, `tp2`, and `tp3`. `symbol` defaults to `BTCUSDT`; `trailingPercent` defaults to `1`. LONG price ordering is stop < entry < TP1 < TP2 < TP3. SHORT ordering is TP3 < TP2 < TP1 < entry < stop.

All trade, event, risk, and portfolio routes require the HttpOnly session cookie from NEAR wallet sign-in. Health, market-symbol data, and sign-in config/challenge/login endpoints are public. NEAR sign-in requires a one-time NEP-413 message signature and a read-only access-key lookup on the configured network; `NEAR_NETWORK` defaults to `testnet` and may be set to `mainnet`. The API returns the configured network to the web client so Wallet Selector and server verification stay aligned. No wallet transaction is requested.

`POST /portfolio/reset` is scoped to the signed-in wallet and runs atomically. It removes that wallet's trades, their trade events, and daily risk statistics; resets realized P&L and paper asset balances; and restores a $10,000 USDT balance. It preserves wallet authentication, other accounts, and configured risk limits (including the kill-switch state).

Challenge and login requests must include an allowed `Origin`, and challenge recipients must match it. These endpoints are limited to 20 and 10 requests per client IP per 10-minute window, respectively. The limiter is in-memory and per-process; multi-instance deployments need a shared rate-limit store. Authenticated state-changing requests also require an allowed `Origin`; the session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` in production. Set `APP_ORIGIN` to one or more comma-separated exact origins; production requires HTTPS origins. If deployed behind a reverse proxy, configure trusted proxy addresses deliberately so rate limits use the real client IP without trusting arbitrary forwarded headers. Production deployments also need HTTPS and a frontend/API topology compatible with the Strict cookie.

Expired sessions are rejected by authentication and removed when a new NEAR challenge is requested; expired challenges are removed on challenge creation. Starting paper balance is denominated in USDT. Non-USDT P&L is held and displayed separately in its quote asset; when an asset/USDT rate is available, realized P&L is also converted for the USDT account balance and risk checks.

Example price update:

```json
{
  "eventId": "c8983db8-f78e-4e51-8507-637a40ed7e74",
  "price": 66000
}
```

The API requires a UUID `eventId`. Reusing an event ID for the same trade returns the existing state with `meta.duplicate: true`. Reuse against another trade is a conflict. Price changes after terminal state are rejected.

`GET /markets/futures-symbols` reads Binance's public USDⓈ-M `exchangeInfo` and all-symbol 24-hour ticker endpoints. It returns only contracts whose current exchange status is `TRADING`, including perpetual and delivery contracts. Optional `quoteAsset`, `minimumVolume`, and `search` query parameters filter the complete market list. Ticker snapshots are cached for at most 30 seconds; quote volume is denominated in each pair's quote asset. The browser consumes Binance's all-symbol futures WebSocket stream and polls the public all-symbol `ticker/price` endpoint once per second if the socket is unavailable. `POST /trades/market-prices` applies those prices to open paper positions and records only milestone/exit events. This simulates exits but never creates exchange orders. An upstream REST failure returns `502 MARKET_DATA_UNAVAILABLE`, not fabricated symbols or prices.

`GET /market-scanner/candidates` requires an authenticated paper account. Supported query parameters are `quoteAsset`, `timeframe` (`5m`, `15m`, `1h`, or `4h`), `minimumVolume`, `limit` (1–30 top-volume contracts), `atrPeriod` (2–50), `multiplier` (0.5–10), `maxAgeSeconds` (30–86400; default 1800), and `minimumScore` (0–100). The scanner also includes up to five positive 24-hour movers and five negative movers, deduplicated against the volume pool. It calculates EMA 20/50/200, ATR/Supertrend, relative volume, and nearest confirmed candle-swing support/resistance from completed candles. Missing or conflicting evidence leads to WAIT; the score is a normalized ranking, never a profit probability. News/social sentiment, liquidation heatmaps, and verified smart-money flows are not provided. Proposals use the authenticated user's Risk Guardian budget and are suppressed when new positions are blocked; non-USDT quotes require an available quote-to-USDT rate. The response is informational: trade creation must still be reviewed and submitted through `POST /trades`, which independently validates risk and price levels.

## Safe errors

Common codes: `AUTH_REQUIRED`, `NEAR_AUTH_ERROR`, `QUOTE_CONVERSION_UNAVAILABLE`, `VALIDATION_ERROR`, `INVALID_LEVEL_ORDER`, `TRADE_RISK_TOO_HIGH`, `MAX_OPEN_POSITIONS`, `DAILY_LOSS_LIMIT`, `KILL_SWITCH_ENABLED`, `NOT_FOUND`, `TRADE_ERROR`, `NOT_CONFIGURED`, and `SWAP_DISABLED`. Server errors do not return stack traces.
