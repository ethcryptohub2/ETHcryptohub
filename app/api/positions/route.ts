import { NextRequest } from 'next/server';
import { AuthError } from '../../../lib/auth';
import { listUserSignalEntries } from '../../../lib/signal-history';
import { requirePremiumUser, SubscriptionError } from '../../../lib/subscriptions';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['ENTERED', 'CLOSED', 'ALL']).default('ALL'),
}).strict();

export async function GET(request: NextRequest) {
  try {
    const { user } = await requirePremiumUser({ reconcile: false });
    const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    const { page, pageSize, status } = parsed.success ? parsed.data : { page: 1, pageSize: 20, status: 'ALL' as const };

    const positionsResult = await listUserSignalEntries(user.id, { page, pageSize, status });

    return Response.json({
      data: {
        positions: positionsResult.items,
        pagination: {
          total: positionsResult.total,
          page: positionsResult.page,
          pageSize: positionsResult.pageSize,
          totalPages: positionsResult.totalPages,
        },
        summary: null,
      },
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof AuthError || error instanceof SubscriptionError ? error.message : 'Recorded positions are unavailable.' },
      { status: error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503 },
    );
  }
}
