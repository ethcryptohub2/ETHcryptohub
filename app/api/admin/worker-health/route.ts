import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin, safeEqual } from '../../../../lib/auth';
import { getWorkerHealthStatus, acquireWorkerLease, renewWorkerLease, releaseWorkerLease } from '../../../../lib/worker-lease';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

function hasValidWorkerSecret(request: NextRequest): boolean {
  const workerSecret = request.headers.get('x-worker-secret');
  if (!workerSecret || workerSecret.length < 32) return false;

  const validSecrets = [
    process.env.WORKER_SECRET,
    process.env.CRON_SECRET,
  ].filter((secret): secret is string => typeof secret === 'string' && secret.length >= 32);

  return validSecrets.some((secret) => safeEqual(secret, workerSecret));
}

async function checkWorkerOrAdminAuth(request: NextRequest): Promise<boolean> {
  if (hasValidWorkerSecret(request)) {
    return true;
  }

  try {
    await requireAdmin();
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Administrator access required.' },
      { status: error instanceof AuthError ? error.status : 403, headers: noStore },
    );
  }

  try {
    const health = await getWorkerHealthStatus();
    return NextResponse.json({ ok: true, data: health }, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Worker health status could not be retrieved.' },
      { status: 500, headers: noStore },
    );
  }
}

export async function POST(request: NextRequest) {
  const isAuthorized = await checkWorkerOrAdminAuth(request);
  if (!isAuthorized) {
    return NextResponse.json(
      { error: 'Unauthorized: valid worker secret (>=32 chars) or admin session required.' },
      { status: 403, headers: noStore },
    );
  }

  let body: {
    action?: string;
    workerId?: string;
    hostname?: string;
    pid?: number;
    version?: string;
    environment?: 'DEMO' | 'TESTNET';
    tickCount?: number;
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
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request payload.' }, { status: 400, headers: noStore });
  }

  const {
    action,
    workerId,
    hostname,
    pid,
    version,
    environment,
    tickCount,
    activeCycle,
    batchProgress,
    scannedPairsCount,
    lastSuccessfulScanAt,
    lastScanDurationMs,
    lastCandidateCount,
    lastQualifiedCount,
    totalTradesExecuted,
    exchangeExecutionStatus,
    protectionFailures,
    emergencyStopStatus,
    consecutiveFailures,
    lastError,
    safeMode,
    ttlSeconds,
  } = body ?? {};

  if (!workerId || typeof workerId !== 'string') {
    return NextResponse.json({ error: 'workerId is required.' }, { status: 422, headers: noStore });
  }

  try {
    if (action === 'acquire') {
      const result = await acquireWorkerLease({
        workerId,
        hostname: hostname || 'worker-host',
        pid: pid || 1,
        version: version || '1.0.0',
        environment: environment || 'DEMO',
        safeMode,
        ttlSeconds,
      });
      return NextResponse.json({ ok: result.ok, lease: result.lease, error: result.error }, { status: result.ok ? 200 : 409, headers: noStore });
    }

    if (action === 'renew') {
      const renewed = await renewWorkerLease({
        workerId,
        tickCount: typeof tickCount === 'number' ? tickCount : 1,
        activeCycle,
        batchProgress,
        scannedPairsCount,
        lastSuccessfulScanAt,
        lastScanDurationMs,
        lastCandidateCount,
        lastQualifiedCount,
        totalTradesExecuted,
        exchangeExecutionStatus,
        protectionFailures,
        emergencyStopStatus,
        consecutiveFailures,
        lastError,
        safeMode,
        ttlSeconds,
      });
      return NextResponse.json({ ok: renewed }, { status: renewed ? 200 : 409, headers: noStore });
    }

    if (action === 'release') {
      await releaseWorkerLease(workerId);
      return NextResponse.json({ ok: true }, { headers: noStore });
    }

    return NextResponse.json({ error: 'Invalid action. Supported actions: acquire, renew, release.' }, { status: 400, headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Worker lease operation failed.' },
      { status: 500, headers: noStore },
    );
  }
}
