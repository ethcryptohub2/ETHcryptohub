import { z } from 'zod';
import { AuthError, requireAdmin } from '../../../../../lib/auth';
import { createBinanceEnvironmentAdapter } from '../../../../../lib/binance-futures';
import { isApprovedAdminDemoStagingTarget } from '../../../../../lib/admin-demo-staging-policy';
import {
  assertBinanceDemoOnly,
  inspectBinanceDemoReadiness,
  BinanceDemoPreflightError,
} from '../../../../../lib/binance-demo-preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  environment: z.string().optional(),
  symbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
  quantity: z.string().regex(/^\d+(?:\.\d+)?$/),
}).strict();

export async function GET(request: Request) {
  try {
    const admin = await requireAdmin();
    if (process.env.SMARTEXIT_ADMIN_BINANCE_DEMO_LAB_ENABLED !== 'true' ||
        !isApprovedAdminDemoStagingTarget(process.env)) {
      return Response.json({ error: 'Authenticated Binance Demo preflight is disabled.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      return Response.json({ error: 'Provide a valid symbol and quantity for a read-only Demo preflight.' }, { status: 422 });
    }
    assertBinanceDemoOnly(parsed.data.environment ?? 'DEMO');
    const adapter = await createBinanceEnvironmentAdapter(admin.id, 'DEMO');
    const data = await inspectBinanceDemoReadiness(adapter, parsed.data);
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError
      ? error.status
      : error instanceof BinanceDemoPreflightError
        ? 422
        : 503;
    return Response.json(
      { error: error instanceof Error ? error.message : 'Binance Demo preflight failed.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
