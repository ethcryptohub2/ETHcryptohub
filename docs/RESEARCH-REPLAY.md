# Research decisions and historical replay foundation

These modules run locally with injected data. They do not submit orders, enable a worker, alter exchange credentials, apply migrations, or promise a win rate. A `READY_FOR_RESEARCH` classification is a research candidate, not execution authorization. Customer paper execution must still pass the independent deterministic risk governor.

## Research engine

`lib/intelligence/research-engine.ts` exports:

- `ResearchEngine.ingest(observation, now, { bars, onChain?, orderBook? })`: evaluates separate Standard and High-Risk policies and returns two explained decisions.
- `MemoryResearchJournal`: bounded, clone-isolated evidence records with `read`, `serialize` and `restore`.
- `ResearchEngine.snapshot()` / `restore()`: bounded histories, event ordering, cooldowns and feed-epoch state for restart recovery.
- `createOnChainResearchProvider(provider, read)`: optional injected transport with payload/freshness validation and failure isolation. It makes no request unless the caller provides and calls a transport.
- `analyzeOnChainContext` and `orderBookGapBps`: explicit unavailable results for absent, invalid, future or stale optional evidence.

Required observations use non-overlapping aggregate-trade interval notional. `quoteVolume` is NOT the ticker's cumulative 24-hour total; buy and sell notional must sum to no more than that interval's total. The feed's `takeObservation` projection has the matching semantics. Relative volume and acceleration compare notional per second using `volumeIntervalMs`; legacy inputs can infer an interval only from consecutive increasing event timestamps, discarding the first unrated sample. This prevents a long publication batch from pretending to be a volume spike. A volume window older than the required freshness bound cannot become READY. Duplicate or out-of-order event timestamps do not enter research baselines. Volume history is limited to the last 60 seconds and 256 samples per symbol, with a 2,000-symbol cap. Unicode exchange symbols are retained with normalized case.

Observation fields are allowlisted: extra customer identifiers or credential fields are rejected and never retained in shared history or serialized evidence. Restored histories use the same validation. Invalid events cannot change the current feed epoch, and rejected stale-volume windows do not enter later relative-volume or cumulative-flow baselines.

Minimum liquidity uses the explicitly named `volumePerSecond` policy field, not raw publication-batch notional. The thin-depth proxy compares book notional with a disclosed one-second flow reference. Equivalent flow rates across different valid publication durations therefore have the same liquidity checks. These fixed research thresholds are assumptions, not thresholds validated on production market performance.

The engine measures relative volume, acceleration, aggressive buy/sell ratio, windowed cumulative volume delta, bid/ask notional imbalance, thin-depth proxy, optional actual depth-level gaps, optional open-interest changes and funding context, price breaks and ATR-relative volatility expansion. Closed OHLC bars provide EMA and SuperTrend context. Bars must already be closed and available at evaluation time. The most recent closed context must be within five minutes; absent or insufficient context yields WATCH, not an invented trend.

Standard and High-Risk differ in warmup, EMA lengths, spread/depth-gap filters, relative-volume thresholds, ranking, stop distance, expiry and symbol cooldown. Stops and 2R research targets are derived from measured ATR; invalid risk geometry fails closed. Policies are fixed research settings, not optimized parameters or profitability claims. Stale, future, invalid or discontinuous required feed data overrides the score. Feed-epoch changes discard prior volume context and require new closed context before readiness. Previously issued decisions remain immutable; consumers must enforce their expiry and current market freshness.

Every returned classification includes reasons and evidence. Exchange flow is labeled unidentified exchange order flow, never confirmed whale activity. Optional on-chain evidence carries provider attribution, confidence, time and netflow when actually supplied; no exchange-trader-to-wallet identity is inferred. Thin aggregate depth is distinguished from measured gaps between actual order-book price levels. Missing optional open-interest, funding, on-chain or level-gap evidence stays null/unavailable.

**Persistence boundary:** the default journal is a bounded in-memory research log, not a production database archive. The injectable `ResearchJournal` and serializable engine/journal state permit local replay and restart tests. Before persistent worker activation, supply a durable journal/state adapter with transactional write guarantees, retention policy and approved schema. No production persistence or full-history archive is claimed by the in-memory implementation.

## Event-driven replay

`lib/intelligence/research-replay.ts` exports `replayResearch(events, options)` and `walkForwardEvaluation(events, options)`.

Input events are ordered by availability time: closed BAR events, OBSERVATION events, executable TRADE prints and explicit FUNDING events. A bar cannot be used before both its close and availability time. Out-of-order events, future test warmup and future bars are rejected. No future event participates in candidate generation; the optional missed-opportunity proxy is explicitly retrospective evaluation.

Standard and High-Risk each receive an independent hypothetical account. Defaults are initial equity 10,000, 4 bps fee per fill, 2 bps adverse slippage, 2 bps spread, 100 ms entry and exit latency, 10% participation in each replay trade's available quantity, 10% allocation ceiling and 1% stop-risk sizing. These are disclosed assumptions, not measured execution quality. Only one simulated position per strategy is allowed. No artificial minimum trade count is imposed.

Entry and exit fills are bounded by trade-print quantity and participation. Partial entries use weighted execution prices. A stop or other exit intent latches across partial fills, waits the configured latency, and executes at subsequent known prices with adverse friction; a recovered price does not erase a triggered stop. Funding applies only to positions actually open at the supplied funding event, with the correct long/short sign. No funding rate is invented if events are missing. Research expiry cancels unfilled entries. Open positions are marked to the most recent accepted fresh observation or trade print; invalid/stale observations cannot revalue them. The replay does not invent an end-of-file closing fill.

Reports separate completed realized trades from open exposure and include fills, fees, funding cost, equity curve, drawdown, net expectancy, profit factor, trade frequency, opportunity frequency and classification counts. Missing profit-factor/expectancy denominators are null. `missedOpportunityProxies` counts WATCH observations followed by a favorable 1R move before research expiry; it does not prove an executable or profitable missed trade. Fixed-policy walk-forward windows show training and chronological out-of-sample results without tuning on the test segment. This is validation machinery, not proof of a strategy edge.

Replay output is marked `simulation: true` and `realExchangePerformance: false`. Tests use synthetic fixtures only; those values are never published as live prices or real performance.

## Validation and activation limits

Focused tests cover explained long/short candidates, required-data rejection, spread/liquidity gates, closed-context availability, duplicate and restart cooldowns, epoch resets, Unicode symbols, optional on-chain transport validation, real depth gaps, long/short paper fills, latency, partial fills and latched stops, friction/funding, look-ahead rejection, walk-forward separation and empty/open result reporting.

Run:

```
node --test lib/intelligence/research-engine.test.mjs lib/intelligence/research-replay.test.mjs
```

Remote ingestion and customer paper activation still require the separately reviewed worker, durable storage, tenant/risk service and approved operational activation. Fresh Staging market data is not restored merely by adding these modules. No historical replay on a real acquired dataset, walk-forward profitability result or real exchange performance is claimed.
