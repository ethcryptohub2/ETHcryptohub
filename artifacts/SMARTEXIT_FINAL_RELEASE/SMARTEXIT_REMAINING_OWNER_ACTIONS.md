# SMARTEXIT — REMAINING OWNER ACTIONS & ACTIVATION GUIDE

**Release Checkpoint:** v3.1.0-final-release-checkpoint  
**Target Environment:** Staging Deployment Acceptance & Operational Activation  
**Working Branch:** \`functional-staging\`  

---

## 1. Owner Pre-Flight Checklist

To achieve full hands-off automated Demo trading on the deployed Staging environment, the owner should execute the following straightforward steps:

### Step 1: Input Exchange Demo Credentials
1. Navigate to the Staging website:  
   [https://cryptohub-git-functional-staging-eth-cryptohub.vercel.app/binance](https://cryptohub-git-functional-staging-eth-cryptohub.vercel.app/binance)
2. Log in with your authenticated credentials.
3. Select the desired exchange tab (Binance, Bybit, OKX, Bitget, Gate.io).
4. Enter your Demo/Testnet API Key, Secret Key, and Passphrase (for OKX/Bitget).
5. Click **Connect & Verify Credentials**.  
   *(The form is fully unlocked and saves encrypted credentials via AES-256-GCM).*

---

### Step 2: Enable Automated Strategy Execution
1. Navigate to **Settings** or **Strategy Settings** at \`/settings\`.
2. Toggle **Execution Mode** to **AUTOMATIC** (or enable Auto-Trading on the desired strategy profile).
3. Confirm that the individual execution switches for your configured exchanges are toggled **ON**.

---

### Step 3: Launch Background Trading Worker (For Continuous 24/7 Execution)
Because Vercel is a serverless platform (with no long-running background daemon), automated signal polling and remote order placement require an active worker heartbeat.

To run the worker locally on your Windows machine in Demo mode:
```powershell
powershell -ExecutionPolicy RemoteSigned -File scripts/start-local-worker.ps1
```
*(The worker safely polls pending scanner candidates, verifies trailing stop milestones, and manages full order lifecycle in DEMO mode only).*

---

## 2. Production Promotion Prerequisites (Future Release)

When the owner decides to promote the verified Staging implementation into Production, the following strict governance steps must be observed:

1. **Production Database Migration:**
   - Execute a full pg_dump backup of Production database \`kafsdnzzjawikoavkhvm\`.
   - Apply the verified migrations sequentially.
2. **Environment Variable Configuration in Vercel:**
   - Provision a dedicated \`BINANCE_CREDENTIALS_KEY\` (32 random bytes) for Production.
   - Maintain \`BINANCE_FUTURES_LIVE_TRADING_APPROVED="false"\` until operational acceptance is confirmed.
3. **Branch Merging:**
   - Merge \`functional-staging\` into \`main\` via pull request after final owner review.
   - Never merge directly into \`main\` without a clean passing build and test run.

---

## 3. Summary of Safety Guarantees

- **No Real Funds at Risk:** Live trading remains completely locked (HTTP 403 Forbidden).
- **No Internal Paper Simulation:** All execution routes to genuine remote exchange Demo accounts.
- **No Unscheduled Serverless Tasks:** Production CRON remains completely disabled.
- **Isolated Databases:** Production database \`kafsdnzzjawikoavkhvm\` remains 100% untouched.
