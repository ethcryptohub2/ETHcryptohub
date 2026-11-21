# SmartExit Staging acceptance audit

Started 20 November 2026 from local `0d455057404a278ddd82e0c26e5217a83f77e95a`. The initial GitHub `functional-staging` and Vercel Preview SHA was `d504a301258692cdc26836310d35228dc2ffc871`. GitHub default branch `main` and the Production deployment both pointed to `37a0a6b2ebec350b0aa6d3d40a1fc94adafe9aa5`.

## Issue inventory

| Severity | Surface and reproduction | Repair or blocker |
| --- | --- | --- |
| High | Open Admin diagnostics or refresh an Admin status list. The old GET handlers could write rate-limit counters, and diagnostics could contact Binance during ordinary navigation. | Use bounded in-process throttling and metadata-only diagnostics. Explicit scanner recovery is gated and disabled in this release. |
| High | Submit a User Management suspend, delete, or manual verification action for an Admin account through the API. The UI excluded actions that the SQL mutation still permitted. | The SQL write atomically excludes Admin targets. Malformed JSON returns 400. |
| High | Read a cached scanner setup after its observation expires. Cached data could retain its original actionable state. | Revalidate expiry at read time and keep stale records out of actionable UI state. |
| Medium | Leave a signal countdown open. It could remain fixed at the server-rendered duration. Background tab throttling could also stretch subscription countdowns. | Advance from elapsed monotonic time and lock expired entitlements. |
| Medium | Switch signal history filters or selected details rapidly. Older responses could replace the current selection. Rapid authentication submits could also overlap. | Cancel or ignore obsolete requests and block concurrent form submission. |
| Medium | Switch Admin subscription filters rapidly, or generate a license with inactive plans present. | Ignore obsolete responses, select active premium plans, and preserve operation success when refresh fails. |
| Medium | Redeem an entitlement using an approved test account while a scanner paywall is rendered. The view could stay locked until reload. | Refresh server-rendered scanner state after successful redemption. This path was reviewed locally without submitting a remote redemption. |
| Medium | Invoke the Windows authenticated test harness in run mode. Node tried to execute a file named `test` instead of starting Playwright. | Invoke the installed Playwright CLI explicitly. The authenticated suite still requires separate access and write approval. |
| Medium | Inject an offline transport into the unified Admin Demo service for OKX or Gate. Its default adapter factories discarded the injected transport. | Propagate the provided transport. Fixture-only order status and client-ID reconciliation reject ambiguous responses without retrying. |
| Release blocker | Open the existing Preview in a fresh Chromium context. Vercel serves its access screen, including on protected SmartExit routes. | Authenticated acceptance requires existing authorized preview access and separate pre-existing Admin and customer application sessions, or approval for the required Staging auth writes. |
| Release blocker | Compare the Staging migration ledger and private schema against the Admin Demo and market projection contracts. | Approve and apply reviewed Staging schema separately. Credential and execution controls remain blocked. |

## Browser acceptance scope

The read-only Playwright smoke uses a fresh context, restricts requests to the chosen exact deployment or loopback origin, and blocks all non-GET requests. It checks login and signup rendering, mobile overflow, uncaught page errors and anonymous access guards. Its screenshots contain public pages only. The authenticated test suite is separate. SmartExit login inserts an auth-session row, and signup, password recovery, logout, and persisted dashboard actions also require effects outside this read-only run.

Authenticated premium navigation has a further constraint. Entitlement reads can update expired status and write an expiry audit event. Before read-only authenticated smoke, verify that the isolated fixture's stored and computed entitlement statuses agree, or obtain separate approval for the expected audit-preserving effects.

| Area | Routes or controls | Required authenticated evidence |
| --- | --- | --- |
| Admin Home | Dashboard, statistics, users and role controls, scanner and strategies, subscriptions, news, notifications and diagnostics | Render, role gates, empty/loading/error state and separate approval for each persistence test |
| Admin Exchange Lab | `/admin/exchanges`, `/admin/exchanges/testing` | Provider switching, Demo/Testnet presentation, disabled credential and execution controls and redacted audit evidence |
| Admin Intelligence and Setup | `/admin/intelligence`, `/admin/setup` | Correct unavailable/disabled status, secure access and responsive layout |
| Customer Auth | Login, signup, resend, verification, password recovery, session and logout | Isolated Staging user, approved session and recovery effects, expired-session behavior |
| Customer Core | Dashboard, scanner, High-Risk tab, history, successful signals, performance, signal details | Freshness, expiry, paywall, real navigation, isolation and API results |
| Customer Account | Exchange connection, positions, news, settings, theme and mobile layout | Existing authorized user session, verified isolation and feature-specific permission before writes |

## Security and database

Supabase identifies `ghecpkpaxbrvehquhzkr` as SmartExit Staging and `kafsdnzzjawikoavkhvm` as Production. Staging's ledger contains 15 entries through logical migration `202611100002`. The reviewed Admin Demo relations and private market projection table are absent. The catalog shows RLS enabled and the inspected browser roles without SELECT, INSERT, UPDATE or DELETE grants for existing users, sessions and credential tables. See the [review-only SQL](../supabase/plans/verify-admin-demo-staging.sql) and [deployment prerequisites](SMARTEXIT-STAGING-READINESS.md).

