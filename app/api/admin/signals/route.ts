import { NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { getAdminSignalStats, listSignalHistory } from '../../../../lib/signal-history';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const parsed = z.object({
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      symbol: z.string().trim().max(30).optional(),
      scannerType: z.enum(['STANDARD', 'HIGH_RISK']).optional(),
    }).safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid signal management filters.' }, { status: 422 });
    const { page, ...filters } = parsed.data;
    const [stats, history] = await Promise.all([
      getAdminSignalStats(),
      listSignalHistory({ ...filters, page, pageSize: 20 }),
    ]);
    return NextResponse.json({ data: { stats, history } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Signal management is unavailable.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
