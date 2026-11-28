import 'server-only';

import { query } from './db';

export type DateFilterType =
  | 'TODAY'
  | 'YESTERDAY'
  | 'LAST_7_DAYS'
  | 'THIS_WEEK'
  | 'LAST_WEEK'
  | 'THIS_MONTH'
  | 'CUSTOM'
  | 'INDIVIDUAL_DATE'
  | 'ALL_TIME';

export interface PerformanceFilterParams {
  dateFilter?: DateFilterType;
  customFrom?: string; // YYYY-MM-DD
  customTo?: string;   // YYYY-MM-DD
  specificDate?: string; // YYYY-MM-DD
  periodMode?: 'opened' | 'closed' | 'both';
  customerId?: string; // 'ALL' or user_id
  strategy?: 'ALL' | 'STANDARD' | 'HIGH_RISK_SCALPING';
  symbol?: string; // 'ALL' or ticker
  direction?: 'ALL' | 'LONG' | 'SHORT';
  status?: 'ALL' | 'OPEN' | 'CLOSED';
}

export interface DateRangeUtc {
  startUtc: string | null;
  endUtc: string | null;
  label: string;
}

export interface SummaryCardsData {
  totalExecutedTrades: number;
  tradesOpenedInPeriod: number;
  currentlyOpenTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  tp1HitCount: number;
  tp2HitCount: number;
  tp3HitCount: number;
  stopLossHitCount: number;
  trailingStopHitCount: number;
  manualCloseCount: number;
  winRate: number; // percentage 0-100
  grossRealizedProfit: number; // USDT
  grossRealizedLoss: number; // USDT (positive number representing loss)
  totalCommissions: number; // USDT
  netFundingFees: number; // USDT (signed)
  netRealizedPnl: number; // USDT (signed)
  currentUnrealizedPnl: number; // USDT
  profitFactor: number | null; // null if no loss/infinite
  avgProfitPerTrade: number; // USDT
  avgLossPerTrade: number; // USDT
}

export interface DailyBreakdownRow {
  dateIst: string; // YYYY-MM-DD
  totalTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  tp1Hits: number;
  tp2Hits: number;
  tp3Hits: number;
  slHits: number;
  trailingStopHits: number;
  grossRealizedProfit: number;
  grossRealizedLoss: number;
  commissions: number;
  fundingFees: number;
  netRealizedPnl: number;
}

export interface PerformanceAnalyticsResult {
  filters: PerformanceFilterParams;
  dateRange: DateRangeUtc;
  summary: SummaryCardsData;
  charts: {
    dailyPnl: Array<{ date: string; netPnl: number; grossProfit: number; grossLoss: number; count: number }>;
    weeklyPnl: Array<{ week: string; netPnl: number; count: number }>;
    cumulativePnl: Array<{ time: string; cumulativePnl: number; tradeIndex: number }>;
    winLoss: { winning: number; losing: number; breakeven: number };
    milestones: { tp1: number; tp2: number; tp3: number; sl: number; trailingStop: number; manual: number };
    strategies: {
      standard: { count: number; netPnl: number; winRate: number; profitFactor: number | null };
      highRisk: { count: number; netPnl: number; winRate: number; profitFactor: number | null };
    };
    directions: {
      long: { count: number; netPnl: number; winRate: number };
      short: { count: number; netPnl: number; winRate: number };
    };
    symbols: Array<{ symbol: string; count: number; netPnl: number; winRate: number }>;
    customers: Array<{ userId: number; email: string; count: number; netPnl: number; winRate: number }>;
  };
  dailyBreakdown: DailyBreakdownRow[];
  activePositions: Array<{
    id: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    strategy: string;
    actualFillPrice: number;
    markPrice: number;
    quantity: number;
    leverage: number;
    notionalUsdt: number;
    unrealizedPnl: number;
    tp1: number | null;
    tp2: number | null;
    tp3: number | null;
    stopLoss: number | null;
    createdAt: string;
    tp1Reached: boolean;
    tp2Reached: boolean;
  }>;
  syncInfo: {
    lastSyncedAt: string | null;
    status: 'OK' | 'STALE' | 'ERROR';
    isStale: boolean;
    staleReason?: string;
  };
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30

/**
 * Calculates start and end timestamps in UTC from IST calendar boundaries.
 */
export function computeIstDateRange(
  filter: DateFilterType = 'ALL_TIME',
  customFrom?: string,
  customTo?: string,
  specificDate?: string,
): DateRangeUtc {
  const nowUtc = Date.now();
  const nowIst = new Date(nowUtc + IST_OFFSET_MS);

  // Helper to format Date in IST to YYYY-MM-DD
  const formatIstDate = (d: Date) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // Helper to convert an IST YYYY-MM-DD string to start of day in UTC
  const istStartToUtc = (dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    // 00:00:00 IST is previous day 18:30:00 UTC
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS).toISOString();
  };

