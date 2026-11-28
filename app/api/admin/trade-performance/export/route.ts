import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '@/lib/auth';
import {
  getTradePerformanceAnalytics,
  getDetailedExecutionHistory,
  DateFilterType,
  PerformanceFilterParams,
  DailyBreakdownRow,
} from '@/lib/trade-performance-analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(cells: unknown[]): string {
  return cells.map(escapeCsvField).join(',');
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();

    const searchParams = request.nextUrl.searchParams;
    const reportType = searchParams.get('reportType') || 'daily';

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

    const nowIso = new Date().toISOString().replace(/[:.]/g, '-');
    let csvContent = '';
    const filename = `trade-performance-${reportType}-${nowIso}.csv`;

    if (reportType === 'executions') {
      const history = await getDetailedExecutionHistory({
        ...filterParams,
        page: 1,
        pageSize: 5000,
        search: searchParams.get('search') || '',
        sortBy: 'created_at',
        sortOrder: 'DESC',
      });

      const headers = [
        'Execution ID',
        'Customer ID',
        'Customer Email',
        'Symbol',
        'Strategy',
        'Direction',
        'Status',
        'Exit Reason',
        'Opened At (UTC)',
        'Closed At (UTC)',
        'Entry Fill Price (USDT)',
        'Exit Fill Price (USDT)',
        'Executed Qty',
        'Remaining Qty',
        'Leverage',
        'TP1 Reached',
        'TP2 Reached',
        'TP3 Reached',
        'SL Hit',
        'Trailing Hit',
        'Gross Realized PnL (USDT)',
        'Commissions (USDT)',
        'Funding Fees (USDT)',
        'Net Realized PnL (USDT)',
        'Unrealized PnL (USDT)',
        'Binance Order ID',
        'Reconciliation Status',
      ];

      const rows = history.items.map((e) => [
        e.id,
        e.userId,
        e.email,
        e.symbol,
        e.strategy,
        e.side,
        e.executionStatus,
        e.exitReason ?? '',
        e.createdAt,
        e.closedAt ?? '',
        e.entryPrice,
        e.exitFillPrice ?? '',
        e.quantity,
        e.remainingQuantity,
        e.leverage,
        e.tp1Reached ? 'YES' : 'NO',
        e.tp2Reached ? 'YES' : 'NO',
        e.tp3Reached ? 'YES' : 'NO',
        e.stopLossStatus === 'TRIGGERED' ? 'YES' : 'NO',
        e.trailingStopStatus === 'TRIGGERED' ? 'YES' : 'NO',
        e.grossRealizedPnl.toFixed(4),
        e.commission.toFixed(4),
        e.fundingFees.toFixed(4),
        e.netRealizedPnl.toFixed(4),
        e.unrealizedPnl !== null ? e.unrealizedPnl.toFixed(4) : '',
        e.binanceOrderId ?? '',
        e.reconciliationStatus,
      ]);

      csvContent = [toCsvRow(headers), ...rows.map(toCsvRow)].join('\r\n');
    } else if (reportType === 'daily' || reportType === 'weekly' || reportType === 'custom') {
      const analytics = await getTradePerformanceAnalytics(filterParams);

      const headers = [
        'Date (IST)',
        'Total Trades',
        'Closed Trades',
        'Winning Trades',
        'Losing Trades',
        'TP1 Hits',
        'TP2 Hits',
        'TP3 Hits',
        'SL Hits',
        'Trailing Stop Hits',
        'Gross Realized Profit (USDT)',
        'Gross Realized Loss (USDT)',
        'Trading Commissions (USDT)',
        'Net Funding Fees (USDT)',
        'Net Realized PnL (USDT)',
        'Win Rate (%)',
      ];

      const rows = analytics.dailyBreakdown.map((d: DailyBreakdownRow) => [
        d.dateIst,
        d.totalTrades,
        d.closedTrades,
        d.winningTrades,
        d.losingTrades,
        d.tp1Hits,
        d.tp2Hits,
        d.tp3Hits,
        d.slHits,
        d.trailingStopHits,
        d.grossRealizedProfit.toFixed(4),
        d.grossRealizedLoss.toFixed(4),
        d.commissions.toFixed(4),
        d.fundingFees.toFixed(4),
        d.netRealizedPnl.toFixed(4),
        d.closedTrades > 0 ? ((d.winningTrades / d.closedTrades) * 100).toFixed(1) : '0.0',
      ]);

      csvContent = [toCsvRow(headers), ...rows.map(toCsvRow)].join('\r\n');
    } else if (reportType === 'customer') {
      const analytics = await getTradePerformanceAnalytics(filterParams);

      const headers = [
        'User ID',
        'Customer Email',
        'Trades Count',
        'Win Rate (%)',
        'Net Realized PnL (USDT)',
      ];

      const rows = analytics.charts.customers.map((c) => [
        c.userId,
        c.email,
        c.count,
        c.winRate.toFixed(1),
        c.netPnl.toFixed(4),
      ]);

      csvContent = [toCsvRow(headers), ...rows.map(toCsvRow)].join('\r\n');
    } else if (reportType === 'strategy') {
      const analytics = await getTradePerformanceAnalytics(filterParams);

      const headers = [
        'Strategy',
        'Trades Count',
        'Win Rate (%)',
        'Profit Factor',
        'Net Realized PnL (USDT)',
      ];

      const rows = [
        [
          'Standard Strategy',
          analytics.charts.strategies.standard.count,
          analytics.charts.strategies.standard.winRate.toFixed(1),
          analytics.charts.strategies.standard.profitFactor !== null ? analytics.charts.strategies.standard.profitFactor.toFixed(2) : '—',
          analytics.charts.strategies.standard.netPnl.toFixed(4),
        ],
        [
          'High-Risk Scalping',
          analytics.charts.strategies.highRisk.count,
          analytics.charts.strategies.highRisk.winRate.toFixed(1),
          analytics.charts.strategies.highRisk.profitFactor !== null ? analytics.charts.strategies.highRisk.profitFactor.toFixed(2) : '—',
          analytics.charts.strategies.highRisk.netPnl.toFixed(4),
        ],
      ];

      csvContent = [toCsvRow(headers), ...rows.map(toCsvRow)].join('\r\n');
    } else {
      return NextResponse.json({ error: 'Invalid reportType. Supported: daily, weekly, custom, executions, customer, strategy.' }, { status: 400 });
    }

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Error generating CSV export:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Report export failed.' },
      { status: 500 },
    );
  }
}
