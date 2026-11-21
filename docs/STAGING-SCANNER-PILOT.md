# Finite automatic Staging scanner pilot

The pilot is disabled. This runbook and the checked-in Windows caller do not register a task, create a secret, install infrastructure, or authorize any remote operation.

## One finite job

Use one existing Windows operator host with no new paid resources, independently approved for dispatch. A short-lived scheduled task calls the exact immutable Staging Preview. The provider connection runs from the Vercel Function, so Windows provider access cannot establish Preview egress eligibility. The scanner uses HTTPS REST and exits after the batch. It requires no persistent WebSocket, Vercel worker or cron.

The pilot targets three operator-approved eligible symbols and both existing strategies on closed five-minute candles. Put at most four invocations into one approved UTC hour, at minute 02, 17, 32 and 47. Use one trigger with a 15-minute repeat and a one-hour end boundary. Configure the task to skip overlapping runs, skip missed runs, and perform zero retries. The caller independently checks its UTC window and admission slot and rejects redirects. Its only credential is the dedicated scanner pilot token, injected into the process by the approved scheduler account. Keep tokens out of task arguments and logs. The protected Preview must also have an independently approved unattended request path. A Vercel access redirect means the request must stop. Keep global Deployment Protection in place.

To verify the caller configuration without contacting a server or reading the token:

```powershell
& .\deploy\scanner-pilot\invoke-staging-scanner.ps1 -PreviewHost '<exact hostname>' `
  -ExpectedCommit '<40-character SHA>' -StartUtc '<YYYY-MM-DDTHH:mm:ssZ>' `
  -StopUtc '<YYYY-MM-DDTHH:mm:ssZ>' -VerifyOnly
```

An approved run uses the same command with `-ExecuteApproved`. This makes one empty authenticated POST to the fixed scanner-job path and sends the expected Git commit header. It has a 40-second caller deadline and logs only the HTTP result, timestamp and reviewed deployment identity.

Set the Preview-only `SMARTEXIT_SCANNER_PILOT_*` values only after approval: `ENABLED`, `APPROVED_SHA`, `START_UTC`, `STOP_UTC`, `SYMBOLS`, `TOKEN` and `DB_URL`. The window starts and ends on UTC quarter-hour boundaries. The runner requires the dedicated `smartexit_scanner_pilot` database login and a direct, certificate-verified connection to the named Staging project. Verify direct IPv6/TLS connectivity and review exact table privileges and policies before activation. The SQL draft in `supabase/review/staging-scanner-pilot.sql` is outside the migration chain and grants no writer access.

The review-only grants are in `supabase/review/staging-scanner-pilot-role.sql`. The draft role cannot log in, bypass RLS, access customers or credentials, write trades, or change stop state. Apply and verify grants before creating the approved login. Both files stay outside the normal migration chain. The stop row starts as stopped. Arming requires a distinct operator action in the approved window. Admin has a CSRF-protected Stop control with no web resume path. The runner rechecks the stop row before acquisition and before publishing; a transaction already committed requires normal recovery review.

The job admits one run per UTC slot under the same PostgreSQL advisory-lock namespace as manual evaluation. Each run uses at most four unsigned calls and 46 IP request weight, with a 15-second provider deadline and no retries. Provider denial, regional restriction, rate limits or the used-weight guard latch the remaining pilot slots off. Futures snapshots, qualified signals, lifecycle-opening events and the completed run report commit together. A caught error rolls back the batch and saves a bounded failure code. An interrupted database transaction leaves no partial signal commits. A missing run row after an interruption requires operator review. The Admin history view reports recorded readiness and outcomes.

## Required approvals

1. Confirm the exact protected Preview's Binance-facing egress and data-use eligibility. Then approve one unsigned ticker GET for 40 IP weight and up to five seconds, followed only on success by separate approval for one two-request, 42-weight BTCUSDT evaluation.
2. Approve the exact Staging migration and restricted writer role separately, after backup and rehearsal. The role is for Staging project `ghecpkpaxbrvehquhzkr`. Approve one genuine write rehearsal with a named batch, closed candle, audited outcome and rollback path before enabling the pilot. Keep synthetic observations in the disposable rehearsal.
3. Separately approve the immutable deployment, unattended Preview access method, existing scheduler host, dedicated token, three symbols, four UTC slots and stop time. Set the approved runtime gate and expiry only for that committed Preview. Runtime budgets apply to the Preview's provider egress. The Windows caller cannot change them.

Disable the scheduled task after the last slot, on unexpected reruns, or after provider denial. The server gate must expire independently. Remove the runtime approval from subsequent deploys, revoke the dedicated scheduler token using the approved operations path, and preserve the Staging run and signal-event evidence. Keep Production, notification dispatch and trade execution outside the pilot.
