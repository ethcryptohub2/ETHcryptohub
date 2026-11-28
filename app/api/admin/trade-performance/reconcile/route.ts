import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '@/lib/auth';
import { validCsrf } from '@/lib/http';
import { reconcileBinanceDemoReporting } from '@/lib/trade-performance-reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) {
    return NextResponse.json({ error: 'Invalid or missing CSRF token. Refresh and retry.' }, { status: 403 });
  }

  try {
    await requireAdmin();

    let fullBackfill = false;
    try {
      const body = await request.json();
      if (body && typeof body.fullBackfill === 'boolean') {
        fullBackfill = body.fullBackfill;
      }
    } catch {
      // Empty or non-JSON body is acceptable
    }

    const result = await reconcileBinanceDemoReporting({ force: fullBackfill });

    return NextResponse.json(
      {
        data: result,
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      },
    );
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Error in trade performance reconciliation trigger:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Reconciliation service encountered an unexpected error.' },
      { status: 500 },
    );
  }
}