  // Helper to convert an IST YYYY-MM-DD string to end of day in UTC
  const istEndToUtc = (dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    // 23:59:59.999 IST is same day 18:29:59.999 UTC
    return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - IST_OFFSET_MS).toISOString();
  };

  const todayStr = formatIstDate(nowIst);

  switch (filter) {
    case 'TODAY': {
      return {
        startUtc: istStartToUtc(todayStr),
        endUtc: istEndToUtc(todayStr),
        label: `Today (IST, ${todayStr})`,
      };
    }
    case 'YESTERDAY': {
      const yesterday = new Date(nowIst.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayStr = formatIstDate(yesterday);
      return {
        startUtc: istStartToUtc(yesterdayStr),
        endUtc: istEndToUtc(yesterdayStr),
        label: `Yesterday (IST, ${yesterdayStr})`,
      };
    }
    case 'LAST_7_DAYS': {
      const sevenDaysAgo = new Date(nowIst.getTime() - 6 * 24 * 60 * 60 * 1000);
      const sevenDaysAgoStr = formatIstDate(sevenDaysAgo);
      return {
        startUtc: istStartToUtc(sevenDaysAgoStr),
        endUtc: istEndToUtc(todayStr),
        label: `Last 7 Days (IST, ${sevenDaysAgoStr} to ${todayStr})`,
      };
    }
    case 'THIS_WEEK': {
      // Find Monday of this week in IST (Monday = 1, Sunday = 0)
      const dayOfWeek = nowIst.getUTCDay();
      const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const monday = new Date(nowIst.getTime() - diffToMonday * 24 * 60 * 60 * 1000);
      const mondayStr = formatIstDate(monday);
      return {
        startUtc: istStartToUtc(mondayStr),
        endUtc: istEndToUtc(todayStr),
        label: `This Week (IST, from Monday ${mondayStr})`,
      };
    }
    case 'LAST_WEEK': {
      const dayOfWeek = nowIst.getUTCDay();
      const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const thisMonday = new Date(nowIst.getTime() - diffToMonday * 24 * 60 * 60 * 1000);
      const lastMonday = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
      const lastSunday = new Date(thisMonday.getTime() - 1 * 24 * 60 * 60 * 1000);
      const lastMondayStr = formatIstDate(lastMonday);
      const lastSundayStr = formatIstDate(lastSunday);
      return {
        startUtc: istStartToUtc(lastMondayStr),
        endUtc: istEndToUtc(lastSundayStr),
        label: `Last Week (IST, ${lastMondayStr} to ${lastSundayStr})`,
      };
    }
    case 'THIS_MONTH': {
      const y = nowIst.getUTCFullYear();
      const m = String(nowIst.getUTCMonth() + 1).padStart(2, '0');
      const firstDayStr = `${y}-${m}-01`;
      return {
        startUtc: istStartToUtc(firstDayStr),
        endUtc: istEndToUtc(todayStr),
        label: `This Month (IST, ${firstDayStr} to ${todayStr})`,
      };
    }
    case 'CUSTOM': {
      if (customFrom && customTo) {
        return {
          startUtc: istStartToUtc(customFrom),
          endUtc: istEndToUtc(customTo),
          label: `Custom Range (IST, ${customFrom} to ${customTo})`,
        };
      }
      return { startUtc: null, endUtc: null, label: 'All Time' };
    }
    case 'INDIVIDUAL_DATE': {
      if (specificDate) {
        return {
          startUtc: istStartToUtc(specificDate),
          endUtc: istEndToUtc(specificDate),
          label: `Date: ${specificDate} (IST)`,
        };
      }
      return { startUtc: null, endUtc: null, label: 'All Time' };
    }
    case 'ALL_TIME':
    default:
      return { startUtc: null, endUtc: null, label: 'All Time (Since Nov 27, 2026)' };
  }
}

/**
 * Converts a UTC ISO string to IST Date string (YYYY-MM-DD).
 */
