import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '../../../lib/auth';
import { forwardRequestToBackend, shouldForwardToBackend } from '../../../lib/backend-proxy';
import {
  listHighRiskScalpingSignals,
  markScalpingSignalEntered,
} from '../../../lib/high-risk-scalping';
import { validCsrf } from '../../../lib/http';
import { requirePremiumUser, SubscriptionError } from '../../../lib/subscriptions';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { user } = await requirePremiumUser({ reconcile: false });
    return NextResponse.json({ data: await listHighRiskScalpingSignals(user.id) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503;
    return NextResponse.json({
      error: error instanceof AuthError || error instanceof SubscriptionError ? error.message : 'High-risk scalping data is unavailable.',
      ...(error instanceof SubscriptionError ? { code: error.code } : {}),
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('mark_entered'), signalId: z.string().regex(/^\d{1,20}$/) }).strict(),
  z.object({ action: z.literal('scan') }).strict(),
]);

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const { user } = await requirePremiumUser();
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid scalping action.' }, { status: 400 }); }
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid scalping action.' }, { status: 422 });

    if (parsed.data.action === 'scan') {
      if (shouldForwardToBackend()) {
        const forwarded = await forwardRequestToBackend(request, '/api/scalping', {
          method: 'POST',
          bodyText: JSON.stringify(parsed.data),
          timeoutMs: 28_000,
        });
        if (forwarded) return forwarded;
      }
      const { runHighRiskScalpingScan } = await import('../../../lib/high-risk-scalping');
      const scanStart = Date.now();
      const result = await runHighRiskScalpingScan(globalThis.fetch, scanStart, { deliverNotifications: false });
      return NextResponse.json({
        data: {
          scanned: result.scanned,
          created: result.created,
          failed: result.failed,
          timeframes: result.timeframes,
          batchSize: result.batchSize,
          enabledPairs: result.enabledPairs,
          scannedAt: result.scannedAt,
        },
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    await markScalpingSignalEntered(user.id, parsed.data.signalId);
    return NextResponse.json({ data: { entered: true } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof SubscriptionError ? error.status : 422;
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Could not process this scalping request.',
      ...(error instanceof SubscriptionError ? { code: error.code } : {}),
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
