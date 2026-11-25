# SmartExit Demo Worker — AWS Lightsail (`ap-southeast-2`) Deployment Runbook

## 1. Host & Cost Specification
- **Region:** `ap-southeast-2` (Asia Pacific — Sydney, co-located with Staging Supabase `ghecpkpaxbrvehquhzkr`)
- **Instance:** Amazon Lightsail Linux/Ubuntu 24.04 LTS, `1 GB` RAM, `2 vCPU`, `40 GB` SSD, `2 TB` transfer, Public IPv4 included (`bundleId`: `micro_3_0` / `1GB`)
- **Verified Cost:** `$0.00940/hr` (`$6.86/mo` per 730h; AWS flat tier `$7.00/mo`), covered by AWS Free Plan credits up to Free Plan expiration (6 months from activation).
- **AWS Free Plan Guardrail:** Stay on **FREE** plan (`accountPlanType: FREE`). Do not upgrade to Paid unless explicitly required after 6 months.

## 2. Pre-Deployment Verification & 24-Hour SafeMode Soak
1. Complete AWS console Free Plan activation (`NOT_STARTED` -> `ACTIVE`).
2. Create an AWS Budgets monthly cost alert (`$15.00/mo`) — also earns `$20` Free Tier activity credit (`$0` cost).
3. Populate `/etc/smartexit/demo-worker.env` from `demo-worker.env.example` with Staging-only credentials and `WORKER_SAFE_MODE=true`.
4. Run a single-cycle smoke check as `smartexit`:
   ```bash
   set -a && source /etc/smartexit/demo-worker.env && set +a
   node --import tsx /opt/smartexit/scripts/demo-trading-worker.mjs --safe-mode --once
   ```
5. Enable the 24-hour SafeMode soak:
   ```bash
   sudo touch /etc/smartexit/worker-activation-approved
   sudo systemctl start smartexit-demo-worker
   sudo journalctl -u smartexit-demo-worker -f
   ```
6. Confirm health in `/admin` (`ACTIVE DAEMON ONLINE`, `SafeMode`, `0 tick errors`, incrementing `tickCount` and `scannedPairsCount`).

## 3. Health Monitoring
- Local heartbeat JSON: `/opt/smartexit/storage/demo-worker/worker-heartbeat.json`
- Systemd status: `sudo systemctl status smartexit-demo-worker`
- Memory usage check: `systemctl show smartexit-demo-worker -p MemoryCurrent`

## 4. Emergency Shutdown & Rollback
- **Immediate Emergency Stop (Preserves Existing Exchange Protection):**
  ```bash
  sudo -u smartexit touch /opt/smartexit/storage/demo-worker/kill-switch
  ```
  The worker halts new entries on the next loop check, releases its DB lease cleanly, and leaves existing exchange SL/TP/trailing orders intact.
- **Stop & Disable Service:**
  ```bash
  sudo rm -f /etc/smartexit/worker-activation-approved
  sudo systemctl stop smartexit-demo-worker
  ```
- **Rollback Code:**
  ```bash
  cd /opt/smartexit && sudo -u smartexit git checkout <previous-commit-sha> && sudo -u smartexit npm ci --omit=dev
  sudo systemctl restart smartexit-demo-worker
  ```
