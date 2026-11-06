import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { validCsrf } from '../../../../lib/http';
import {
  adjustPremiumAccess,
  consumeSubscriptionAdminLimit,
  generateLicenseCodes,
  listAdminSubscriptionData,
  revokeUnusedLicenseCode,
  SubscriptionError,
  updateSubscriptionPlans,
} from '../../../../lib/subscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const emailSchema = z.string().email().max(255);
const postSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('generate_codes'),
    planId: z.string().regex(/^\d+$/),
    count: z.number().int().min(1).max(100),
    assignedEmail: emailSchema.optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    note: z.string().trim().max(300).nullable(),
    manualPaymentVerified: z.literal(true),
    paymentReference: z.string().trim().min(1).max(160),
  }).strict(),
  z.object({ action: z.literal('revoke_code'), codeId: z.string().regex(/^\d+$/), reason: z.string().trim().max(300).nullable() }).strict(),
  z.object({
    action: z.literal('update_plans'),
    plans: z.array(z.object({
      id: z.string().regex(/^\d+$/),
      planName: z.string().trim().min(1).max(80),
      durationDays: z.number().int().min(1).max(3650),
      priceUsd: z.number().finite().min(0).max(1_000_000),
      isActive: z.boolean(),
    }).strict()).length(3),
  }).strict(),
  z.object({
    action: z.enum(['extend_premium', 'grant_complimentary']),
    userId: z.number().int().positive(),
    durationDays: z.number().int().min(1).max(3650),
    planId: z.string().regex(/^\d+$/).nullable(),
    reason: z.string().trim().min(3).max(300),
    paymentReference: z.string().trim().max(160).nullable(),
  }).strict(),
]);

function failure(error: unknown, fallback: string) {
  const isAuth = error instanceof AuthError;
  const isSubscription = error instanceof SubscriptionError;
  if (!isAuth && !isSubscription) {
    console.error('Subscription administration failed:', error instanceof Error ? error.message : 'Unknown error');
  }
  const status = isAuth ? error.status : isSubscription ? error.status : 503;
  return NextResponse.json({
    error: isAuth || isSubscription
      ? error.message
      : error instanceof Error
        ? error.message.replace(/[\r\n\t]/g, ' ').slice(0, 300) || fallback
        : fallback,
    ...(isSubscription ? { code: error.code } : {}),
  }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: NextRequest) {
  try {
    const admin = await requireAdmin();
    await consumeSubscriptionAdminLimit(admin.id, 'read');
    const params = request.nextUrl.searchParams;
    const parsed = z.object({
      search: z.string().trim().max(255).default(''),
      status: z.enum(['ALL', 'FREE_TRIAL', 'PREMIUM_ACTIVE', 'TRIAL_EXPIRED', 'PREMIUM_EXPIRED']).default('ALL'),
      codeStatus: z.enum(['ALL', 'UNUSED', 'REDEEMED', 'EXPIRED', 'REVOKED']).default('ALL'),
      userPage: z.coerce.number().int().min(1).max(100_000).default(1),
      codePage: z.coerce.number().int().min(1).max(100_000).default(1),
    }).safeParse(Object.fromEntries(params));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid subscription management filters.' }, { status: 422 });
    const data = await listAdminSubscriptionData(parsed.data);
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error, 'Subscription administration is unavailable. Apply the subscriptions migration.');
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const admin = await requireAdmin();
    await consumeSubscriptionAdminLimit(admin.id, 'write');
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid subscription action.' }, { status: 400 }); }
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid subscription action.' }, { status: 422 });
    const action = parsed.data;
    if (action.action === 'generate_codes') {
      const generated = await generateLicenseCodes({
        adminUserId: admin.id,
        planId: action.planId,
        count: action.count,
        assignedEmail: action.assignedEmail ?? null,
        expiresAt: action.expiresAt,
        note: action.note,
        paymentReference: action.paymentReference,
      });
      return NextResponse.json({ data: { codes: generated } }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (action.action === 'revoke_code') {
      await revokeUnusedLicenseCode(admin.id, action.codeId, action.reason);
      return NextResponse.json({ data: { revoked: true } }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (action.action === 'update_plans') {
      await updateSubscriptionPlans(admin.id, action.plans);
      return NextResponse.json({ data: { updated: true } }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const subscription = await adjustPremiumAccess({
      adminUserId: admin.id,
      userId: action.userId,
      action: action.action === 'grant_complimentary' ? 'complimentary' : 'extend',
      durationDays: action.durationDays,
      planId: action.planId,
      reason: action.reason,
      paymentReference: action.paymentReference,
    });
    return NextResponse.json({ data: { subscription } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error, 'Subscription administration action could not be completed.');
  }
}
