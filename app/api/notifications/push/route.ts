import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, requireUser } from '../../../../lib/auth';
import {
  disablePushForUser,
  isSupportedPushEndpoint,
  removePushSubscription,
  upsertPushSubscription,
} from '../../../../lib/notifications';
import { validCsrf } from '../../../../lib/http';
import { requirePremiumUser, SubscriptionError } from '../../../../lib/subscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(16).max(256),
    auth: z.string().min(8).max(128),
  }).strict(),
  deviceType: z.enum(['browser', 'mobile', 'pwa']).default('browser'),
}).strict();

const endpointSchema = z.object({
  endpoint: z.string().url().max(2048).optional(),
  disableAll: z.boolean().optional(),
}).strict();

export async function GET() {
  try {
    await requirePremiumUser();
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    if (!publicKey || !process.env.VAPID_PRIVATE_KEY) {
      return NextResponse.json({ error: 'Push notifications are not configured on this deployment.' }, { status: 503 });
    }
    return NextResponse.json({ data: { publicKey } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError || error instanceof SubscriptionError ? error.message : 'Push configuration is unavailable.' },
      { status: error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const { user } = await requirePremiumUser();
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return NextResponse.json({ error: 'Push notifications are not configured on this deployment.' }, { status: 503 });
    }
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid push subscription.' }, { status: 400 }); }
    const parsed = subscriptionSchema.safeParse(body);
    if (!parsed.success || !isSupportedPushEndpoint(parsed.data.endpoint)) {
      return NextResponse.json({ error: 'Invalid push subscription.' }, { status: 422 });
    }
    await upsertPushSubscription(user.id, parsed.data);
    return NextResponse.json({ data: { subscribed: true } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof AuthError || error instanceof SubscriptionError
          ? error.message
          : error instanceof Error && error.message.includes('maximum of 10')
            ? error.message
            : error instanceof Error && error.message.includes('already associated')
              ? error.message
            : 'Push subscription could not be saved.',
      },
      {
        status: error instanceof AuthError || error instanceof SubscriptionError
          ? error.status
          : error instanceof Error && error.message.includes('maximum of 10')
            ? 429
            : error instanceof Error && error.message.includes('already associated')
              ? 409
              : 503,
      },
    );
  }
}

export async function DELETE(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid push subscription.' }, { status: 400 }); }
    const parsed = endpointSchema.safeParse(body);
    if (!parsed.success || (parsed.data.endpoint && !isSupportedPushEndpoint(parsed.data.endpoint))) {
      return NextResponse.json({ error: 'Invalid push subscription.' }, { status: 422 });
    }
    if (parsed.data.disableAll) {
      await disablePushForUser(user.id);
    } else if (parsed.data.endpoint) {
      await removePushSubscription(user.id, parsed.data.endpoint);
    } else {
      return NextResponse.json({ error: 'Provide a subscription endpoint or disableAll.' }, { status: 422 });
    }
    return NextResponse.json({ data: { subscribed: false } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Push subscription could not be removed.' },
      { status: error instanceof AuthError ? error.status : 503 },
    );
  }
}
