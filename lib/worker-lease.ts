import fs from 'node:fs/promises';
import path from 'node:path';
import type { QueryResultRow } from 'pg';

export interface WorkerLeaseInfo {
  [key: string]: unknown;
  workerId: string;
  hostname: string;
  pid: number;
  version: string;
  environment: 'DEMO' | 'TESTNET';
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  tickCount: number;
  activeCycle?: string;
  batchProgress?: string;
  scannedPairsCount?: number;
  lastSuccessfulScanAt?: string | null;
  lastScanDurationMs?: number;
  lastCandidateCount?: number;
  lastQualifiedCount?: number;
  totalTradesExecuted?: number;
  exchangeExecutionStatus?: string;
  protectionFailures?: number;
  emergencyStopStatus?: string;
  consecutiveFailures?: number;
  lastError?: string | null;
  safeMode?: boolean;
  status: 'ACTIVE' | 'DEGRADED' | 'DORMANT' | 'STOPPED' | 'ERROR';
}

export interface WorkerHealthResult {
  status: 'ONLINE' | 'DEGRADED' | 'DORMANT' | 'OFFLINE';
  lease: WorkerLeaseInfo | null;
  source: 'DATABASE' | 'LOCAL_STORAGE' | 'NONE';
  checkedAt: string;
  uptimeSeconds?: number;
  message: string;
}

const SETTING_KEY = 'demo_worker_lease';
const DEFAULT_TTL_SECONDS = 90;

async function safeDbQuery<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount?: number | null }> {
  try {
    const { query } = await import('./db');
    return await query<T>(sql, params);
  } catch {
    return { rows: [], rowCount: 0 };
  }
}

