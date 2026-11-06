import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runSignalScan, SignalScanError } from '../../../../lib/signal-scan';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!secret || !supplied) return false;
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Scheduled scan authorization failed.' }, { status: 401 });
  }
  try {
    const data = await runSignalScan();
    return NextResponse.json({
      data,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Scheduled signal scan failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({
      error: error instanceof SignalScanError ? error.message : 'Scheduled signal processing failed.',
    }, { status: 503 });
  }
}
