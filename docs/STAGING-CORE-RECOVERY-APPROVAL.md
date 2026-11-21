# SmartExit Staging core recovery approval

Release `5e444cdb3d514d8c812244423bf240f72ff84c5d` on [cryptohub Preview](https://cryptohub-f0p0qtss2-eth-cryptohub.vercel.app). Database target `ghecpkpaxbrvehquhzkr` only.

## 1. Backup and recovery

Backup destination is `C:\SmartExit-Staging-Backups\`, with seven-day retention and the Staging project owner as custodian. The elevated check confirmed that C: is fully decrypted. A Windows EFS destination was prepared instead. The directory and a non-sensitive inherited test file were verified encrypted, the directory has no reparse point, and the ACL is owner and SYSTEM only with inheritance blocked. Confirm the Windows owner's EFS key recovery custody before storing real data. These commands verify the destination without opening any archive:

```powershell
$BackupRoot = 'C:\SmartExit-Staging-Backups'
Get-BitLockerVolume -MountPoint 'C:' | Select-Object MountPoint, VolumeStatus, ProtectionStatus, EncryptionPercentage
Get-Item -LiteralPath $BackupRoot -Force | Select-Object FullName, Attributes, LinkType
Get-Acl -LiteralPath $BackupRoot | Format-List Owner, AreAccessRulesProtected, AccessToString
Get-Item -LiteralPath (Join-Path $BackupRoot 'non-sensitive-efs-probe.txt') | Select-Object Attributes
```

Require protected, fully encrypted storage, verify the folder resolves locally without reparse points, and confirm the ACL grants only the named custodian and necessary system identities. The restore data directory, archive manifest and logs require the same protection. Do not export if any evidence is missing.

The encrypted service file is at `C:\SmartExit-Staging-Backups\libpq\pg_service.conf`. It uses the connector-confirmed direct hostname and `sslmode=verify-full`. Local DNS did not resolve that endpoint for the test connection. If the direct endpoint remains unreachable, use the session-mode host and project-qualified username shown in the exact Staging project's Connect panel. The owner must supply the official Staging CA at `libpq\staging-ca.crt` and provision the existing password through the encrypted `libpq\pgpass.conf`, or configure another approved authentication method in the service. Do not paste credentials into chat or put them in the archive. Before exporting, set `$env:PGSERVICEFILE = 'C:\SmartExit-Staging-Backups\libpq\pg_service.conf'` in the operator process and verify the hostname, TLS connection and exact migration ledger via read-only psql.

Approve one certificate-verified PostgreSQL 17 logical export using local service `smartexit-staging-reviewed`, database `postgres`. Name a new encrypted, access-restricted directory outside Git, the retention period, and the custodian. Capture `public`, `supabase_migrations`, and the catalog metadata in the [migration and recovery runbook](STAGING-MIGRATION-REVIEW-PACKET.md). Recheck managed Auth, Storage and extension dependencies before export. Keep key custody separate from the archive. Verify the archive SHA-256 and restore it to a fresh loopback-only PostgreSQL 17 database. Check ledger, row and sequence parity, role mappings, RLS and managed helper dependencies. Shut down the disposable instance and retain the encrypted archive under the approved controls. Stop on target, coverage, extension or restore mismatch.

After that evidence and explicit approval, create one new restricted UTC-stamped subdirectory `$BackupDirectory` below the reviewed root and verify its effective ACL. Confirm the exact PostgreSQL service target and role through the operator's secure connection workflow. Use these commands, with the reviewed restore port, role and TOC values:

```powershell
pg_dump --dbname='service=smartexit-staging-reviewed dbname=postgres sslmode=verify-full options=-cdefault_transaction_read_only=on' --no-password --format=custom --schema=public --schema=supabase_migrations --lock-wait-timeout=5s --file="$BackupDirectory\smartexit-staging.dump"
if ($LASTEXITCODE -ne 0) { throw 'Staging export failed' }
Get-FileHash -Algorithm SHA256 -LiteralPath "$BackupDirectory\smartexit-staging.dump"
pg_restore --list "$BackupDirectory\smartexit-staging.dump"
if ($LASTEXITCODE -ne 0) { throw 'Archive manifest failed' }
pg_restore --dbname="host=127.0.0.1 port=$RestorePort dbname=smartexit_restore user=$RestoreRole" --no-password --single-transaction --exit-on-error --no-owner --use-list="$ReviewedToc" "$BackupDirectory\smartexit-staging.dump"
if ($LASTEXITCODE -ne 0) { throw 'Disposable restore failed' }
```

All ten canonical checkout hashes matched the pinned runbook at the release baseline. Request a separate approval after the actual restore and recheck the logical migration ledger and reviewed bytes before execution. Keep the scanner pilot, scanner role and Demo drafts outside the canonical chain. Draft SHA-256 values for the Windows checkout:

```text
103c85dd7ea3776c828dfbda3591591be06e6244ce10d1526a67ee10b8f49fcc staging-scanner-pilot.sql
e3141acd2c1d729fe5ba41524f3fd40a1c3ddd9431eb8f66bad10993136e8712 staging-scanner-pilot-role.sql
fb45ed6d759c2cbe81b0de0397d554cdda35e7e2d9578e4fd387561cd9c0d294 staging-demo-signed-read-claim.sql
80f94feffbc1383d3eee57c1f8ec15d201e00511959aca7a1de7a3a4e3cde47e staging-demo-auto-risk.sql
```

An approved scanner install starts stopped. Writer login creation and arming are separate operations. Demo drafts grant no runtime access by default.

## 2. First real provider observation

Confirm actual Preview egress and Binance USD-M data-use eligibility independently. Region `bom1` describes compute placement. Approve one invocation of the existing Admin diagnostic on the immutable Preview and one unsigned `GET https://fapi.binance.com/fapi/v1/ticker/24hr`. One request, 40 IP weight, five seconds, 1 MiB, fixed 20-symbol evidence view. Zero redirects, retries, provider credentials, database writes, notifications or orders. Capture HTTP status, provider code, provider latency, quote count, latest quote time and weight if supplied. Stop on denial, rate limit, unsafe weight or invalid TLS. Withdraw the temporary approval after the attempt. A successful ticker probe is followed by a separate BTCUSDT closed-candle evaluation, then separately approved persistence and pilot stages. [Recovery and diagnostic details](STAGING-SCANNER-RECOVERY.md).

Invoke `POST /api/admin/public-market-snapshot` once, with an authenticated Admin session, the normal CSRF header, and an empty body and query. The gate uses `SMARTEXIT_PUBLIC_REST_SNAPSHOT_APPROVED_SHA` and `SMARTEXIT_PUBLIC_REST_SNAPSHOT_APPROVED_UNTIL` scoped to the exact Preview for at most 15 minutes. The existing cooldown and denial latch are process-local. Keep one operator and one invocation, then close the gate. If the immutable deployment cannot accept a scoped configuration update, approve a replacement Preview of this same commit and pin its exact hostname before calling.

## 3. Historical research

Use operator-supplied checksummed archives or approve a single bounded Windows download from Binance's documented public archive following independent eligibility confirmation. Proposed fixed scope: BTCUSDT and ETHUSDT, USD-M monthly trade-price klines, 5m and 15m, July through September 2026 UTC. The 12 ZIP files and their 12 checksum files imply a ceiling of 24 sequential HTTPS GETs, a 30-second timeout per request, ten minutes overall, and 64 MiB total compressed download. Use exact archive paths, zero redirects or retries, and stop on denial or checksum mismatch. Keep files local, outside version control. Review each file for schema, candle boundaries, duplicates, gaps and known contract eligibility. [Official Binance archive format](https://github.com/binance/binance-public-data).

The fixed input URLs are generated from `https://data.binance.vision/data/futures/um/monthly/klines/{symbol}/{interval}/{symbol}-{interval}-{month}.zip` and the same paths with `.CHECKSUM` appended. The allowlists are `BTCUSDT, ETHUSDT`, `5m, 15m`, and `2026-07, 2026-08, 2026-09`. The archive scope covers klines only. Funding evidence and dated instrument eligibility must be supplied separately; unknown funding leaves all-in net portfolio metrics incomplete.

Use July as the training and warm-up period, August for validation and September as the untouched test period. Fix the symbol cohort and assumptions before test evaluation. Feed only then-known inputs to the existing strategy engines, build any rolling volume from prior closed bars, and record availability for other required context. Begin with Standard 15m and independent High-Risk 5m. Evaluate entries only after qualification is observable, model one open position per symbol per strategy, and report ambiguous bars separately. Where High-Risk emits two targets, preserve that runtime exit rule for strategy-parity results and report any explicitly specified TP3 research variant separately.

Use 5 basis points per fill in fees and 2 basis points adverse slippage per fill as explicit research assumptions, with a 5-basis-point slippage sensitivity case. Model adverse stop gaps and funding only when timestamped funding and applicable position data are available. Compute maximum drawdown from the chronological equity series and profit factor from positive versus absolute negative net trade P&L. Report period, coverage, fees, slippage, ambiguous trades and missing funding. The deployed browser replay accepts supplied levels and reports gross returns. End-to-end historical qualification, costs and portfolio accounting require additional implementation and verification before a genuine result can be claimed.

The local archive replay accepts a manifest and checksummed extracted CSVs. It has no provider or database connection. Record the approved ZIP checksums and the derived CSV hashes after verified extraction, and retain dated contract eligibility evidence. Supply training, validation and test boundaries, starting equity and per-trade notional in the manifest. Run locally after data approval:

```powershell
node scripts/replay-scanner-archive.mjs $ReviewedLocalManifest > $LocalResearchReport
```

The runner uses prior closed bars for price, 24-hour context, and BTC direction. Label this as a candle-derived proxy. An optional instrument funding entry names a checksummed JSON file, UTC coverage start and end, and evidence provenance. The file contains timestamp, mark price and rate. Missing coverage and settlements with ambiguous position timing leave all-in metrics incomplete. Preserve unresolved outcomes and open exposure at the test boundary. No archive-backed result exists until the reviewed inputs are available and the run completes.

## 4. Demo and notification operations

After recovery and schema installation, name one provider, dedicated Demo account and Admin actor at a time. Approve the encrypted credential save and its exact Preview window, then separately approve the atomic signed-read claim and bounded provider GETs. Verify account mode, balance, instrument permissions and rules before proposing an order. Require a finite order approval naming symbol, side, size, limit, TP/SL, expiry and reconciliation owner. Keep all dispatch off until protection and reconciliation acceptance. Signed-read runtime wiring and provider-specific protection gaps must close before those approvals can be exercised.

Require committed event IDs and bounded deduplication for popup delivery. For Demo success, TP and close events, only project authoritative reconciled execution states. Activation of transport, provider event ingestion or notification dispatch is outside this recovery packet.

## Operator authorization

The Staging owner has already authorized scope 1 subject to the storage and connection checks. Supply the missing evidence without repeating scope 1. Scopes 2–5 require their own applicable evidence and authorization.

1. **Backup and restore, conditionally approved.** One read-only export of `ghecpkpaxbrvehquhzkr/postgres` using verified service `smartexit-staging-reviewed`, one restricted local archive at the proposed root and one loopback restore, seven-day retention, Staging project owner as custodian. Required evidence is the verified encrypted destination, ACL and local certificate-verified service connection.
2. **Canonical migrations.** Explicit approval for the ten pinned files in the [manifest](STAGING-MIGRATION-REVIEW-PACKET.md), after the actual restored archive, target ledger, SQL bytes and reviewed execution mechanism are verified. Keep managed Auth/Storage and Production outside the change. If recovery or ledger reconciliation fails, stop.
3. **Pilot schema and role.** Explicit approval for the two pinned scanner drafts only, after the canonical chain. Leave the stop row stopped and the restricted role non-login. Verify exact grants and RLS. Login provisioning, a real persisted evaluation, arming and scheduling require their own finite scopes.
4. **Public Binance probe.** Confirm the actual eligible egress and approval for the exact Preview-only gate and one five-second, 40-weight invocation. If a same-commit Preview must be created to scope the gate, pin its hostname before the call. No secret values in this reply.
5. **Historical archives.** Confirm the Windows access and data-use eligibility and approve the fixed 24-GET maximum for the two symbols, two intervals and three months above, or supply eligible checksummed local files. Permit local research and report generation only.

After the ticker and separate candle diagnostic succeed and recovery and writer privileges are verified, dry-check the finite pilot caller without sending traffic:

```powershell
& .\deploy\scanner-pilot\invoke-staging-scanner.ps1 -PreviewHost $ApprovedPreviewHost -ExpectedCommit '5e444cdb3d514d8c812244423bf240f72ff84c5d' -StartUtc $ApprovedStartUtc -StopUtc $ApprovedStopUtc -VerifyOnly
```

Separate activation names the three symbols, exact existing scheduler host, approved access method, token custody, one UTC hour and its four permitted slots. Require a successful genuine one-batch write rehearsal first. [Pilot activation and rollback](STAGING-SCANNER-PILOT.md).
