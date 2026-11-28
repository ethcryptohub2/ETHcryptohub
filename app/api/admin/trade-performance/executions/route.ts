import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '@/lib/auth';
import { getDetailedExecutionHistory, DateFilterType, PerformanceFilterParams } from '@/lib/trade-performance-analytics';

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

    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get('pageSize') || '25', 10)));
    const search = searchParams.get('search') || '';
    const sortBy = searchParams.get('sortField') || searchParams.get('sortBy') || 'created_at';
    const sortOrder = (searchParams.get('sortOrder')?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC') as 'ASC' | 'DESC';

    const result = await getDetailedExecutionHistory({
      ...filterParams,
      page,
      pageSize,
      search,
      sortBy,
      sortOrder,
    });

    const executions = result.items.map((item) => ({
      id: item.id,
      userId: item.userId,
      userEmail: item.email,
      symbol: item.symbol,
      strategy: item.strategy,
      direction: item.side,
      status: item.executionStatus,
      exitReason: item.exitReason ?? '',
      createdAt: item.createdAt,
      closedAt: item.closedAt,
      entryFillPrice: item.entryPrice,
      exitFillPrice: item.exitFillPrice,
      executedQty: item.quantity,
      remainingQty: item.remainingQuantity,
      leverage: item.leverage,
      tp1ReachedAt: item.tp1ReachedAt,
      tp2ReachedAt: item.tp2ReachedAt,
      tp3ReachedAt: item.tp3ReachedAt,
      stopLossHitAt: item.stopLossStatus === 'TRIGGERED' ? item.closedAt : null,
      trailingStopHitAt: item.trailingStopStatus === 'TRIGGERED' ? item.closedAt : null,
      grossRealizedPnl: item.grossRealizedPnl,
      commissionUsdt: item.commission,
      fundingFeeUsdt: item.fundingFees,
      netRealizedPnl: item.netRealizedPnl,
      unrealizedPnl: item.unrealizedPnl ?? 0,
      binanceOrderId: item.binanceOrderId,
      reconciliationStatus: item.reconciliationStatus,
    }));

    return NextResponse.json(
      {
        data: {
          executions,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          totalPages: result.totalPages,
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
    console.error('Error fetching trade performance execution history:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Execution history unavailable.' },
      { status: 503 },
    );
  }
}
