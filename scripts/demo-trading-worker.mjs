#!/usr/bin/env node
/**
 * SmartExit 24x7 Isolated Demo Trading Worker
 *
 * Standalone Node.js daemon designed for unattended 24x7 operation on Linux/Windows.
 * Requires `node --import tsx scripts/demo-trading-worker.mjs`.
 *
 * Safety invariants:
 * - Strictly locked to DEMO / TESTNET environments (LIVE execution is prohibited).
 * - Requires valid Staging database isolation (Production Supabase is rejected fail-closed).
 * - Exclusive local file lock + atomic distributed DB lease prevent duplicate workers.
 * - Renews and verifies DB lease ownership before every business tick; stops on lease loss.
 * - Supports SafeMode (read-only scanning & protection audit, zero order mutations).
 * - Never masks tick failures as healthy status.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

if (process.env.WORKER_SKIP_ENV_FILE !== 'true') {
  for (const envFile of ['.env.local', '.env.staging.local', '.env']) {
    try {
      if (typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(envFile);
      }
    } catch {
      // Optional env file
    }
  }
}

export const WORKER_VERSION = '2.0.0';
export const DEFAULT_TICK_INTERVAL_MS = 30_000;

export function assertDemoSafety(environment) {
  const normalized = (environment ?? '').trim().toUpperCase();
  if (normalized === 'LIVE' || normalized === 'PRODUCTION_REAL_MONEY' || !['DEMO', 'TESTNET'].includes(normalized)) {
    throw new Error('SECURITY VIOLATION: demo-trading-worker is strictly isolated to DEMO / TESTNET environments.');
  }
}

export function isWorkerSafeMode(options = {}, env = process.env) {
  if (typeof options.safeMode === 'boolean') return options.safeMode;
  if (env.WORKER_SAFE_MODE === 'true') return true;
  if (env.WORKER_SAFE_MODE === 'false' && env.DEMO_ORDER_DISPATCH_ENABLED === 'true') return false;
  return env.DEMO_ORDER_DISPATCH_ENABLED !== 'true';
}

function getHttpWorkerSecret(env = process.env) {
  const secret = env.WORKER_SECRET || env.CRON_SECRET || '';
  return secret.length >= 32 ? secret : null;
}

export async function ensureWorkerDirectory(storageDir) {
  await fs.mkdir(storageDir, { recursive: true });
}

export async function acquireWorkerLock(storageDir, pid = process.pid) {
  const lockPath = path.join(storageDir, 'worker.lock');
  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify({ pid, acquiredAt: new Date().toISOString() }));
    await handle.close();
    return {
      release: async () => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // Best effort cleanup
        }
      },
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`Another demo trading worker instance is already running (lock: ${lockPath}).`);
    }
    throw error;
  }
}

export async function writeWorkerHeartbeat(storageDir, data) {
  const heartbeatPath = path.join(storageDir, 'worker-heartbeat.json');
  const tempPath = path.join(storageDir, `worker-heartbeat.${process.pid}.tmp`);
  const payload = {
    version: WORKER_VERSION,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    timestamp: Date.now(),
    ...data,
  };
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tempPath, heartbeatPath);
}

export async function saveCheckpoint(storageDir, checkpoint) {
  const checkpointPath = path.join(storageDir, 'checkpoint.json');
  const tempPath = path.join(storageDir, `checkpoint.${process.pid}.tmp`);
  const payload = {
    version: WORKER_VERSION,
    ...checkpoint,
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tempPath, checkpointPath);
}

export async function loadCheckpoint(storageDir) {
  const checkpointPath = path.join(storageDir, 'checkpoint.json');
  try {
    const raw = await fs.readFile(checkpointPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function checkKillSwitch(storageDir) {
  if (process.env.SMARTEXIT_EMERGENCY_STOP === 'true') {
    return { triggered: true, reason: 'Environment variable SMARTEXIT_EMERGENCY_STOP=true' };
  }
  const killSwitchFile = path.join(storageDir, 'kill-switch');
  try {
    await fs.access(killSwitchFile);
    return { triggered: true, reason: `Emergency kill switch file present: ${killSwitchFile}` };
  } catch {
    return { triggered: false };
  }
}

async function resolveLeaseTransport() {
  const [{ isDatabaseConfigured, assertDatabaseTargetIsolation }, leaseMod] = await Promise.all([
    import('../lib/db.ts'),
    import('../lib/worker-lease.ts'),
  ]);
  if (isDatabaseConfigured()) {
    assertDatabaseTargetIsolation(process.env);
    return { mode: 'DB', leaseMod };
  }
  const workerSecret = getHttpWorkerSecret(process.env);
  const appUrl = process.env.APP_URL?.trim();
  if (workerSecret && appUrl) {
    return { mode: 'HTTP', appUrl, workerSecret };
  }
  return { mode: 'NONE' };
}

export async function acquireDbLease(info, deps = {}) {
  const transport = deps.leaseTransport ?? (await resolveLeaseTransport());
  const ttl = info.ttlSeconds || 90;
  if (transport.mode === 'DB') {
    return transport.leaseMod.acquireWorkerLease({
      workerId: info.workerId,
      hostname: info.hostname,
      pid: info.pid,
      version: info.version,
      environment: info.environment || 'DEMO',
      safeMode: info.safeMode,
      ttlSeconds: ttl,
    });
  }
  if (transport.mode === 'HTTP') {
    try {
      const res = await fetch(`${transport.appUrl}/api/admin/worker-health`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-worker-secret': transport.workerSecret,
        },
        body: JSON.stringify({
          action: 'acquire',
          workerId: info.workerId,
          hostname: info.hostname,
          pid: info.pid,
          version: info.version,
          environment: info.environment || 'DEMO',
          safeMode: info.safeMode,
          ttlSeconds: ttl,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: Boolean(res.ok && data.ok), lease: data.lease, error: data.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'HTTP lease acquisition failed.' };
    }
  }
  return { ok: false, error: 'Database credentials or authenticated APP_URL + WORKER_SECRET (>=32 chars) are required to acquire a worker lease.' };
}

export async function renewDbLease(info, deps = {}) {
  const transport = deps.leaseTransport ?? (await resolveLeaseTransport());
  const ttl = info.ttlSeconds || 90;
  if (transport.mode === 'DB') {
    return transport.leaseMod.renewWorkerLease({ ...info, ttlSeconds: ttl });
  }
  if (transport.mode === 'HTTP') {
    try {
      const res = await fetch(`${transport.appUrl}/api/admin/worker-health`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-worker-secret': transport.workerSecret,
        },
        body: JSON.stringify({
          action: 'renew',
          ...info,
          ttlSeconds: ttl,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => ({}));
      return Boolean(data.ok);
    } catch {
      return false;
    }
  }
  return false;
}

export async function releaseDbLease(workerId, deps = {}) {
  const transport = deps.leaseTransport ?? (await resolveLeaseTransport());
  if (transport.mode === 'DB') {
    await transport.leaseMod.releaseWorkerLease(workerId);
    return;
  }
  if (transport.mode === 'HTTP') {
    try {
      await fetch(`${transport.appUrl}/api/admin/worker-health`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-worker-secret': transport.workerSecret,
        },
        body: JSON.stringify({ action: 'release', workerId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Non-blocking cleanup
    }
  }
}

export async function executeBusinessTick(environment, options = {}) {
  assertDemoSafety(environment);
  const safeMode = isWorkerSafeMode(options);
  const startedMs = Date.now();

  try {
    const scanRunner =
      options.dependencies?.runSignalScan ??
      (await import('../lib/signal-scan.ts')).runSignalScan;

    const executionMod =
      options.dependencies?.tradingExecution ??
      (await import('../lib/trading-execution.ts'));

    const scanResult = await scanRunner(undefined, {
      executeAutomaticTrades: !safeMode,
      deliverNotifications: !safeMode,
    });

    let protectionSummary = { openCount: 0, protectionFailures: 0, executedTotal: 0 };
    if (safeMode) {
      if (typeof executionMod.inspectDemoProtectionStatus === 'function') {
        protectionSummary = await executionMod.inspectDemoProtectionStatus();
      }
    } else {
      if (typeof executionMod.reconcileBinanceDemoProtection === 'function') {
        const reconciled = await executionMod.reconcileBinanceDemoProtection(10);
        const failedCount = Array.isArray(reconciled?.results)
          ? reconciled.results.filter((r) => r.status === 'FAILED' || r.status === 'PROTECTION_FAILED').length
          : 0;
        if (typeof executionMod.inspectDemoProtectionStatus === 'function') {
          protectionSummary = await executionMod.inspectDemoProtectionStatus();
        }
        protectionSummary.protectionFailures = Math.max(protectionSummary.protectionFailures, failedCount);
      }
    }

    const durationMs = typeof scanResult.durationMs === 'number' ? scanResult.durationMs : Date.now() - startedMs;
    return {
      pipelineStatus: safeMode ? 'SAFE_MODE_EXECUTED' : 'EXECUTED_DEMO',
      safeMode,
      scannedAt: scanResult.scannedAt ?? new Date().toISOString(),
      completedAt: scanResult.completedAt ?? new Date().toISOString(),
      batchSize: scanResult.batchSize ?? 35,
      cursor: typeof scanResult.cursor === 'number' ? scanResult.cursor : null,
      batchIndex: scanResult.batchIndex ?? 1,
      totalBatches: scanResult.totalBatches ?? 1,
      cycleId: scanResult.cycleId ?? 'CYCLE-1-FULL-RUN',
      candidates: scanResult.candidates ?? 0,
      newSignals: scanResult.newSignals ?? 0,
      qualifiedCount: scanResult.qualifiedCount ?? 0,
      durationMs,
      timeframe: scanResult.timeframe ?? '15m',
      exchange: scanResult.exchange ?? 'BINANCE',
      totalTradesExecuted: protectionSummary.executedTotal ?? 0,
      protectionFailures: protectionSummary.protectionFailures ?? 0,
      openProtectedCount: protectionSummary.openCount ?? 0,
      status: 'OK',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      pipelineStatus: 'ERROR',
      safeMode,
      error: message,
      durationMs: Date.now() - startedMs,
      timestamp: new Date().toISOString(),
      status: 'ERROR',
    };
  }
}

export async function runWorkerLoop(options = {}) {
  const storageDir = path.resolve(options.storageDir ?? 'storage/demo-worker');
  const environment = options.environment ?? process.env.SMARTEXIT_TRADING_ENVIRONMENT ?? process.env.TRADING_ENVIRONMENT ?? 'DEMO';
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const once = options.once === true;
  const safeMode = isWorkerSafeMode(options);
  const requireDbLease = options.requireDbLease !== false;
  const leaseTtlSeconds = Math.max(90, Math.ceil(tickIntervalMs / 1000) * 3);

  assertDemoSafety(environment);
  const { assertDatabaseTargetIsolation } = await import('../lib/db.ts');
  assertDatabaseTargetIsolation(process.env);
  await ensureWorkerDirectory(storageDir);

  const lock = await acquireWorkerLock(storageDir);
  let isRunning = true;
  let loopCount = 0;
  let consecutiveFailures = 0;
  let dbLeaseAcquired = false;
  const sleepAbort = new AbortController();
  const workerId = options.workerId ?? `worker-${os.hostname()}-${process.pid}`;
  const leaseDeps = options.leaseTransport ? { leaseTransport: options.leaseTransport } : {};

  try {
    const leaseRes = await acquireDbLease(
      {
        workerId,
        hostname: os.hostname(),
        pid: process.pid,
        version: WORKER_VERSION,
        environment: environment === 'TESTNET' ? 'TESTNET' : 'DEMO',
        safeMode,
        ttlSeconds: leaseTtlSeconds,
      },
      leaseDeps,
    );

    if (leaseRes && leaseRes.ok) {
      dbLeaseAcquired = true;
      console.info(`[Worker] Acquired distributed DB worker lease: ${workerId}`);
    } else if (requireDbLease) {
      throw new Error(leaseRes?.error || 'Failed to acquire distributed DB worker lease.');
    }
  } catch (leaseError) {
    await lock.release();
    throw leaseError;
  }

  const checkpoint = (await loadCheckpoint(storageDir)) ?? {
    cycleCount: 0,
    cursor: 0,
    totalTradesExecuted: 0,
    scannedPairsCount: 0,
    lastSuccessfulScanAt: null,
  };

  let shutdownPromise = null;
  const shutdown = (reason) => {
    if (shutdownPromise) return shutdownPromise;
    isRunning = false;
    sleepAbort.abort();
    shutdownPromise = (async () => {
      if (dbLeaseAcquired) {
        try {
          await releaseDbLease(workerId, leaseDeps);
        } catch {
          // Best effort
        }
      }
      await writeWorkerHeartbeat(storageDir, {
        status: 'STOPPED',
        reason: reason ?? 'Graceful shutdown',
        loopCount,
        consecutiveFailures,
        safeMode,
        checkpoint,
      });
      await lock.release();
    })();
    return shutdownPromise;
  };

  const handleSignal = (sig) => {
    console.info(`\n[Worker] Received ${sig}, initiating graceful shutdown...`);
    void shutdown(`Signal ${sig}`);
  };

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  console.info(`[Worker] SmartExit 24x7 Demo Trading Worker v${WORKER_VERSION} started.`);
  console.info(`[Worker] Environment: ${environment} | SafeMode: ${safeMode} | PID: ${process.pid} | Directory: ${storageDir}`);

  try {
    while (isRunning) {
      loopCount += 1;

      const kill = await checkKillSwitch(storageDir);
      if (kill.triggered) {
        console.warn(`[Worker] EMERGENCY SHUTDOWN TRIGGERED: ${kill.reason} (Existing exchange protection is preserved.)`);
        if (dbLeaseAcquired) {
          await renewDbLease(
            {
              workerId,
              tickCount: loopCount,
              emergencyStopStatus: 'ARMED',
              exchangeExecutionStatus: 'EMERGENCY_STOP',
              safeMode,
              ttlSeconds: leaseTtlSeconds,
            },
            leaseDeps,
          ).catch(() => false);
        }
        await shutdown(`Emergency kill switch: ${kill.reason}`);
        break;
      }

      // Enforce distributed lease ownership BEFORE every business tick on tick 2+
      if (requireDbLease && dbLeaseAcquired && loopCount > 1) {
        const stillOwned = await renewDbLease(
          {
            workerId,
            tickCount: loopCount,
            safeMode,
            ttlSeconds: leaseTtlSeconds,
          },
          leaseDeps,
        );
        if (!stillOwned) {
          const lossMsg = 'Distributed DB worker lease was lost or preempted before business tick.';
          console.error(`[Worker] ${lossMsg}`);
          await writeWorkerHeartbeat(storageDir, {
            status: 'ERROR',
            error: lossMsg,
            loopCount,
            consecutiveFailures: consecutiveFailures + 1,
          });
          await shutdown(lossMsg);
          throw new Error(lossMsg);
        }
      }

      const mem = process.memoryUsage();
      const memMb = Math.round((mem.rss / 1024 / 1024) * 100) / 100;
      const heapMb = Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100;

      const businessExecution = await executeBusinessTick(environment, { ...options, safeMode });

      if (businessExecution.status === 'OK') {
        consecutiveFailures = 0;
        checkpoint.cycleCount += 1;
        if (typeof businessExecution.cursor === 'number') {
          checkpoint.cursor = businessExecution.cursor;
        }
        if (typeof businessExecution.totalTradesExecuted === 'number') {
          checkpoint.totalTradesExecuted = businessExecution.totalTradesExecuted;
        }
        checkpoint.scannedPairsCount = (checkpoint.scannedPairsCount || 0) + (businessExecution.batchSize || 0);
        checkpoint.lastSuccessfulScanAt = businessExecution.completedAt ?? new Date().toISOString();
        checkpoint.activeCycle = businessExecution.cycleId;
        checkpoint.batchProgress = `Batch ${businessExecution.batchIndex}/${businessExecution.totalBatches}`;
      } else {
        consecutiveFailures += 1;
        console.error(`[Worker] Tick ${loopCount} failed (${consecutiveFailures} consecutive): ${businessExecution.error}`);
      }

      const lastScanResult = {
        tickAt: new Date().toISOString(),
        cycleCount: checkpoint.cycleCount,
        cursor: checkpoint.cursor,
        batchSize: businessExecution.batchSize || 0,
        ...businessExecution,
      };

      await saveCheckpoint(storageDir, checkpoint);
      await writeWorkerHeartbeat(storageDir, {
        status: businessExecution.status === 'OK' ? 'RUNNING' : 'ERROR',
        environment,
        safeMode,
        loopCount,
        consecutiveFailures,
        error: businessExecution.status === 'ERROR' ? businessExecution.error : null,
        memoryRssMb: memMb,
        memoryUsageMb: heapMb,
        checkpoint,
        lastScanResult,
      });

      if (dbLeaseAcquired) {
        const renewed = await renewDbLease(
          {
            workerId,
            tickCount: loopCount,
            activeCycle: checkpoint.activeCycle,
            batchProgress: checkpoint.batchProgress,
            scannedPairsCount: checkpoint.scannedPairsCount,
            lastSuccessfulScanAt: checkpoint.lastSuccessfulScanAt,
            lastScanDurationMs: businessExecution.durationMs,
            lastCandidateCount: businessExecution.candidates,
            lastQualifiedCount: businessExecution.qualifiedCount,
            totalTradesExecuted: checkpoint.totalTradesExecuted,
            exchangeExecutionStatus: safeMode ? 'SAFE_MODE (READ_ONLY)' : 'DEMO_DISPATCH_ENABLED',
            protectionFailures: businessExecution.protectionFailures ?? 0,
            emergencyStopStatus: 'CLEAR',
            consecutiveFailures,
            lastError: businessExecution.status === 'ERROR' ? businessExecution.error : null,
            safeMode,
            ttlSeconds: leaseTtlSeconds,
          },
          leaseDeps,
        );
        if (!renewed && requireDbLease) {
          const lossMsg = 'Distributed DB worker lease renewal failed; stopping immediately.';
          console.error(`[Worker] ${lossMsg}`);
          await shutdown(lossMsg);
          throw new Error(lossMsg);
        }
      }

      if (once) {
        if (businessExecution.status !== 'OK') {
          await shutdown(`Single cycle failed: ${businessExecution.error}`);
          throw new Error(`Single-cycle worker failed: ${businessExecution.error}`);
        }
        console.info('[Worker] Single-cycle execution finished successfully.');
        await shutdown('Completed single cycle');
        break;
      }

      if (typeof options.maxTicks === 'number' && loopCount >= options.maxTicks) {
        await shutdown('Completed bounded ticks');
        break;
      }

      await new Promise((resolve) => {
        if (sleepAbort.signal.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, tickIntervalMs);
        sleepAbort.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  } catch (error) {
    console.error('[Worker] Fatal error in worker loop:', error);
    await writeWorkerHeartbeat(storageDir, {
      status: 'CRASHED',
      error: error instanceof Error ? error.message : String(error),
      loopCount,
      consecutiveFailures,
    }).catch(() => {});
    await shutdown(`Fatal error: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    throw error;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const once = args.includes('--once') || process.env.WORKER_SINGLE_CYCLE === 'true';
  const safeMode = args.includes('--safe-mode') ? true : undefined;
  runWorkerLoop({ once, safeMode }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
