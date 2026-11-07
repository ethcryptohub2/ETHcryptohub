import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runHighRiskScalpingScan } from '../../../../lib/high-risk-scalping';

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
    return NextResponse.json({ error: 'Scheduled scalping scan authorization failed.' }, { status: 401 });
  }
  try {
    const data = await runHighRiskScalpingScan();
    return NextResponse.json({ data }, {
      status: data.failed ? 503 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Scheduled high-risk scalping scan failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Scheduled high-risk scalping scan failed.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
