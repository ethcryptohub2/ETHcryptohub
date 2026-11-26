# SmartExit / ETHcryptohub — Render Deployment Runbook

Complete guide to deploying SmartExit Next.js Web Service and 24/7 Demo Trading Worker on [Render](https://render.com).

---

## Architecture Overview

SmartExit on Render can be deployed in two supported ways:

### Architecture A: Render Blueprint (Recommended)
Defined in repository root `render.yaml`:
1. **`smartexit-web`**: Next.js 16 Web Application (Type: `web`, Runtime: `node`).
2. **`smartexit-demo-worker`**: 24/7 Background Worker (Type: `worker`, Runtime: `node`, Plan: `starter` @ $7/mo). Runs continuously with zero sleep, executing market scans every 60s, acquiring distributed leases, and reconciling demo positions.

### Architecture B: Single Unified Web Service (Cost-Optimized)
Runs both the Next.js server and the background worker process supervisor in a single instance:
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm run start:render` (runs `scripts/start-render-combined.mjs`)
- Runs both web traffic and background scanner under 1 instance ($7/mo Starter).

---

## Step-by-Step Deployment Instructions

### Method 1: Deploying via Render Blueprint (`render.yaml`)

1. Open your [Render Dashboard](https://dashboard.render.com/).
2. Click **New +** (top right) and select **Blueprint**.
3. Connect your repository: `ethcryptohub2/ETHcryptohub` (or your fork).
4. Select branch: `functional-staging` (or `main`).
5. Render will automatically detect `render.yaml` and configure:
   - Web Service: `smartexit-web`
   - Background Worker: `smartexit-demo-worker`
6. Enter the sensitive environment variables when prompted by Render UI:
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_DB_PASSWORD`
   - `AUTH_SECRET`
   - `BINANCE_CREDENTIALS_KEY`
   - `CRON_SECRET`
   - `WORKER_SECRET`
7. Click **Apply**. Render will build and deploy both services!

---

### Method 2: Manual Web Service & Worker Setup

If creating services individually in Render:

#### 1. Next.js Web Service
- **Name:** `smartexit-web`
- **Runtime:** `Node`
- **Region:** `Singapore` (closest to Supabase `ap-southeast-2`)
- **Branch:** `functional-staging`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npx next start -H 0.0.0.0 -p $PORT`
- **Health Check Path:** `/`
- Add environment variables from `deploy/render/render-env.example`.

#### 2. Background Demo Trading Worker
- **Name:** `smartexit-demo-worker`
- **Type:** Background Worker
- **Runtime:** `Node`
- **Plan:** `Starter` ($7/month, 0.5 CPU / 512 MB RAM)
- **Region:** `Singapore`
- **Branch:** `functional-staging`
- **Build Command:** `npm install`
- **Start Command:** `node --import tsx scripts/demo-trading-worker.mjs`
- Add environment variables from `deploy/render/render-env.example`.

---

## SafeMode Soak Verification (First 24 Hours)

Both services launch with hardened safety locks:
```env
WORKER_SAFE_MODE=true
DEMO_ORDER_DISPATCH_ENABLED=false
BINANCE_FUTURES_LIVE_TRADING_APPROVED=false
BINANCE_FUTURES_LIVE_TRADING_ENABLED=false
```

During this period:
- Real market data is dynamically scanned across all 522+ USDT perpetual pairs.
- Multi-timeframe indicators (EMA, SuperTrend, RSI, MACD, ATR) are evaluated.
- Qualified setups are saved to `public.scanner_candidate_snapshots`.
- Worker heartbeats are recorded every 60s to `public.app_settings` (distributed lease).
- **Zero real or demo orders are dispatched.**

### Live Log Monitoring on Render
In the Render Dashboard:
- Click `smartexit-demo-worker` -> **Logs** tab.
- Look for:
  ```
  [Worker] Acquired distributed DB worker lease: worker-...
  [Worker] SmartExit 24x7 Demo Trading Worker v2.0.0 started.
  [Worker] Tick 1 completed: Scanned 35 pairs in 540ms | Candidates: 3 | Executed: 0
  ```