Approved browser persistence tests, Staging migrations and role verification, approved encrypted Demo credential setup, signed provider reads, individual remote Demo execution and a Windows or hosted live market probe are separate scopes. Standard and High-Risk strategy performance remains an unverified research target.

## Protected browser acceptance plan

The authorized Vercel connector and in-app browser independently reached SmartExit login on the [exact Preview](https://cryptohub-orvc8w0vu-eth-cryptohub.vercel.app) at `8553bc55e62dd7d9ed39de78030b23fbff5d61fa`. Deployment Protection stayed in place. The browser returned an anonymous application session. A fresh browser without the existing Vercel access may still encounter the Vercel gate.

1. Use the existing authorized Vercel browser access. Confirm the exact Preview origin and deployment SHA. Prepare separate browser contexts for the existing isolated Admin and Customer accounts. Use their authorized secure credential workflow. Avoid sharing passwords, bearer headers, cookies, or browser storage snapshots.
2. Check `/api/auth/me` for an existing authorized application session before login. If the exact approved target requires a new session, authorize only one `POST /api/auth/login` for each fixture account. Its normal effects include the rate-limit counter, last-login update and session insert. Allow the prerequisite CSRF GET. Stop on an unexpected role, a failed attempt, a redirect to another host, or a protection challenge.
3. Block automatic dashboard redirects, background API requests outside the reviewed path list, and all other mutation methods in a controlled testing context. Anonymous requests cannot validate privileged behavior. In the authenticated contexts, first verify role separation with `/api/auth/me` and the Admin Demo review page. Add pages to the read-only allowlist only after examining their server-side side effects. Dashboard, subscription and premium scanner navigation can persist expiry and audit data even on GET. Compare stored and derived entitlements for the two fixtures before allowing these pages.
4. Use only sanitized screenshots and status codes at desktop and mobile widths. Record blocked controls and schema failures without saving page traces, response headers, credentials, cookies, or account data. Close the contexts without calling logout unless session revocation was also approved.

The existing full `e2e/auth.spec.ts` exercises additional authentication mutations. Its full remote run falls outside the limited acceptance plan.

### Scanner evidence for the follow-up audit

On 21 November 2026 at 04:38–04:40 IST, read-only Staging aggregates returned zero Standard and High-Risk signals, zero expired and target-achieving signals, and no last-generated timestamp. The stored Binance USDT perpetual instrument catalog contained 522 enabled and eligible rows under the application's filters. The cache contained 20 saved 15-minute `WAIT` candidates. The latest saved scan was 15 November at 18:48:26 IST and the latest recorded candle close was 18:44:59 IST that day. The fixture watchlist contains 20 configured symbols. These are separate measures of catalog size, saved observations and historical signals. Current venue membership, market freshness and generation from the Preview egress were not measured.

The operator signed in to the prior exact Preview. Read-only browser checks reached the Admin dashboard, Exchange Control, Demo Lab, Intelligence Operations, Scanner and Signal History under that Admin session. The Demo Lab switched to Gate and kept Start disabled. On the Binance form the deployed application displayed `column "environment_confirmed" does not exist` with Save enabled. The independently inspected Staging catalog confirmed the missing column. Isolated Customer browser acceptance and remote mutation tests were outside these checks.

## Temporary Vercel project deletion review

The temporary project `prj_gJ4iiqRxmbFdtM0vNKA028C6T4ce` (`smartexit-preview-check-b2235872-6267-4750-ae28-06ba9e0b8eb6`) belongs to team `team_T6PklbE1sH3E3B1cUs8V2q9j`. SmartExit uses a different project, `prj_RMBw9wXVJexXUMBGSMYScXNFkatL` (`cryptohub`). The temporary project has one CLI-origin deployment, `dpl_2Zk9WgPpp64h4BLabVhF9biSdHXC`, with no Git source in the deployment metadata. The manifest contains one script with SHA-1 `287a6e90df4cb1d3aa140b32eb65a12ccfd86a7d`, matching the local temporary script. The environment list reported zero configured variables and zero hidden Production variables. The deployment aliases use Vercel-owned domains. The project dashboard showed no attached database or installed integrations.

After explicit approval, re-read ownership, deployments, aliases, environment counts, and Project Settings integrations and storage attachments. Stop on drift, an unknown attachment, or any identifier mismatch. From the exact temporary project's Settings, open General and verify the project identity and deployment inventory before opening Delete Project. Confirm the exact temporary project name in the deletion dialog and submit once. No domain purchase, team-level integration, or SmartExit project operation is in scope. Verify that the temporary project and deployment no longer resolve using authenticated metadata, and confirm both SmartExit Preview and Production metadata still resolve to their prior deployments. [Vercel project deletion](https://vercel.com/docs/projects/managing-projects#deleting-a-project)