export function utcToIstDateString(utcIso: string): string {
  const ms = new Date(utcIso).getTime();
  const ist = new Date(ms + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns complete Trade Performance Report analytics and summary cards.
 */
export async function getTradePerformanceAnalytics(
  params: PerformanceFilterParams = {},
): Promise<PerformanceAnalyticsResult> {
  const dateFilter = params.dateFilter || 'ALL_TIME';
  const dateRange = computeIstDateRange(dateFilter, params.customFrom, params.customTo, params.specificDate);
  const periodMode = params.periodMode || 'both';

  // Build SQL filters
  const conditions: string[] = [
    `te.exchange = 'BINANCE'`,
    `te.environment = 'DEMO'`,
    // Exclude rejected, failed entry orders, unfilled paper signals
    `te.execution_status IN ('ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED', 'CLOSED')`,
  ];
  const queryParams: (string | number | boolean | null)[] = [];
  let paramIdx = 1;

  if (params.customerId && params.customerId !== 'ALL') {
    conditions.push(`te.user_id = $${paramIdx++}`);
    queryParams.push(Number(params.customerId));
  }

  if (params.strategy && params.strategy !== 'ALL') {
    conditions.push(`te.strategy = $${paramIdx++}`);
    queryParams.push(params.strategy);
  }

  if (params.symbol && params.symbol !== 'ALL') {
    conditions.push(`te.symbol = $${paramIdx++}`);
    queryParams.push(params.symbol.trim().toUpperCase());
  }

  if (params.direction && params.direction !== 'ALL') {
    conditions.push(`te.side = $${paramIdx++}`);
    queryParams.push(params.direction);
  }

  if (params.status && params.status !== 'ALL') {
    if (params.status === 'OPEN') {
      conditions.push(`te.execution_status IN ('ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED')`);
    } else if (params.status === 'CLOSED') {
      conditions.push(`te.execution_status = 'CLOSED'`);
    }
  }

  // Date filtering logic respecting periodMode:
  // 'opened': trades created during period
  // 'closed': trades closed during period
  // 'both': trades either opened or closed during period
  if (dateRange.startUtc && dateRange.endUtc) {
    if (periodMode === 'opened') {
      conditions.push(`te.created_at >= $${paramIdx++}::TIMESTAMPTZ AND te.created_at <= $${paramIdx++}::TIMESTAMPTZ`);
      queryParams.push(dateRange.startUtc, dateRange.endUtc);
    } else if (periodMode === 'closed') {
      conditions.push(`te.closed_at IS NOT NULL AND te.closed_at >= $${paramIdx++}::TIMESTAMPTZ AND te.closed_at <= $${paramIdx++}::TIMESTAMPTZ`);
      queryParams.push(dateRange.startUtc, dateRange.endUtc);
    } else {
      conditions.push(
        `((te.created_at >= $${paramIdx}::TIMESTAMPTZ AND te.created_at <= $${paramIdx + 1}::TIMESTAMPTZ) OR (te.closed_at IS NOT NULL AND te.closed_at >= $${paramIdx}::TIMESTAMPTZ AND te.closed_at <= $${paramIdx + 1}::TIMESTAMPTZ))`,
      );
      queryParams.push(dateRange.startUtc, dateRange.endUtc);
      paramIdx += 2;
    }
  }

  const whereClause = conditions.join(' AND ');

  // Fetch all filtered execution records
  const querySql = `
    SELECT te.id::TEXT, te.user_id, u.email, te.symbol, te.side, te.strategy, te.execution_status,
           te.quantity::TEXT, te.notional_usdt::TEXT, te.leverage,
           te.entry_price::TEXT, te.actual_fill_price::TEXT, te.exit_fill_price::TEXT,
           te.stop_loss::TEXT, te.take_profit::TEXT, te.tp1_price::TEXT, te.tp2_price::TEXT, te.tp3_price::TEXT,
           te.tp1_reached_at::TEXT, te.tp2_reached_at::TEXT, te.tp3_reached_at::TEXT,
           te.realized_pnl::TEXT, te.commission_usdt::TEXT, te.funding_fee_usdt::TEXT, te.net_realized_pnl::TEXT,
           te.exit_reason, te.binance_order_id, te.client_order_id, te.reconciliation_status,
           te.created_at::TEXT, te.closed_at::TEXT, te.last_reconciled_at::TEXT
      FROM public.trade_executions te
      LEFT JOIN public.users u ON u.id = te.user_id
     WHERE ${whereClause}
     ORDER BY te.created_at DESC
  `;

  const execRes = await query<{
    id: string;
    user_id: number;
    email: string | null;
    symbol: string;
    side: 'LONG' | 'SHORT';
    strategy: 'STANDARD' | 'HIGH_RISK_SCALPING';
    execution_status: string;
    quantity: string;
    notional_usdt: string;
    leverage: number;
    entry_price: string;
    actual_fill_price: string | null;
    exit_fill_price: string | null;
    stop_loss: string;
    take_profit: string;
    tp1_price: string | null;
    tp2_price: string | null;
    tp3_price: string | null;
    tp1_reached_at: string | null;
    tp2_reached_at: string | null;
    tp3_reached_at: string | null;
    realized_pnl: string | null;
    commission_usdt: string | null;
    funding_fee_usdt: string | null;
    net_realized_pnl: string | null;
    exit_reason: string | null;
    binance_order_id: string | null;
    client_order_id: string;
    reconciliation_status: string | null;
    created_at: string;
    closed_at: string | null;
    last_reconciled_at: string | null;
  }>(querySql, queryParams);

  const executions = execRes.rows;

  // Compute 23 Summary Cards metrics
  let totalExecutedTrades = 0;
  let tradesOpenedInPeriod = 0;
  let currentlyOpenTrades = 0;
  let closedTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let breakevenTrades = 0;
  let tp1HitCount = 0;
  let tp2HitCount = 0;
  let tp3HitCount = 0;
  let stopLossHitCount = 0;
  let trailingStopHitCount = 0;
  let manualCloseCount = 0;

  let grossRealizedProfit = 0;
  let grossRealizedLoss = 0;
  let totalCommissions = 0;
  let netFundingFees = 0;
  let netRealizedPnl = 0;
  const currentUnrealizedPnl = 0;

  // Chart data structures
  const dailyPnlMap = new Map<string, { netPnl: number; grossProfit: number; grossLoss: number; count: number }>();
  const symbolStatsMap = new Map<string, { count: number; netPnl: number; wins: number; closedCount: number }>();
  const customerStatsMap = new Map<number, { email: string; count: number; netPnl: number; wins: number; closedCount: number }>();
  const dailyBreakdownMap = new Map<string, DailyBreakdownRow>();

  const strategyStats = {
    standard: { count: 0, closed: 0, wins: 0, grossProfit: 0, grossLoss: 0, netPnl: 0 },
    highRisk: { count: 0, closed: 0, wins: 0, grossProfit: 0, grossLoss: 0, netPnl: 0 },
  };

  const directionStats = {
    long: { count: 0, closed: 0, wins: 0, netPnl: 0 },
    short: { count: 0, closed: 0, wins: 0, netPnl: 0 },
  };

  const activePositionsList: PerformanceAnalyticsResult['activePositions'] = [];

  for (const exec of executions) {
    totalExecutedTrades++;

    const isClosed = exec.execution_status === 'CLOSED';
    const isOpen = ['ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED'].includes(exec.execution_status);
    const comm = Number(exec.commission_usdt ?? 0);
    const fund = Number(exec.funding_fee_usdt ?? 0);
    const realPnl = Number(exec.realized_pnl ?? 0);
    const netPnl = exec.net_realized_pnl !== null ? Number(exec.net_realized_pnl) : (realPnl - comm + fund);

    const istCreatedDate = utcToIstDateString(exec.created_at);
    const istClosedDate = exec.closed_at ? utcToIstDateString(exec.closed_at) : null;

    // Check if opened during period
    if (dateRange.startUtc && dateRange.endUtc) {
      const cTime = new Date(exec.created_at).getTime();
      const sTime = new Date(dateRange.startUtc).getTime();
      const eTime = new Date(dateRange.endUtc).getTime();
      if (cTime >= sTime && cTime <= eTime) {
        tradesOpenedInPeriod++;
      }
    } else {
      tradesOpenedInPeriod++;
    }

    // Milestones (non mutually exclusive)
    if (exec.tp1_reached_at || exec.exit_reason === 'TAKE_PROFIT_1') tp1HitCount++;
    if (exec.tp2_reached_at || exec.exit_reason === 'TAKE_PROFIT_2') tp2HitCount++;
    if (exec.tp3_reached_at || exec.exit_reason === 'TAKE_PROFIT_3') tp3HitCount++;
    if (exec.exit_reason === 'STOP_LOSS') stopLossHitCount++;
    if (exec.exit_reason === 'TRAILING_STOP') trailingStopHitCount++;
    if (exec.exit_reason === 'MANUAL_CLOSE') manualCloseCount++;

    totalCommissions += comm;
    netFundingFees += fund;

    // Open position handling
    if (isOpen) {
      currentlyOpenTrades++;
      const fillPrice = Number(exec.actual_fill_price || exec.entry_price);
      const qty = Number(exec.quantity);
      const lev = exec.leverage || 1;
      const notional = qty * fillPrice;

      activePositionsList.push({
        id: exec.id,
        symbol: exec.symbol,
        side: exec.side,
        strategy: exec.strategy,
        actualFillPrice: fillPrice,
        markPrice: fillPrice, // refreshed in client or reconciliation
        quantity: qty,
        leverage: lev,
        notionalUsdt: notional,
        unrealizedPnl: 0,
        tp1: exec.tp1_price ? Number(exec.tp1_price) : null,
        tp2: exec.tp2_price ? Number(exec.tp2_price) : null,
        tp3: exec.tp3_price ? Number(exec.tp3_price) : null,
        stopLoss: exec.stop_loss ? Number(exec.stop_loss) : null,
        createdAt: exec.created_at,
        tp1Reached: Boolean(exec.tp1_reached_at),
        tp2Reached: Boolean(exec.tp2_reached_at),
      });
    }

    // Closed trade accounting
    if (isClosed) {
      closedTrades++;
      netRealizedPnl += netPnl;

      if (realPnl > 0) {
        grossRealizedProfit += realPnl;
      } else if (realPnl < 0) {
        grossRealizedLoss += Math.abs(realPnl);
      }

      if (netPnl > 0.00000001) {
        winningTrades++;
      } else if (netPnl < -0.00000001) {
        losingTrades++;
      } else {
        breakevenTrades++;
      }

      // Grouping by Date for charts and breakdown (using event closed date in IST)
      const eventDateIst = istClosedDate || istCreatedDate;
      const dayEntry = dailyPnlMap.get(eventDateIst) ?? { netPnl: 0, grossProfit: 0, grossLoss: 0, count: 0 };
      dayEntry.netPnl += netPnl;
      dayEntry.count++;
      if (realPnl > 0) dayEntry.grossProfit += realPnl;
      else if (realPnl < 0) dayEntry.grossLoss += Math.abs(realPnl);
      dailyPnlMap.set(eventDateIst, dayEntry);

      // Daily Breakdown Table entry
      const bdEntry = dailyBreakdownMap.get(eventDateIst) ?? {
        dateIst: eventDateIst,
        totalTrades: 0,
        closedTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        tp1Hits: 0,
        tp2Hits: 0,
        tp3Hits: 0,
        slHits: 0,
        trailingStopHits: 0,
        grossRealizedProfit: 0,
        grossRealizedLoss: 0,
        commissions: 0,
        fundingFees: 0,
        netRealizedPnl: 0,
      };
      bdEntry.totalTrades++;
      bdEntry.closedTrades++;
      if (netPnl > 0) bdEntry.winningTrades++;
      else if (netPnl < 0) bdEntry.losingTrades++;
      if (exec.tp1_reached_at || exec.exit_reason === 'TAKE_PROFIT_1') bdEntry.tp1Hits++;
      if (exec.tp2_reached_at || exec.exit_reason === 'TAKE_PROFIT_2') bdEntry.tp2Hits++;
      if (exec.tp3_reached_at || exec.exit_reason === 'TAKE_PROFIT_3') bdEntry.tp3Hits++;
      if (exec.exit_reason === 'STOP_LOSS') bdEntry.slHits++;
      if (exec.exit_reason === 'TRAILING_STOP') bdEntry.trailingStopHits++;
      if (realPnl > 0) bdEntry.grossRealizedProfit += realPnl;
      else if (realPnl < 0) bdEntry.grossRealizedLoss += Math.abs(realPnl);
      bdEntry.commissions += comm;
      bdEntry.fundingFees += fund;
      bdEntry.netRealizedPnl += netPnl;
      dailyBreakdownMap.set(eventDateIst, bdEntry);

      // Strategy stats
      const st = exec.strategy === 'STANDARD' ? strategyStats.standard : strategyStats.highRisk;
      st.closed++;
      st.netPnl += netPnl;
      if (realPnl > 0) st.grossProfit += realPnl;
      else if (realPnl < 0) st.grossLoss += Math.abs(realPnl);
      if (netPnl > 0) st.wins++;

      // Direction stats
      const dir = exec.side === 'LONG' ? directionStats.long : directionStats.short;
      dir.closed++;
      dir.netPnl += netPnl;
      if (netPnl > 0) dir.wins++;

      // Symbol stats
      const symEntry = symbolStatsMap.get(exec.symbol) ?? { count: 0, netPnl: 0, wins: 0, closedCount: 0 };
      symEntry.count++;
      symEntry.closedCount++;
      symEntry.netPnl += netPnl;
      if (netPnl > 0) symEntry.wins++;
      symbolStatsMap.set(exec.symbol, symEntry);

      // Customer stats
      const custEntry = customerStatsMap.get(exec.user_id) ?? {
        email: exec.email ?? `User #${exec.user_id}`,
        count: 0,
        netPnl: 0,
        wins: 0,
        closedCount: 0,
      };
      custEntry.count++;
      custEntry.closedCount++;
      custEntry.netPnl += netPnl;
      if (netPnl > 0) custEntry.wins++;
      customerStatsMap.set(exec.user_id, custEntry);
    } else {
      // Open trade contribution to daily breakdown
      const bdEntry = dailyBreakdownMap.get(istCreatedDate) ?? {
        dateIst: istCreatedDate,
        totalTrades: 0,
        closedTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        tp1Hits: 0,
        tp2Hits: 0,
        tp3Hits: 0,
        slHits: 0,
        trailingStopHits: 0,
        grossRealizedProfit: 0,
        grossRealizedLoss: 0,
        commissions: 0,
        fundingFees: 0,
        netRealizedPnl: 0,
      };
      bdEntry.totalTrades++;
      bdEntry.commissions += comm;
      dailyBreakdownMap.set(istCreatedDate, bdEntry);
    }

    if (exec.strategy === 'STANDARD') strategyStats.standard.count++;
    else strategyStats.highRisk.count++;

    if (exec.side === 'LONG') directionStats.long.count++;
    else directionStats.short.count++;
  }

  // Summary Metrics Final Calculations
  const winRate = closedTrades > 0 ? (winningTrades / closedTrades) * 100 : 0;
  const profitFactor = grossRealizedLoss > 0
    ? grossRealizedProfit / grossRealizedLoss
    : grossRealizedProfit > 0
      ? null
      : 0;
  const avgProfitPerTrade = winningTrades > 0 ? grossRealizedProfit / winningTrades : 0;
  const avgLossPerTrade = losingTrades > 0 ? grossRealizedLoss / losingTrades : 0;

  const summaryCards: SummaryCardsData = {
    totalExecutedTrades,
    tradesOpenedInPeriod,
    currentlyOpenTrades,
    closedTrades,
    winningTrades,
    losingTrades,
    breakevenTrades,
    tp1HitCount,
    tp2HitCount,
    tp3HitCount,
    stopLossHitCount,
    trailingStopHitCount,
    manualCloseCount,
    winRate: Number(winRate.toFixed(1)),
    grossRealizedProfit: Number(grossRealizedProfit.toFixed(4)),
    grossRealizedLoss: Number(grossRealizedLoss.toFixed(4)),
    totalCommissions: Number(totalCommissions.toFixed(4)),
    netFundingFees: Number(netFundingFees.toFixed(4)),
    netRealizedPnl: Number(netRealizedPnl.toFixed(4)),
    currentUnrealizedPnl: Number(currentUnrealizedPnl.toFixed(4)),
    profitFactor: profitFactor !== null ? Number(profitFactor.toFixed(2)) : null,
    avgProfitPerTrade: Number(avgProfitPerTrade.toFixed(4)),
    avgLossPerTrade: Number(avgLossPerTrade.toFixed(4)),
  };

  // Build sorted daily PnL series
  const dailyPnl = Array.from(dailyPnlMap.entries())
    .map(([date, d]) => ({
      date,
      netPnl: Number(d.netPnl.toFixed(4)),
      grossProfit: Number(d.grossProfit.toFixed(4)),
      grossLoss: Number(d.grossLoss.toFixed(4)),
      count: d.count,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Build cumulative PnL series
  let runningCumPnl = 0;
  let tIdx = 0;
  const cumulativePnl = dailyPnl.map((d) => {
    runningCumPnl += d.netPnl;
    tIdx += d.count;
    return {
      time: d.date,
      cumulativePnl: Number(runningCumPnl.toFixed(4)),
      tradeIndex: tIdx,
    };
  });

  // Weekly PnL
  const weeklyPnl = dailyPnl.map((d) => ({
    week: d.date,
    netPnl: d.netPnl,
    count: d.count,
  }));

  // Strategy Comparison
  const strategiesChart = {
    standard: {
      count: strategyStats.standard.count,
      netPnl: Number(strategyStats.standard.netPnl.toFixed(4)),
      winRate: strategyStats.standard.closed > 0
        ? Number(((strategyStats.standard.wins / strategyStats.standard.closed) * 100).toFixed(1))
        : 0,
      profitFactor: strategyStats.standard.grossLoss > 0
        ? Number((strategyStats.standard.grossProfit / strategyStats.standard.grossLoss).toFixed(2))
        : null,
    },
    highRisk: {
      count: strategyStats.highRisk.count,
      netPnl: Number(strategyStats.highRisk.netPnl.toFixed(4)),
      winRate: strategyStats.highRisk.closed > 0
        ? Number(((strategyStats.highRisk.wins / strategyStats.highRisk.closed) * 100).toFixed(1))
        : 0,
      profitFactor: strategyStats.highRisk.grossLoss > 0
        ? Number((strategyStats.highRisk.grossProfit / strategyStats.highRisk.grossLoss).toFixed(2))
        : null,
    },
  };

  // Direction Comparison
  const directionsChart = {
    long: {
      count: directionStats.long.count,
      netPnl: Number(directionStats.long.netPnl.toFixed(4)),
      winRate: directionStats.long.closed > 0
        ? Number(((directionStats.long.wins / directionStats.long.closed) * 100).toFixed(1))
        : 0,
    },
    short: {
      count: directionStats.short.count,
      netPnl: Number(directionStats.short.netPnl.toFixed(4)),
      winRate: directionStats.short.closed > 0
        ? Number(((directionStats.short.wins / directionStats.short.closed) * 100).toFixed(1))
        : 0,
    },
  };

  // Symbols list sorted by profitability
  const symbolsChart = Array.from(symbolStatsMap.entries())
    .map(([sym, st]) => ({
      symbol: sym,
      count: st.count,
      netPnl: Number(st.netPnl.toFixed(4)),
      winRate: st.closedCount > 0 ? Number(((st.wins / st.closedCount) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.netPnl - a.netPnl);

  // Customers list sorted by profitability
  const customersChart = Array.from(customerStatsMap.entries())
    .map(([uid, st]) => ({
      userId: uid,
      email: st.email,
      count: st.count,
      netPnl: Number(st.netPnl.toFixed(4)),
      winRate: st.closedCount > 0 ? Number(((st.wins / st.closedCount) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.netPnl - a.netPnl);

  // Daily breakdown sorted descending by date
  const dailyBreakdown = Array.from(dailyBreakdownMap.values())
    .sort((a, b) => b.dateIst.localeCompare(a.dateIst));

  // Sync checkpoint info
  let syncInfo = {
    lastSyncedAt: null as string | null,
    status: 'OK' as 'OK' | 'STALE' | 'ERROR',
    isStale: false,
    staleReason: undefined as string | undefined,
  };
  try {
    const cp = await query<{ value_json: { syncedAt?: string; status?: 'OK' | 'STALE' | 'ERROR'; error?: string } }>(
      `SELECT value_json FROM public.app_settings WHERE key = 'binance_demo_trade_performance_sync'`,
    );
    if (cp.rows[0]?.value_json) {
      const v = cp.rows[0].value_json;
      syncInfo = {
        lastSyncedAt: v.syncedAt ?? null,
        status: v.status ?? 'OK',
        isStale: v.status === 'STALE',
        staleReason: v.error,
      };
    }
  } catch {}

  return {
    filters: params,
    dateRange,
    summary: summaryCards,
    charts: {
      dailyPnl,
      weeklyPnl,
      cumulativePnl,
      winLoss: { winning: winningTrades, losing: losingTrades, breakeven: breakevenTrades },
      milestones: {
        tp1: tp1HitCount,
        tp2: tp2HitCount,
        tp3: tp3HitCount,
        sl: stopLossHitCount,
        trailingStop: trailingStopHitCount,
        manual: manualCloseCount,
      },
      strategies: strategiesChart,
      directions: directionsChart,
      symbols: symbolsChart,
      customers: customersChart,
    },
    dailyBreakdown,
    activePositions: activePositionsList,
    syncInfo,
  };
}

/**
 * Returns paginated execution history with full lifecycle details for the admin table and drawer.
 */
export async function getDetailedExecutionHistory(
  params: PerformanceFilterParams & {
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortOrder?: 'ASC' | 'DESC';
    search?: string;
  } = {},
) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(params.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const sortOrder = params.sortOrder === 'ASC' ? 'ASC' : 'DESC';

  const dateFilter = params.dateFilter || 'ALL_TIME';
  const dateRange = computeIstDateRange(dateFilter, params.customFrom, params.customTo, params.specificDate);
  const periodMode = params.periodMode || 'both';

  const conditions: string[] = [
    `te.exchange = 'BINANCE'`,
    `te.environment = 'DEMO'`,
    `te.execution_status IN ('ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED', 'CLOSED')`,
  ];
  const queryParams: (string | number | boolean | null)[] = [];
  let paramIdx = 1;

  if (params.search && params.search.trim()) {
    conditions.push(
      `(te.symbol ILIKE $${paramIdx} OR te.binance_order_id ILIKE $${paramIdx} OR te.client_order_id ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx})`,
    );
    queryParams.push(`%${params.search.trim()}%`);
    paramIdx++;
  }

  if (params.customerId && params.customerId !== 'ALL') {
    conditions.push(`te.user_id = $${paramIdx++}`);
    queryParams.push(Number(params.customerId));
  }

  if (params.strategy && params.strategy !== 'ALL') {
    conditions.push(`te.strategy = $${paramIdx++}`);
    queryParams.push(params.strategy);
  }

  if (params.symbol && params.symbol !== 'ALL') {
    conditions.push(`te.symbol = $${paramIdx++}`);
    queryParams.push(params.symbol.trim().toUpperCase());
  }

  if (params.direction && params.direction !== 'ALL') {
    conditions.push(`te.side = $${paramIdx++}`);
    queryParams.push(params.direction);
  }

  if (params.status && params.status !== 'ALL') {
    if (params.status === 'OPEN') {
      conditions.push(`te.execution_status IN ('ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED')`);
    } else if (params.status === 'CLOSED') {
      conditions.push(`te.execution_status = 'CLOSED'`);
    }
  }

  if (dateRange.startUtc && dateRange.endUtc) {
    if (periodMode === 'opened') {
      conditions.push(`te.created_at >= $${paramIdx++}::TIMESTAMPTZ AND te.created_at <= $${paramIdx++}::TIMESTAMPTZ`);
      queryParams.push(dateRange.startUtc, dateRange.endUtc);
    } else if (periodMode === 'closed') {
      conditions.push(`te.closed_at IS NOT NULL AND te.closed_at >= $${paramIdx++}::TIMESTAMPTZ AND te.closed_at <= $${paramIdx++}::TIMESTAMPTZ`);
      queryParams.push(dateRange.startUtc, dateRange.endUtc);
    } else {
      conditions.push(
        `((te.created_at >= $${paramIdx}::TIMESTAMPTZ AND te.created_at <= $${paramIdx + 1}::TIMESTAMPTZ) OR (te.closed_at IS NOT NULL AND te.closed_at >= $${paramIdx}::TIMESTAMPTZ AND te.closed_at <= $${paramIdx + 1}::TIMESTAMPTZ))`,
      );
      queryParams.push(dateRange.startUtc, dateRange.endUtc);
      paramIdx += 2;
    }
  }

  const whereClause = conditions.join(' AND ');

  // Count total matching items
  const countRes = await query<{ count: string }>(
    `SELECT COUNT(*)::text as count
       FROM public.trade_executions te
       LEFT JOIN public.users u ON u.id = te.user_id
      WHERE ${whereClause}`,
    queryParams,
  );
  const totalItems = Number(countRes.rows[0]?.count ?? 0);

  // Determine sort column safely
  let sortCol = 'te.created_at';
  if (params.sortBy === 'symbol') sortCol = 'te.symbol';
  else if (params.sortBy === 'pnl') sortCol = 'COALESCE(te.net_realized_pnl, te.realized_pnl, 0)';
  else if (params.sortBy === 'closed_at') sortCol = 'te.closed_at';
  else if (params.sortBy === 'fill_price') sortCol = 'te.actual_fill_price';

  const selectSql = `
    SELECT te.id::TEXT, te.user_id, u.email, te.symbol, te.side, te.strategy, te.execution_status,
           te.quantity::TEXT, te.notional_usdt::TEXT, te.leverage,
           te.entry_price::TEXT, te.actual_fill_price::TEXT, te.exit_fill_price::TEXT,
           te.stop_loss::TEXT, te.take_profit::TEXT, te.tp1_price::TEXT, te.tp2_price::TEXT, te.tp3_price::TEXT,
           te.tp1_reached_at::TEXT, te.tp2_reached_at::TEXT, te.tp3_reached_at::TEXT,
           te.realized_pnl::TEXT, te.commission_usdt::TEXT, te.funding_fee_usdt::TEXT, te.net_realized_pnl::TEXT,
           te.exit_reason, te.binance_order_id, te.client_order_id,
           te.sl_order_id, te.tp_order_id, te.trailing_order_id, te.exit_order_id,
           te.sl_client_algo_id, te.tp_client_algo_id, te.trailing_client_algo_id, te.exit_client_order_id,
           te.reconciliation_status, te.created_at::TEXT, te.closed_at::TEXT, te.last_reconciled_at::TEXT,
           te.error_message
      FROM public.trade_executions te
      LEFT JOIN public.users u ON u.id = te.user_id
     WHERE ${whereClause}
     ORDER BY ${sortCol} ${sortOrder}
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `;

  queryParams.push(pageSize, offset);

  const itemsRes = await query<{
    id: string;
    user_id: number;
    email: string | null;
    symbol: string;
    side: 'LONG' | 'SHORT';
    strategy: 'STANDARD' | 'HIGH_RISK_SCALPING';
    execution_status: string;
    quantity: string;
    notional_usdt: string;
    leverage: number;
    entry_price: string;
    actual_fill_price: string | null;
    exit_fill_price: string | null;
    stop_loss: string;
    take_profit: string;
    tp1_price: string | null;
    tp2_price: string | null;
    tp3_price: string | null;
    tp1_reached_at: string | null;
    tp2_reached_at: string | null;
    tp3_reached_at: string | null;
    realized_pnl: string | null;
    commission_usdt: string | null;
    funding_fee_usdt: string | null;
    net_realized_pnl: string | null;
    exit_reason: string | null;
    binance_order_id: string | null;
    client_order_id: string;
    sl_order_id: string | null;
    tp_order_id: string | null;
    trailing_order_id: string | null;
    exit_order_id: string | null;
    sl_client_algo_id: string | null;
    tp_client_algo_id: string | null;
    trailing_client_algo_id: string | null;
    exit_client_order_id: string | null;
    reconciliation_status: string | null;
    created_at: string;
    closed_at: string | null;
    last_reconciled_at: string | null;
    error_message: string | null;
  }>(selectSql, queryParams);

  return {
    items: itemsRes.rows.map((row) => {
      const realPnl = Number(row.realized_pnl ?? 0);
      const comm = Number(row.commission_usdt ?? 0);
      const fund = Number(row.funding_fee_usdt ?? 0);
      const netPnl = row.net_realized_pnl !== null ? Number(row.net_realized_pnl) : (realPnl - comm + fund);
      const isOpen = ['ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED'].includes(row.execution_status);

      return {
        id: row.id,
        userId: row.user_id,
        email: row.email ?? `User #${row.user_id}`,
        symbol: row.symbol,
        side: row.side,
        strategy: row.strategy,
        executionStatus: row.execution_status,
        quantity: Number(row.quantity),
        remainingQuantity: isOpen ? Number(row.quantity) : 0,
        notionalUsdt: Number(row.notional_usdt),
        leverage: row.leverage,
        entryPrice: Number(row.actual_fill_price || row.entry_price),
        actualFillPrice: row.actual_fill_price ? Number(row.actual_fill_price) : null,
        exitFillPrice: row.exit_fill_price ? Number(row.exit_fill_price) : null,
        stopLossPrice: Number(row.stop_loss),
        tp1Price: row.tp1_price ? Number(row.tp1_price) : null,
        tp2Price: row.tp2_price ? Number(row.tp2_price) : null,
        tp3Price: row.tp3_price ? Number(row.tp3_price) : null,
        tp1Reached: Boolean(row.tp1_reached_at),
        tp2Reached: Boolean(row.tp2_reached_at),
        tp3Reached: Boolean(row.tp3_reached_at),
        tp1ReachedAt: row.tp1_reached_at,
        tp2ReachedAt: row.tp2_reached_at,
        tp3ReachedAt: row.tp3_reached_at,
        stopLossStatus: row.exit_reason === 'STOP_LOSS' ? 'TRIGGERED' : (isOpen ? 'ACTIVE' : 'INACTIVE'),
        trailingStopStatus: row.exit_reason === 'TRAILING_STOP' ? 'TRIGGERED' : (isOpen ? 'ACTIVE' : 'INACTIVE'),
        grossRealizedPnl: isNaN(realPnl) ? 0 : realPnl,
        commission: isNaN(comm) ? 0 : comm,
        fundingFees: isNaN(fund) ? 0 : fund,
        netRealizedPnl: isNaN(netPnl) ? 0 : netPnl,
        unrealizedPnl: isOpen ? 0 : null,
        exitReason: row.exit_reason ?? (row.execution_status === 'CLOSED' ? 'CLOSED' : null),
        createdAt: row.created_at,
        closedAt: row.closed_at,
        lastReconciledAt: row.last_reconciled_at,
        binanceOrderId: row.binance_order_id,
        clientOrderId: row.client_order_id,
        slOrderId: row.sl_order_id,
        tpOrderId: row.tp_order_id,
        trailingOrderId: row.trailing_order_id,
        exitOrderId: row.exit_order_id,
        slClientAlgoId: row.sl_client_algo_id,
        tpClientAlgoId: row.tp_client_algo_id,
        trailingClientAlgoId: row.trailing_client_algo_id,
        exitClientOrderId: row.exit_client_order_id,
        reconciliationStatus: row.reconciliation_status ?? 'PENDING',
        errorMessage: row.error_message,
      };
    }),
    total: totalItems,
    page,
    pageSize,
    totalPages: Math.ceil(totalItems / pageSize),
  };
}
