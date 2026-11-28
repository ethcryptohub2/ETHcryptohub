import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '@/lib/auth';
import { getTradePerformanceAnalytics, DateFilterType, PerformanceFilterParams } from '@/lib/trade-performance-analytics';
import { getSyncCheckpoint, getUnmatchedExchangeTrades } from '@/lib/trade-performance-reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();

    const searchParams = request.nextUrl.searchParams;

    const filterParams: PerformanceFilterParams = {
      dateFilter: (searchParams.get('dateFilter') as DateFilterType) || 'ALL_TIME',
      customFrom: searchParams.get('customFrom') || undefined,
      customTo: searchParams.get('customTo') || undefined,
      specificDate: searchParams.get('specificDate') || undefined,
      periodMode: (searchParams.get('periodMode') as 'opened' | 'closed' | 'both') || 'opened',
      customerId: searchParams.get('customerId') || 'ALL',
      strategy: (searchParams.get('strategy') as 'ALL' | 'STANDARD' | 'HIGH_RISK_SCALPING') || 'ALL',
      symbol: searchParams.get('symbol') || 'ALL',
      direction: (searchParams.get('direction') as 'ALL' | 'LONG' | 'SHORT') || 'ALL',
      status: (searchParams.get('status') as 'ALL' | 'OPEN' | 'CLOSED') || 'ALL',
    };

    const [analytics, syncCheckpoint, unmatchedTrades] = await Promise.all([
      getTradePerformanceAnalytics(filterParams),
      getSyncCheckpoint(),
      getUnmatchedExchangeTrades(30),
    ]);

    return NextResponse.json(
      {
        data: {
          analytics,
          syncCheckpoint,
          unmatchedTrades,
        },
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
    console.error('Error fetching trade performance summary:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Trade performance analytics unavailable.' },
      { status: 503 },
    );
  }
}