export async function getWorkerHealthStatus(): Promise<WorkerHealthResult> {
  const checkedAt = new Date().toISOString();

  // 1. Try reading from database app_settings
  try {
    const res = await safeDbQuery<{ value_json: WorkerLeaseInfo }>(
      `SELECT value_json FROM public.app_settings WHERE key = $1`,
      [SETTING_KEY],
    );

    if (res.rows[0]?.value_json) {
      const lease = res.rows[0].value_json;
      const now = Date.now();
      const expiresAtMs = Date.parse(lease.expiresAt);
      const heartbeatAtMs = Date.parse(lease.heartbeatAt);
      const acquiredAtMs = Date.parse(lease.acquiredAt);
      const uptimeSeconds = Number.isFinite(acquiredAtMs) ? Math.max(0, Math.floor((now - acquiredAtMs) / 1000)) : undefined;

      if (lease.status === 'STOPPED') {
        return {
          status: 'OFFLINE',
          lease,
          source: 'DATABASE',
          checkedAt,
          uptimeSeconds,
          message: `Worker was gracefully stopped at ${lease.heartbeatAt}.`,
        };
      }

      const secondsSinceHeartbeat = Number.isFinite(heartbeatAtMs) ? Math.floor((now - heartbeatAtMs) / 1000) : 999;
      const isLeaseUnexpired = Number.isFinite(expiresAtMs) && now <= expiresAtMs;

      // Never report a failing worker as ONLINE/healthy.
      if (lease.status === 'ERROR' || (typeof lease.consecutiveFailures === 'number' && lease.consecutiveFailures > 0)) {
        return {
          status: isLeaseUnexpired && secondsSinceHeartbeat <= 180 ? 'DEGRADED' : 'DORMANT',
          lease: { ...lease, status: isLeaseUnexpired && secondsSinceHeartbeat <= 180 ? 'DEGRADED' : 'DORMANT' },
          source: 'DATABASE',
          checkedAt,
          uptimeSeconds,
          message: lease.lastError
            ? `Worker reported execution error (${lease.consecutiveFailures ?? 1} consecutive failures): ${lease.lastError}`
            : `Worker is degraded (${lease.consecutiveFailures ?? 1} consecutive failures).`,
        };
      }

      // Online: genuine running worker with fresh heartbeat within 90s and unexpired lease
      if (isLeaseUnexpired && secondsSinceHeartbeat <= 90) {
        return {
          status: 'ONLINE',
          lease: { ...lease, status: 'ACTIVE' },
          source: 'DATABASE',
          checkedAt,
          uptimeSeconds,
          message: `Active daemon (PID ${lease.pid} on ${lease.hostname}) heartbeat ${secondsSinceHeartbeat}s ago.`,
        };
      }

      // Degraded: lease unexpired but heartbeat is between 91s and 180s (delayed tick)
      if (isLeaseUnexpired && secondsSinceHeartbeat <= 180) {
        return {
          status: 'DEGRADED',
          lease: { ...lease, status: 'DEGRADED' },
          source: 'DATABASE',
          checkedAt,
          uptimeSeconds,
          message: `Heartbeat delayed (${secondsSinceHeartbeat}s ago). Worker may be scanning market or syncing feeds.`,
        };
      }

      return {
        status: 'DORMANT',
        lease: { ...lease, status: 'DORMANT' },
        source: 'DATABASE',
        checkedAt,
        uptimeSeconds: 0,
        message: `Worker lease/heartbeat expired ${secondsSinceHeartbeat}s ago. Daemon is not running.`,
      };
    }
  } catch {
    // Database query failed, fall through to local check
  }

  // 2. Fall back to local file heartbeat if available on host
  try {
    const localHeartbeatPath = path.join(process.cwd(), 'storage', 'demo-worker', 'worker-heartbeat.json');
    const content = await fs.readFile(localHeartbeatPath, 'utf8');
    const data = JSON.parse(content) as Record<string, unknown>;
    const now = Date.now();
    const ageSeconds = Math.floor((now - (Number(data.timestamp) || now)) / 1000);
    const localStatus = String(data.status ?? 'STOPPED');
    const failures = Number(data.consecutiveFailures ?? 0);

    const localLease: WorkerLeaseInfo = {
      workerId: `local-${String(data.pid || 'pid')}`,
      hostname: 'localhost',
      pid: Number(data.pid) || 0,
      version: String(data.version || '1.0.0'),
      environment: 'DEMO',
      acquiredAt: String(data.updatedAt || checkedAt),
      heartbeatAt: String(data.updatedAt || checkedAt),
      expiresAt: new Date(now + 60_000).toISOString(),
      tickCount: Number(data.loopCount || data.tickCount || 0),
      consecutiveFailures: failures,
      lastError: typeof data.error === 'string' ? data.error : null,
      status:
        localStatus === 'STOPPED'
          ? 'STOPPED'
          : localStatus === 'CRASHED' || localStatus === 'ERROR' || failures > 0
            ? 'DEGRADED'
            : ageSeconds < 120
              ? 'ACTIVE'
              : 'DORMANT',
    };

    const healthStatus: WorkerHealthResult['status'] =
      localStatus === 'STOPPED'
        ? 'OFFLINE'
        : localStatus === 'CRASHED' || localStatus === 'ERROR' || failures > 0
          ? 'DEGRADED'
          : ageSeconds < 120
            ? 'ONLINE'
            : 'DORMANT';

    return {
      status: healthStatus,
      lease: localLease,
      source: 'LOCAL_STORAGE',
      checkedAt,
      message:
        healthStatus === 'ONLINE'
          ? `Local daemon active (PID ${localLease.pid}, heartbeat ${ageSeconds}s ago).`
          : healthStatus === 'OFFLINE'
            ? `Local daemon stopped at ${localLease.heartbeatAt}.`
            : healthStatus === 'DEGRADED'
              ? `Local daemon reported error: ${localLease.lastError ?? localStatus}`
              : `Local daemon heartbeat stale (${ageSeconds}s ago).`,
    };
  } catch {
    // Local storage not found
  }

  return {
    status: 'OFFLINE',
    lease: null,
    source: 'NONE',
    checkedAt,
    message: 'No active background automation daemon detected. Launch scripts/demo-trading-worker.mjs for continuous operation.',
  };
}

