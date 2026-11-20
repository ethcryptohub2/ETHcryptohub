# Free Windows public-only preflight — preparation, not execution approval

Prepared 20 November 2026. This replaces paid-host recommendations for the current task. No cloud account, VM, subscription, package installation or paid upgrade is needed. It uses the existing Windows machine, installed Node 24 and existing network. If that network's data charges are unacceptable, do not run; no connectivity cost or infrastructure purchase is authorized. No live Binance request was made during preparation.

## Implementation and boundaries

`scripts/windows-public-preflight.mjs` reuses BinanceMarketFeed, subscriptionPlan, the exact 20-symbol watchlist and qualifyPublicPreflight. It does not construct/start PublicMarketWorker, open a journal/importer/database, run migrations, send notifications, install a service, enable auto-start/CRON or execute orders. The default/import path performs no network or filesystem work. An explicit execution flag and operator eligibility assertion are required. Node major version 24 is enforced. It refuses inherited application/trading credentials, proxy and TLS-override configuration without displaying values; it never reads .env or secret files. Use a clean process environment, not a web application launch environment.

`public-preflight-wire.mjs` uses only Node HTTPS/crypto built-ins. It verifies TLS/SNI through the default certificate checks and records certificate fingerprint/protocol/expiry. REST is limited to public GET requests on fapi.binance.com for ping, server time, exchange information, and 24-hour ticker and depth-100 snapshots for the selected symbols. WebSocket uses the routed combined market and public streams on fstream.binance.com. Private/account/order endpoints, alternate hosts, redirects, custom symbols and authentication headers are not accepted. DNS records IPv4/TTL and pins those answers into HTTPS/WSS lookup; private/reserved address responses are rejected. Evidence is IPv4-only. [Binance WebSocket routes and limits](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Connect).

The frame-capable diagnostic validates the WebSocket upgrade accept, server masking/opcodes/lengths/UTF8 and fragmented text; handles interleaved control pings and writes masked pongs with the identical payload. Evidence records payload hashes and separate ping/pong-write timestamps, not credentials or raw frame text. Pong evidence records the local socket write. It requires at least two observed server control pings and matching individual pong writes on each of three connections; it never infers this from an open socket or application JSON ping. There is no reconnect loop or endpoint/proxy bypass.

Normal duration is 8 minutes; one hard 15-minute abort controller covers DNS, HTTP and WSS, with 10-second HTTP and handshake inactivity timeouts. Signal cancellation, denial, malformed/over-cap traffic, clock offset above 1 second or detected continuity loss close sockets. Normal completion closes sockets before aborting outstanding work. DNS resolution uses bounded attempts and cancellation. Offline dependency injection must be explicitly labelled; fixture evidence says OFFLINE_FIXTURE and liveProviderPreflightExecuted false.

REST calls are serialized at least 1 second apart. The rolling budget is the smaller of 250 request weight per minute or half the published exchangeInfo minute limit; unsupported/unverifiable limit definitions stop. Shared-IP usage of 300 request weight or more also stops. The complete nominal plan is 263 requests with a total conservative weight of 1,223. It sends 3 setup calls, 20 initial depth snapshots, 220 qualification depth reads and 20 final ticker calls. There are no retries on 429/418/403/451, redirects or other HTTP errors; Retry-After is retained and the process stops. Do not rerun around a denial. WebSocket pong rate is capped below the provider's 10 incoming-message/s ceiling. Each frame/body is bounded to 4 MiB, total decoded WS text to 256 MiB, evidence arrays bounded; network/TLS/HTTP overhead is additional. No full market-data archive is produced.

Depth books are initialized early, then U/u/pu continuity and trade IDs are checked by the reused feed. Eleven book samples per symbol span at least 5 minutes near the end; final REST tickers and exchange eligibility feed the existing qualification thresholds. All 20 must be currently eligible and qualify; no substitutions. Final selected feed health must also be fresh/sequence-valid. All-universe ticker coverage is reported independently; ticker-only data never becomes a research signal. Failure, absent control frames, stale samples or missing evidence cannot produce COMPLETE_LOCAL_EVIDENCE. This finite result covers only the finite Windows session and leaves 24-hour reliability, legal clearance, cloud connectivity and website freshness unverified.

## Exact future operator command — run only after separate approval

From `C:\Users\91797\Ethcryptohub`, using the already available Node 24 binary:

```powershell
$node24 = 'C:\Users\91797\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node24 --version
$runFolder = Join-Path (Get-Location) ('tmp\public-preflight-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
& $node24 .\scripts\windows-public-preflight.mjs --execute-approved-public-only --eligibility-confirmed --output $runFolder
```

The output folder must not exist. Exit code 0 means COMPLETE_LOCAL_EVIDENCE; exit code 1 means ABORTED, INCOMPLETE or refused startup. Ctrl+C stops provider traffic. Do not set persistent-worker approval variables, start the worker CLI or copy credentials. The flag records the operator’s eligibility assertion. Obtain that eligibility decision and explicit finite Windows-network-run approval first. No agreement is accepted automatically.

Optional offline packaging: `node scripts/build-windows-preflight-bundle.mjs <new-local-directory>` extends the existing exclusive six-source-file worker bundle with four allowlisted diagnostic/watchlist files, SHA256 manifest and no dependencies/install hooks. Deploy nothing. The artifact's worker remains separately guarded and is not invoked by the diagnostic. Node 24 Windows and Linux ARM64 binaries are listed in the [official release](https://nodejs.org/en/blog/release/v24.22.3).

## Seven expected local evidence files

- dns.json: IPv4 answers/TTLs and lookup durations for the two fixed hosts.
- http.json: paths, status, RTT, authorized TLS facts, used-weight and Retry-After; no response bodies, cookies or auth headers.
- websocket-control.json: upgrade RTT and TLS facts, server control pings and matching pong writes.
- feed-health.json: bounded sample-round continuity/freshness and separate universe ticker coverage.
- qualification-input.json: exact 20-symbol metadata, recent tickers and normalized five-minute depth samples, tagged windows-local.
- qualification-result.json: offline eligibility/liquidity/volatility evaluation; legal/cloud access remains unestablished.
- summary.json: start/end, duration, abort reason, clock offset, RTT p95, ping/pong counts, final coverage and explicit WINDOWS_LOCAL_NOT_CLOUD scope.

An abort may leave null/partial evidence; preserve it and do not reinterpret it as a pass. File write errors are failures, not proof of network success. Keep evidence outside Git and inspect it privately before sharing. A Windows result proves nothing about Singapore, Oracle egress, future VM capacity or applicable cloud/provider eligibility. Paid DigitalOcean plans remain unapproved. Oracle is checklist-only: see ORACLE-ALWAYS-FREE-CHECKLIST.md.
