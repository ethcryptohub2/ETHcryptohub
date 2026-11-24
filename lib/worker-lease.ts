import fs from 'node:fs/promises';
import path from 'node:path';
import type { QueryResultRow } from 'pg';

export interface WorkerLeaseInfo {
  [key: string]: any;
  workerId: string;
  hostname: string;
  pid: number;
  version: string;
  environment: 'DEMO' | 'TESTNET';
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  tickCount: number;
  lastScanDurationMs?: number;
  lastCandidateCount?: number;
  lastQualifiedCount?: number;
  status: 'ACTIVE' | 'DEGRADED' | 'DORMANT' | 'STOPPED';
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

async function safeDbQuery<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  try {
    const { query } = await import('./db');
    return await query<T>(sql, params);
  } catch {
    return { rows: [] };
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

      if (Number.isFinite(expiresAtMs) && now <= expiresAtMs) {
        return {
          status: 'ONLINE',
          lease: { ...lease, status: 'ACTIVE' },
          source: 'DATABASE',
          checkedAt,
          uptimeSeconds,
          message: `Active daemon (PID ${lease.pid} on ${lease.hostname}) renewing lease every tick.`,
        };
      }

      // Expired within grace period (less than 180s)
      const secondsSinceHeartbeat = Number.isFinite(heartbeatAtMs) ? Math.floor((now - heartbeatAtMs) / 1000) : 999;
      if (secondsSinceHeartbeat < 180) {
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
        message: `Worker lease expired ${secondsSinceHeartbeat}s ago. Daemon is not running.`,
      };
    }
  } catch {
    // Database query failed, fall through to local check
  }

  // 2. Fall back to local file heartbeat if available on host
  try {
    const localHeartbeatPath = path.join(process.cwd(), 'storage', 'demo-worker', 'worker-heartbeat.json');
    const content = await fs.readFile(localHeartbeatPath, 'utf8');
    const data = JSON.parse(content);
    const now = Date.now();
    const ageSeconds = Math.floor((now - (data.timestamp || now)) / 1000);

    const localLease: WorkerLeaseInfo = {
      workerId: `local-${data.pid || 'pid'}`,
      hostname: 'localhost',
      pid: data.pid || 0,
      version: data.version || '1.0.0',
      environment: 'DEMO',
      acquiredAt: data.updatedAt || checkedAt,
      heartbeatAt: data.updatedAt || checkedAt,
      expiresAt: new Date(now + 60_000).toISOString(),
      tickCount: data.tickCount || 0,
      status: ageSeconds < 120 ? 'ACTIVE' : 'DORMANT',
    };

    return {
      status: ageSeconds < 120 ? 'ONLINE' : 'DORMANT',
      lease: localLease,
      source: 'LOCAL_STORAGE',
      checkedAt,
      message: ageSeconds < 120
        ? `Local daemon active (PID ${data.pid}, heartbeat ${ageSeconds}s ago).`
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
    status: 'ACTIVE',
  };

  try {
    // Check if existing lease is still valid and owned by another worker
    const existing = await safeDbQuery<{ value_json: WorkerLeaseInfo }>(
      `SELECT value_json FROM public.app_settings WHERE key = $1`,
      [SETTING_KEY],
    );

    if (existing.rows[0]?.value_json) {
      const current = existing.rows[0].value_json;
      const currentExpiresAtMs = Date.parse(current.expiresAt);
      if (
        current.workerId !== info.workerId &&
        current.status === 'ACTIVE' &&
        Number.isFinite(currentExpiresAtMs) &&
        Date.now() < currentExpiresAtMs
      ) {
        return {
          ok: false,
          lease: current,
          error: `Another active worker (${current.workerId} on ${current.hostname}, PID ${current.pid}) holds the lease until ${current.expiresAt}.`,
        };
      }
    }

    await safeDbQuery(
      `INSERT INTO public.app_settings (key, value_json, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
      [SETTING_KEY, JSON.stringify(lease)],
    );

    return { ok: true, lease };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Database lease acquisition failed.' };
  }
}

export async function renewWorkerLease(info: {
  workerId: string;
  tickCount: number;
  lastScanDurationMs?: number;
  lastCandidateCount?: number;
  lastQualifiedCount?: number;
  ttlSeconds?: number;
}): Promise<boolean> {
  const ttl = info.ttlSeconds || DEFAULT_TTL_SECONDS;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

  try {
    const existing = await safeDbQuery<{ value_json: WorkerLeaseInfo }>(
      `SELECT value_json FROM public.app_settings WHERE key = $1`,
      [SETTING_KEY],
    );

    if (!existing.rows[0]?.value_json) {
      return false;
    }

    const current = existing.rows[0].value_json;
    if (current.workerId !== info.workerId) {
      return false;
    }

    const updated: WorkerLeaseInfo = {
      ...current,
      heartbeatAt: now.toISOString(),
      expiresAt,
      tickCount: info.tickCount,
      lastScanDurationMs: info.lastScanDurationMs ?? current.lastScanDurationMs,
      lastCandidateCount: info.lastCandidateCount ?? current.lastCandidateCount,
      lastQualifiedCount: info.lastQualifiedCount ?? current.lastQualifiedCount,
      status: 'ACTIVE',
    };

    await safeDbQuery(
      `UPDATE public.app_settings SET value_json = $1::jsonb, updated_at = NOW() WHERE key = $2`,
      [JSON.stringify(updated), SETTING_KEY],
    );

    return true;
  } catch {
    return false;
  }
}

export async function releaseWorkerLease(workerId: string): Promise<void> {
  try {
    const existing = await safeDbQuery<{ value_json: WorkerLeaseInfo }>(
      `SELECT value_json FROM public.app_settings WHERE key = $1`,
      [SETTING_KEY],
    );

    if (existing.rows[0]?.value_json) {
      const current = existing.rows[0].value_json;
      if (current.workerId === workerId) {
        const stopped: WorkerLeaseInfo = {
          ...current,
          heartbeatAt: new Date().toISOString(),
          status: 'STOPPED',
        };
        await safeDbQuery(
          `UPDATE public.app_settings SET value_json = $1::jsonb, updated_at = NOW() WHERE key = $2`,
          [JSON.stringify(stopped), SETTING_KEY],
        );
      }
    }
  } catch {
    // Non-blocking cleanup
  }
}
