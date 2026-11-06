import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireUser } from '../../../lib/auth';
import { validCsrf } from '../../../lib/http';
import {
  activateLicenseCode,
  getAvailableSubscriptionPlans,
  getSubscriptionEntitlement,
  SubscriptionError,
} from '../../../lib/subscriptions';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    const [subscription, plans] = await Promise.all([
      getSubscriptionEntitlement(user.id),
      getAvailableSubscriptionPlans(),
    ]);
    return NextResponse.json({
      data: {
        subscription,
        plans,
        paymentMode: 'MANUAL_PAYMENT_VERIFICATION',
        supportEmail: process.env.SUBSCRIPTION_CONTACT_EMAIL ?? '',
      },
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    if (!(error instanceof AuthError)) {
      console.error('Subscription status request failed:', error instanceof Error ? error.message : 'Unknown error');
    }
    return NextResponse.json({
      error: error instanceof AuthError
        ? error.message
        : 'Subscription service is unavailable. Apply the subscriptions migration.',
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Enter an activation code.' }, { status: 400 }); }
    const parsed = z.object({ code: z.string().trim().min(1).max(40) }).strict().safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Enter a valid activation code.' }, { status: 422 });
    const subscription = await activateLicenseCode(user, parsed.data.code);
    return NextResponse.json({ data: { subscription } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, {
        status: error.status, headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (error instanceof SubscriptionError) {
      return NextResponse.json({ error: error.message, code: error.code }, {
        status: error.status, headers: { 'Cache-Control': 'no-store' },
      });
    }
    console.error('Subscription activation failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Activation could not be completed. Try again later.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
