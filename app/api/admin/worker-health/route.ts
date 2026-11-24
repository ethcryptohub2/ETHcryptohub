import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { getWorkerHealthStatus } from '../../../../lib/worker-lease';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
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
