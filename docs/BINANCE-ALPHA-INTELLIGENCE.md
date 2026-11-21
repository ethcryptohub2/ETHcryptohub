# Binance Alpha Intelligence

## Source and approval boundary

The Alpha adapter uses only the documented unsigned public Binance Alpha REST host. The dashboard starts with acquisition disabled. No scraping, automatic polling, provider accounts, API keys, external paid feeds or data writes are enabled. Public API documentation establishes request and response formats. Confirm regional access, terms of use, display and retention rights, and published limits and costs before any request. Neither eligibility nor cost has been verified for the actual Staging egress. [Alpha market-data API](https://developers.binance.com/en/docs/catalog/advanced-trading-alpha-trading/api/rest-api/market-data) · [Binance Terms](https://www.binance.com/en/terms)

| Observation | Supported source and scope |
|---|---|
| Token, chain and contract | Token List provides registry identity and chain metadata. Registry quotes, market cap, transfer flags, holder counts and promotional scores are excluded from trading or risk conclusions. |
| Listed market | Exchange Info validates the exact active Alpha trading pair. The adapter prefers USDT and supports USDC if USDT is unavailable. A registry entry alone does not establish a supported market. |
| Momentum and 24-hour volume | Ticker supplies 24-hour price change and reported quote volume. The response must match the requested pair and have a window close no older than 60 seconds at ingestion. |
| Volume change | Klines compares the last two complete, contiguous UTC daily quote-volume amounts. It ignores an unfinished candle and withholds change when the prior denominator is zero. |
| Available liquidity | Full Depth requests five levels per side and sums their price times quantity by side in the quote currency. The book must be current, uncrossed, correctly ordered and match the requested market. It describes sampled Alpha order-book depth. |
| Exchange and wallet flows | Unavailable until licensed or permitted chain sources and verified entity attribution exist. Exchange trades and taker direction do not establish wallet deposits or withdrawals. |
| Holder concentration and contract risk | Unavailable until a supported chain source verifies holders, supply treatment, and permissions. A holder count is insufficient to infer concentration. No synthetic score is displayed. |
| Campaigns and news | Use only approved official announcements or licensed news evidence. Campaign promotion is separate from momentum, liquidity and contract risk. |
| X, YouTube and community anomalies | Unavailable pending approved APIs, access terms, quotas, and retained baselines. Missing data stays missing. Observed activity and inferred sentiment require separate provenance. |

The adapter can validate a finite discovery and observation batch using an explicitly injected connection. It makes at most eight sequential requests. Two requests cover discovery and at most three requests each cover two approved token IDs. It applies a three-second request deadline, a twelve-second run deadline, a two-mebibyte response cap, and no redirects, credentials, retries or fallback. A failed response stops the batch and remaining fields stay unavailable. Source health reports last validation per source. Row timestamps distinguish the provider price/depth observation from the run's collection time.

## Candidate sources kept inactive

- Etherscan lists its top-token-holder API as a PRO endpoint. It is an example of a chain-specific attribution source, with cost and supported-chain coverage subject to separate review. [Etherscan top holders](https://docs.etherscan.io/api-reference/endpoint/topholders)
- X documents metered resource reads and developer credits. No X credits or API access were acquired. [X API pricing](https://docs.x.com/x-api/getting-started/pricing)
- YouTube Data API publishes method quotas, including a default daily bucket of 100 search calls. It requires an approved API project, actual quota verification, and confirmation of the intended evidence retention and use. [YouTube quota calculator](https://developers.google.com/youtube/data/determine_quota_cost)
- Official Binance announcement links can serve as manually reviewed campaign evidence. Automated collection, indexing and retention are pending access and licensing review. [Binance announcements](https://www.binance.com/en/support/announcement)

The protected Admin control can request one separately approved acquisition. It uses an empty CSRF-protected POST to `/api/admin/alpha-intelligence`. The exact Staging Preview commit and a UTC expiry must be set through `SMARTEXIT_ALPHA_INTELLIGENCE_APPROVED_SHA` and `SMARTEXIT_ALPHA_INTELLIGENCE_APPROVED_UNTIL`. `SMARTEXIT_ALPHA_INTELLIGENCE_TOKEN_IDS` must name one or two explicitly authorized Alpha registry IDs. The default readiness GET makes no request to Binance. Results remain in the requesting page. The Alpha authorization is separate from USD-M Futures access.

## Separation from execution and History

Alpha observations remain research only. Alpha instruments do not enter Futures signal History, trading tables, or order preparation. A later separately approved observation store should persist Alpha namespace, chain and contract, provider pair and source references, market and collection timestamps, measurement freshness, and unavailable fields. Use an idempotency key derived from source and observation timestamp. Store any derived sentiment separately with its model, methodology and evidence. No database migration or remote persistence is part of this module.