export async function acquireWorkerLease(info: {
  workerId: string;
  hostname: string;
  pid: number;
  version: string;
  environment?: 'DEMO' | 'TESTNET';
  ttlSeconds?: number;
  safeMode?: boolean;
}): Promise<{ ok: boolean; lease?: WorkerLeaseInfo; error?: string }> {
  const ttl = info.ttlSeconds || DEFAULT_TTL_SECONDS;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

  const lease: WorkerLeaseInfo = {
    workerId: info.workerId,
    hostname: info.hostname,
    pid: info.pid,
    version: info.version,
    environment: info.environment || 'DEMO',
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt,
    tickCount: 1,
    safeMode: info.safeMode,
    status: 'ACTIVE',
  };

  try {
    const { query } = await import('./db');
    const claimed = await query<{ value_json: WorkerLeaseInfo }>(
      `INSERT INTO public.app_settings (key, value_json, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value_json = EXCLUDED.value_json, updated_at = NOW()
       WHERE public.app_settings.value_json->>'workerId' = $3
          OR public.app_settings.value_json->>'status' IN ('STOPPED', 'ERROR')
          OR (public.app_settings.value_json->>'expiresAt') IS NULL
          OR (public.app_settings.value_json->>'expiresAt')::timestamptz <= NOW()
       RETURNING value_json`,
      [SETTING_KEY, JSON.stringify(lease), info.workerId],
    );

    if (claimed.rows[0]?.value_json) {
      return { ok: true, lease: claimed.rows[0].value_json };
    }

    const existing = await query<{ value_json: WorkerLeaseInfo }>(
      `SELECT value_json FROM public.app_settings WHERE key = $1`,
      [SETTING_KEY],
    );
    const current = existing.rows[0]?.value_json;
    return {
      ok: false,
      lease: current,
      error: current
        ? `Another active worker (${current.workerId} on ${current.hostname}, PID ${current.pid}) holds the lease until ${current.expiresAt}.`
        : 'Lease is currently held by another worker.',
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Database lease acquisition failed.' };
  }
}

export async function renewWorkerLease(info: {
  workerId: string;
  tickCount: number;
  activeCycle?: string;
  batchProgress?: string;
  scannedPairsCount?: number;
  lastSuccessfulScanAt?: string | null;
  lastScanDurationMs?: number;
  lastCandidateCount?: number;
  lastQualifiedCount?: number;
  totalTradesExecuted?: number;
  exchangeExecutionStatus?: string;
  protectionFailures?: number;
  emergencyStopStatus?: string;
  consecutiveFailures?: number;
  lastError?: string | null;
  safeMode?: boolean;
  ttlSeconds?: number;
}): Promise<boolean> {
  const ttl = info.ttlSeconds || DEFAULT_TTL_SECONDS;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

  try {
    const { query } = await import('./db');
    const existing = await query<{ value_json: WorkerLeaseInfo }>(
      `SELECT value_json FROM public.app_settings WHERE key = $1`,
      [SETTING_KEY],
    );

    if (!existing.rows[0]?.value_json) {
      return false;
    }

    const current = existing.rows[0].value_json;
    if (current.workerId !== info.workerId || current.status === 'STOPPED') {
      return false;
    }
    const existingExpiryMs = Date.parse(current.expiresAt);
    if (Number.isFinite(existingExpiryMs) && Date.now() > existingExpiryMs) {
      return false;
    }

    const updated: WorkerLeaseInfo = {
      ...current,
      heartbeatAt: now.toISOString(),
      expiresAt,
      tickCount: info.tickCount,
      activeCycle: info.activeCycle ?? current.activeCycle,
      batchProgress: info.batchProgress ?? current.batchProgress,
      scannedPairsCount: info.scannedPairsCount ?? current.scannedPairsCount,
      lastSuccessfulScanAt: info.lastSuccessfulScanAt !== undefined ? info.lastSuccessfulScanAt : current.lastSuccessfulScanAt,
      lastScanDurationMs: info.lastScanDurationMs ?? current.lastScanDurationMs,
      lastCandidateCount: info.lastCandidateCount ?? current.lastCandidateCount,
      lastQualifiedCount: info.lastQualifiedCount ?? current.lastQualifiedCount,
      totalTradesExecuted: info.totalTradesExecuted ?? current.totalTradesExecuted,
      exchangeExecutionStatus: info.exchangeExecutionStatus ?? current.exchangeExecutionStatus,
      protectionFailures: info.protectionFailures ?? current.protectionFailures,
      emergencyStopStatus: info.emergencyStopStatus ?? current.emergencyStopStatus,
      consecutiveFailures: info.consecutiveFailures ?? 0,
      lastError: info.lastError !== undefined ? info.lastError : null,
      safeMode: info.safeMode ?? current.safeMode,
      status: (info.consecutiveFailures ?? 0) > 0 ? 'DEGRADED' : 'ACTIVE',
    };

    const res = await query<{ value_json: WorkerLeaseInfo }>(
      `UPDATE public.app_settings
          SET value_json = $1::jsonb, updated_at = NOW()
        WHERE key = $2
          AND value_json->>'workerId' = $3
          AND value_json->>'status' <> 'STOPPED'
          AND (value_json->>'expiresAt')::timestamptz > NOW()
        RETURNING value_json`,
      [JSON.stringify(updated), SETTING_KEY, info.workerId],
    );

    return Boolean(res.rows[0]);
  } catch {
    return false;
  }
}

export async function releaseWorkerLease(workerId: string): Promise<void> {
  try {
    const { query } = await import('./db');
    const existing = await query<{ value_json: WorkerLeaseInfo }>(
      `SELECT value_json FROM public.app_settings WHERE key = $1`,
      [SETTING_KEY],
    );

    if (existing.rows[0]?.value_json) {
      const current = existing.rows[0].value_json;
      if (current.workerId === workerId) {
        const stopped: WorkerLeaseInfo = {
          ...current,
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          status: 'STOPPED',
        };
        await query(
          `UPDATE public.app_settings SET value_json = $1::jsonb, updated_at = NOW() WHERE key = $2 AND value_json->>'workerId' = $3`,
          [JSON.stringify(stopped), SETTING_KEY, workerId],
        );
      }
    }
  } catch {
    // Non-blocking cleanup
  }
}
