import { NextRequest, NextResponse } from 'next/server';
import { isApprovedAdminDemoStagingTarget } from '../../../../lib/admin-demo-staging-policy';
import { isAuthorizedCronRequest } from '../../../../lib/cron-auth';
import { reconcileBinanceDemoProtection } from '../../../../lib/trading-execution';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Protection reconciliation authorization failed.' }, { status: 401 });
  }
  if (
    process.env.SMARTEXIT_CRON_RECONCILIATION_ENABLED !== 'true' ||
    process.env.SMARTEXIT_CRON_TARGET_ENVIRONMENT?.trim().toLowerCase() !== 'staging' ||
    !isApprovedAdminDemoStagingTarget(process.env)
  ) {
    return NextResponse.json(
      { error: 'Protection reconciliation is available only for the approved Staging target.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  try {
    const data = await reconcileBinanceDemoProtection();
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Binance Demo protection reconciliation failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Binance Demo protection reconciliation failed.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
