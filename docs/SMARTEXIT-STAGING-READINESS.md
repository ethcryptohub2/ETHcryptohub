# SmartExit Staging readiness

Reviewed 20 November 2026.

## Free scanner

- Vercel Hobby can serve a finite Admin request within its function and usage limits for eligible personal or non-commercial use. Commercial use is a blocker for this free-host proposal. This repository declares the Mumbai region. Provider eligibility and reachability from the actual function egress remain unverified. [Vercel Hobby](https://vercel.com/docs/plans/hobby) · [Hobby terms](https://vercel.com/legal/terms) · [Function limits](https://vercel.com/docs/functions/limitations)
- Supabase Free lists 500 MB database storage, 5 GB egress and project pausing after a week of inactivity. Current account-wide quotas and remaining usage are unverified. Retain bounded snapshots rather than raw high-frequency data. [Supabase Free](https://supabase.com/pricing)
- The Windows launcher is a finite diagnostic with a minimal child environment. Persistent order book continuity requires a separate continuously available host and an approved soak. Review the existing [Oracle checklist](ORACLE-ALWAYS-FREE-CHECKLIST.md) for a free-host candidate. No provider preflight or worker activation occurred in this release.

The optional serverless scanner is an Admin-only POST with the existing same-origin CSRF guard and Staging target check. It is disabled by default. It accepts no body, symbol override or endpoint override. It issues one fixed, unsigned Binance USD-M all-symbol 24-hour ticker GET (weight 40), caps the body at 1 MiB, times out provider access after five seconds and returns only allowlisted quotes with recent ticker timestamps. Provider denial disables repeat requests on that warm instance. [Binance market data documentation](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)

The cooldown applies per warm instance. Distributed egress protection and quota headroom must be demonstrated before enabling this feature on serverless infrastructure. A ticker timestamp describes the snapshot. It does not establish the time of the last trade or validate depth sequence, trade flow or signal inputs. The existing projection and scanner research continue serving their independently validated cache. The snapshot trigger never overwrites that cache, promotes a REST quote to a market observation or writes to the database.

## Staging schema and approval

The read-only Staging inspection found 15 migration ledger entries through the Binance Demo environments migration (logical identifier `202611100002`). The six exchange-neutral Admin Demo relations and the private public-market stream relation were absent. Existing Binance API and market research credential tables had RLS enabled and no inspected SELECT/INSERT/UPDATE/DELETE grants for browser roles. No credential rows were read.

Review the unapplied chain starting with `202611100003` as a dependency set. The exchange-neutral migration already drafts encrypted credential storage, Admin-bound session and authorization tables, execution and audit records, restricted grants, RLS, and a privileged authorization RPC. Keep the public projection DDL in [its review-only plan](../supabase/plans/public-market-pipeline.sql). Use the [read-only verification SQL](../supabase/plans/verify-admin-demo-staging.sql) and existing versioned verification scripts to review installed privileges and missing prerequisites.

The five-provider review UI accepts no credential input while prerequisites are missing. The common remote service is disabled by default. Existing execution and Staging/Production checks remain required. No provider is REMOTE_READY. Before enabling any capability:

1. Approve the independently verified Staging target, schema and role review, encrypted credential storage, audit path, and provider-specific Demo/Testnet account eligibility. Apply reviewed migrations only under separate approval.
2. Approve credential setup separately for each provider. Use dedicated Demo/Testnet credentials, supported permissions, and account mode. Confirm the encryption key and grants without displaying values.
3. Approve one read-only connection check per provider and inspect redacted evidence. This covers account and instrument validation only.
4. Approve an individual Demo execution only after its provider adapter, lifecycle protections and audit path have been reviewed. Approval must bind the Admin, provider, environment, session, instrument, side and agreed risk limits. Prepared adapter code and mocked evidence grant no execution authority.
