import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { getWorkerHealthStatus, acquireWorkerLease, renewWorkerLease, releaseWorkerLease } from '../../../../lib/worker-lease';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

async function checkWorkerOrAdminAuth(request: NextRequest): Promise<boolean> {
  const workerSecret = request.headers.get('x-worker-secret');
  const validSecrets = [
    process.env.ADMIN_SETUP_TOKEN,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.CRON_SECRET,
  ].filter(Boolean) as string[];

  if (workerSecret && validSecrets.some(secret => secret === workerSecret)) {
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
      { error: 'Unauthorized: valid worker secret or admin session required.' },
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
    lastScanDurationMs?: number;
    lastCandidateCount?: number;
    lastQualifiedCount?: number;
    ttlSeconds?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request payload.' }, { status: 400, headers: noStore });
  }

  const { action, workerId, hostname, pid, version, environment, tickCount, lastScanDurationMs, lastCandidateCount, lastQualifiedCount, ttlSeconds } = body ?? {};

  if (action === 'acquire') {
    const workerSecret = request.headers.get('x-worker-secret');
    const validSecrets = [
      process.env.ADMIN_SETUP_TOKEN,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      process.env.CRON_SECRET,
    ].filter(Boolean) as string[];
    const hasWorkerSecret = Boolean(workerSecret && validSecrets.some(secret => secret === workerSecret));
    if (!hasWorkerSecret) {
      return NextResponse.json(
        { error: 'Valid worker secret header required to acquire lease.' },
        { status: 403, headers: noStore },
      );
    }
  }

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
        ttlSeconds,
      });
      return NextResponse.json({ ok: result.ok, lease: result.lease, error: result.error }, { status: result.ok ? 200 : 409, headers: noStore });
    }

    if (action === 'renew') {
      const renewed = await renewWorkerLease({
        workerId,
        tickCount: typeof tickCount === 'number' ? tickCount : 1,
        lastScanDurationMs,
        lastCandidateCount,
        lastQualifiedCount,
        ttlSeconds,
      });
      return NextResponse.json({ ok: renewed }, { headers: noStore });
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
