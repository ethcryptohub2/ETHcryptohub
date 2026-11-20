# On-demand public market snapshot

The disabled-by-default Staging Admin route `POST /api/admin/public-market-snapshot` can prepare a finite ticker diagnostic on an eligible Vercel Preview. It requires Admin authorization, same-origin CSRF, the pinned Staging Supabase identity and a separate feature approval. The route accepts an empty request only. It makes one fixed Binance USD-M public HTTPS GET with a five-second request budget, no redirect or retry, a 1 MiB response limit and a shared-IP weight ceiling. A provider denial blocks further attempts in that running instance.

The result contains only timestamped, recent quotes for the fixed [20-symbol watchlist](../deploy/market-worker/soak-watchlist.json). Missing, stale or invalid rows are withheld and coverage is explicitly incomplete. Existing saved Standard and High-Risk results are fetched independently and retain their original timestamps. The diagnostic leaves Supabase caches and signal history intact and does not activate ingestion, alert delivery or execution.

The isolated Windows launcher can verify a Node 24 child environment offline. A live Windows run still requires a fresh execution approval and proves connectivity only from that workstation and network. [Windows preflight runbook](WINDOWS-FREE-PUBLIC-PREFLIGHT.md)

## Activation prerequisites

- Verify Preview plan eligibility, its approved geography and actual provider egress, and applicable access and data-use terms. Preserve the separation from Production.
- Establish a shared cooldown and denial stop for the entire deployment before recurring or multi-instance use. The current warm-instance cooldown resets during cold starts or scaling. Keep the route disabled while the deployment-wide request budget is unverified.
- Verify the existing Staging read schema and privileges. The diagnostic requires no new Supabase write path. Keep schedules, remote ingestion, migrations and worker activation outside this release.
- Treat twenty returned ticker quotes as coverage of this one snapshot. Qualification requires measured spread and depth over time. Research readiness further requires fresh sequence-verified ticker, trade and depth inputs. Cached REST quotes cannot validate CVD, book gaps, stream continuity or strategy performance.
