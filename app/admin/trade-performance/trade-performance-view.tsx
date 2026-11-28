'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';

interface SummaryCardsData {
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
  winRate: number;
  grossRealizedProfit: number;
  grossRealizedLoss: number;
  totalCommissions: number;
  netFundingFees: number;
  netRealizedPnl: number;
  currentUnrealizedPnl: number;
  profitFactor: number | null;
  avgProfitPerTrade: number;
  avgLossPerTrade: number;
}

interface DailyBreakdownRow {
  dateIst: string;
  totalExecuted: number;
  tradesOpened: number;
  tradesClosed: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  tp1Hits: number;
  tp2Hits: number;
  tp3Hits: number;
  slHits: number;
  trailingHits: number;
  grossProfit: number;
  grossLoss: number;
  totalCommissions: number;
  netFundingFees: number;
  netRealizedPnl: number;
  winRate: number;
}

interface StrategyStats {
  strategy: string;
  totalTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  netRealizedPnl: number;
  grossProfit: number;
  grossLoss: number;
  totalCommissions: number;
  fundingFees: number;
}

interface DirectionStats {
  direction: string;
  totalTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  netRealizedPnl: number;
}

interface SymbolProfitability {
  symbol: string;
  totalTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  netRealizedPnl: number;
  grossProfit: number;
  grossLoss: number;
  totalCommissions: number;
}

interface CustomerPerformance {
  userId: number;
  userEmail: string;
  totalTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  netRealizedPnl: number;
  grossProfit: number;
  grossLoss: number;
  totalCommissions: number;
  fundingFees: number;
}

interface AnalyticsResult {
  filterRange: {
    startUtc: string | null;
    endUtc: string | null;
    label: string;
  };
  summary: SummaryCardsData;
  dailySeries: Array<{ dateIst: string; netRealizedPnl: number; cumulativePnl: number }>;
  weeklySeries: Array<{ weekLabel: string; netRealizedPnl: number; tradeCount: number }>;
  strategyComparison: {
    standard: StrategyStats;
    highRisk: StrategyStats;
  };
  directionComparison: {
    long: DirectionStats;
    short: DirectionStats;
  };
  symbolRanking: SymbolProfitability[];
  customerPerformance: CustomerPerformance[];
  dailyBreakdown: DailyBreakdownRow[];
  totalAvailableClosed: number;
  totalAvailableOpen: number;
}

interface ExecutionRecord {
  id: string | number;
  userId: number;
  userEmail: string;
  symbol: string;
  strategy: string;
  direction: string;
  status: string;
  exitReason: string;
  createdAt: string;
  closedAt: string | null;
  entryFillPrice: number;
  exitFillPrice: number | null;
  executedQty: number;
  remainingQty: number;
  leverage: number;
  tp1ReachedAt: string | null;
  tp2ReachedAt: string | null;
  tp3ReachedAt: string | null;
  stopLossHitAt: string | null;
  trailingStopHitAt: string | null;
  grossRealizedPnl: number;
  commissionUsdt: number;
  fundingFeeUsdt: number;
  netRealizedPnl: number;
  unrealizedPnl: number;
  binanceOrderId: string | null;
  reconciliationStatus: string;
  metadata?: Record<string, unknown>;
}

interface UnmatchedTrade {
  id: string;
  userId: number;
  symbol: string;
  orderId: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  time: string;
}

interface SyncCheckpoint {
  lastSyncAt: string | null;
  reconciledCount: number;
  openPositionsCount: number;
  unmatchedCount: number;
  isStale: boolean;
  staleReason?: string;
  lastError?: string;
}

type PresetType =
  | 'TODAY'
  | 'YESTERDAY'
  | 'LAST_7_DAYS'
  | 'THIS_WEEK'
  | 'LAST_WEEK'
  | 'THIS_MONTH'
  | 'CUSTOM'
  | 'INDIVIDUAL_DATE'
  | 'ALL_TIME';

export function TradePerformanceView({ adminEmail }: { adminEmail: string }) {
  // Filters State
  const [dateFilter, setDateFilter] = useState<PresetType>('ALL_TIME');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [specificDate, setSpecificDate] = useState('');
  const [periodMode, setPeriodMode] = useState<'opened' | 'closed'>('opened');
  const [customerId, setCustomerId] = useState('ALL');
  const [strategy, setStrategy] = useState<'ALL' | 'STANDARD' | 'HIGH_RISK_SCALPING'>('ALL');
  const [symbol, setSymbol] = useState('ALL');
  const [direction, setDirection] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [status, setStatus] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');

  // Execution History Table state
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState('created_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Data State
  const [analytics, setAnalytics] = useState<AnalyticsResult | null>(null);
  const [syncCheckpoint, setSyncCheckpoint] = useState<SyncCheckpoint | null>(null);
  const [unmatchedTrades, setUnmatchedTrades] = useState<UnmatchedTrade[]>([]);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [executionsTotal, setExecutionsTotal] = useState(0);

  // UI state
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedExecution, setSelectedExecution] = useState<ExecutionRecord | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'breakdown' | 'executions' | 'unmatched'>('overview');
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);

  // Format currency helpers
  const fmtUsdt = (val: number | null | undefined, includeSign = false) => {
    if (val === null || val === undefined) return '—';
    const prefix = includeSign && val > 0 ? '+' : '';
    return `${prefix}$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const fmtPercent = (val: number | null | undefined) => {
    if (val === null || val === undefined) return '—';
    return `${val.toFixed(1)}%`;
  };

  const fmtDate = (isoStr: string | null | undefined) => {
    if (!isoStr) return '—';
    try {
      const d = new Date(isoStr);
      return d.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }) + ' IST';
    } catch {
      return isoStr;
    }
  };

  // Build Query String for API
  const buildQueryParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set('dateFilter', dateFilter);
    if (dateFilter === 'CUSTOM' && customFrom && customTo) {
      params.set('customFrom', customFrom);
      params.set('customTo', customTo);
    }
    if (dateFilter === 'INDIVIDUAL_DATE' && specificDate) {
      params.set('specificDate', specificDate);
    }
    params.set('periodMode', periodMode);
    if (customerId !== 'ALL') params.set('customerId', customerId);
    if (strategy !== 'ALL') params.set('strategy', strategy);
    if (symbol !== 'ALL') params.set('symbol', symbol);
    if (direction !== 'ALL') params.set('direction', direction);
    if (status !== 'ALL') params.set('status', status);
    return params;
  }, [dateFilter, customFrom, customTo, specificDate, periodMode, customerId, strategy, symbol, direction, status]);

  // Trigger on-demand reconciliation
  const handleReconcile = async (fullBackfill = false) => {
    setReconciling(true);
    try {
      const csrfToken = document.cookie
        .split('; ')
        .find((row) => row.startsWith('csrf='))
        ?.split('=')[1] || '';

      const res = await fetch('/api/admin/trade-performance/reconcile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ fullBackfill }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: Reconciliation failed`);
      }

      // Refresh after sync
      setRefreshIndex((k) => k + 1);
    } catch (err) {
      alert(`Reconciliation notice: ${err instanceof Error ? err.message : 'Sync failed'}`);
    } finally {
      setReconciling(false);
    }
  };

  // CSV Export Trigger
  const handleExport = (reportType: string) => {
    const params = buildQueryParams();
    params.set('reportType', reportType);
    if (search.trim()) params.set('search', search.trim());
    const a = document.createElement('a');
    a.href = `/api/admin/trade-performance/export?${params.toString()}`;
    a.setAttribute('download', '');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setExportDropdownOpen(false);
  };

  // Initial and reactive data loads via refreshIndex and filter dependencies
  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const params = buildQueryParams();
        const res = await fetch(`/api/admin/trade-performance/summary?${params.toString()}`, {
          cache: 'no-store',
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}: Failed to load summary data`);
        }

        const json = await res.json();
        if (active && json.data && json.data.analytics) {
          const raw = json.data.analytics;
          const cumulativeMap = new Map<string, number>();
          for (const item of (raw.charts?.cumulativePnl || [])) {
            cumulativeMap.set(item.time.slice(0, 10), item.cumulativePnl);
          }

          const transformed: AnalyticsResult = {
            filterRange: raw.dateRange || { startUtc: null, endUtc: null, label: 'All Available Demo Executions' },
            summary: raw.summary,
            dailySeries: (raw.charts?.dailyPnl || []).map((d: { date: string; netPnl: number; count: number }) => ({
              dateIst: d.date,
              netRealizedPnl: d.netPnl,
              cumulativePnl: cumulativeMap.get(d.date) ?? d.netPnl,
            })),
            weeklySeries: (raw.charts?.weeklyPnl || []).map((w: { week: string; netPnl: number; count: number }) => ({
              weekLabel: w.week,
              netRealizedPnl: w.netPnl,
              tradeCount: w.count,
            })),
            strategyComparison: {
              standard: {
                strategy: 'STANDARD',
                totalTrades: raw.charts?.strategies?.standard?.count || 0,
                closedTrades: raw.charts?.strategies?.standard?.count || 0,
                winningTrades: 0,
                losingTrades: 0,
                winRate: raw.charts?.strategies?.standard?.winRate || 0,
                netRealizedPnl: raw.charts?.strategies?.standard?.netPnl || 0,
                grossProfit: 0,
                grossLoss: 0,
                totalCommissions: 0,
                fundingFees: 0,
              },
              highRisk: {
                strategy: 'HIGH_RISK_SCALPING',
                totalTrades: raw.charts?.strategies?.highRisk?.count || 0,
                closedTrades: raw.charts?.strategies?.highRisk?.count || 0,
                winningTrades: 0,
                losingTrades: 0,
                winRate: raw.charts?.strategies?.highRisk?.winRate || 0,
                netRealizedPnl: raw.charts?.strategies?.highRisk?.netPnl || 0,
                grossProfit: 0,
                grossLoss: 0,
                totalCommissions: 0,
                fundingFees: 0,
              },
            },
            directionComparison: {
              long: {
                direction: 'LONG',
                totalTrades: raw.charts?.directions?.long?.count || 0,
                closedTrades: raw.charts?.directions?.long?.count || 0,
                winningTrades: 0,
                losingTrades: 0,
                winRate: raw.charts?.directions?.long?.winRate || 0,
                netRealizedPnl: raw.charts?.directions?.long?.netPnl || 0,
              },
              short: {
                direction: 'SHORT',
                totalTrades: raw.charts?.directions?.short?.count || 0,
                closedTrades: raw.charts?.directions?.short?.count || 0,
                winningTrades: 0,
                losingTrades: 0,
                winRate: raw.charts?.directions?.short?.winRate || 0,
                netRealizedPnl: raw.charts?.directions?.short?.netPnl || 0,
              },
            },
            symbolRanking: (raw.charts?.symbols || []).map((s: { symbol: string; count: number; winRate: number; netPnl: number }) => ({
              symbol: s.symbol,
              totalTrades: s.count,
              closedTrades: s.count,
              winningTrades: 0,
              losingTrades: 0,
              winRate: s.winRate,
              netRealizedPnl: s.netPnl,
              grossProfit: 0,
              grossLoss: 0,
              totalCommissions: 0,
            })),
            customerPerformance: (raw.charts?.customers || []).map((c: { userId: number; email: string; count: number; winRate: number; netPnl: number }) => ({
              userId: c.userId,
              userEmail: c.email,
              totalTrades: c.count,
              closedTrades: c.count,
              winningTrades: 0,
              losingTrades: 0,
              winRate: c.winRate,
              netRealizedPnl: c.netPnl,
              grossProfit: 0,
              grossLoss: 0,
              totalCommissions: 0,
              fundingFees: 0,
            })),
            dailyBreakdown: (raw.dailyBreakdown || []).map((d: {
              dateIst: string;
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
            }) => ({
              dateIst: d.dateIst,
              totalExecuted: d.totalTrades,
              tradesOpened: d.totalTrades,
              tradesClosed: d.closedTrades,
              winningTrades: d.winningTrades,
              losingTrades: d.losingTrades,
              breakevenTrades: 0,
              tp1Hits: d.tp1Hits,
              tp2Hits: d.tp2Hits,
              tp3Hits: d.tp3Hits,
              slHits: d.slHits,
              trailingHits: d.trailingStopHits,
              grossProfit: d.grossRealizedProfit,
              grossLoss: d.grossRealizedLoss,
              totalCommissions: d.commissions,
              netFundingFees: d.fundingFees,
              netRealizedPnl: d.netRealizedPnl,
              winRate: d.closedTrades > 0 ? (d.winningTrades / d.closedTrades) * 100 : 0,
            })),
            totalAvailableClosed: raw.summary?.closedTrades || 0,
            totalAvailableOpen: raw.summary?.currentlyOpenTrades || 0,
          };

          setAnalytics(transformed);
          setSyncCheckpoint(json.data.syncCheckpoint);
          setUnmatchedTrades(json.data.unmatchedTrades || []);
          setLoading(false);
          setRefreshing(false);
        }
      } catch (err) {
        if (active) {
          console.error('Summary fetch error:', err);
          setError(err instanceof Error ? err.message : 'Failed to fetch trade analytics.');
          setLoading(false);
          setRefreshing(false);
        }
      }
    };
    void run();
    return () => { active = false; };
  }, [buildQueryParams, refreshIndex]);

  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const params = buildQueryParams();
        params.set('page', String(page));
        params.set('pageSize', String(pageSize));
        if (search.trim()) params.set('search', search.trim());
        params.set('sortField', sortField);
        params.set('sortOrder', sortOrder);

        const res = await fetch(`/api/admin/trade-performance/executions?${params.toString()}`, {
          cache: 'no-store',
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}: Failed to load executions`);
        }

        const json = await res.json();
        if (active && json.data) {
          setExecutions(json.data.executions || []);
          setExecutionsTotal(json.data.total || 0);
        }
      } catch (err) {
        if (active) console.error('Executions fetch error:', err);
      }
    };
    void run();
    return () => { active = false; };
  }, [buildQueryParams, page, pageSize, search, sortField, sortOrder, refreshIndex]);

  // 60-second automatic polling for live reporting
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        setRefreshIndex((k) => k + 1);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Summary Metrics shortcut
  const s = analytics?.summary;

  // Stale status check
  const isStale = useMemo(() => {
    return syncCheckpoint?.isStale === true;
  }, [syncCheckpoint]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Hero Section */}
      <section className="hero" style={{ paddingBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <span className="table-badge table-badge-ready" style={{ fontSize: 11, letterSpacing: '0.05em' }}>
                ADMIN-ONLY REPORTING
              </span>
              <span className="table-badge" style={{ background: '#3b82f620', border: '1px solid #3b82f6', color: '#60a5fa', fontSize: 11 }}>
                BINANCE USDⓈ-M FUTURES DEMO
              </span>
              <span className="table-badge table-badge-diag-error" style={{ fontSize: 11 }}>
                REAL LIVE TRADING: STRICTLY DISABLED
              </span>
            </div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700 }}>Trade Performance & Exchange Reconciliation</h1>
            <p className="muted" style={{ margin: '6px 0 0', maxWidth: 840, fontSize: 13 }}>
              Audit-grade trading performance reporting for genuine Binance USDⓈ-M Demo executions. Reconciles exchange fills,
              realized P&L, trading fees, and funding income. Calendar boundaries computed strictly in <strong>Asia/Kolkata (IST = UTC+5:30)</strong>.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="button-secondary"
              onClick={() => handleExport('daily')}
              style={{ fontSize: 12, padding: '8px 14px' }}
            >
              📊 Export CSV
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => void handleReconcile(false)}
              disabled={reconciling || refreshing}
              style={{ fontSize: 12, padding: '8px 14px' }}
            >
              {reconciling ? 'Syncing Binance…' : '⚡ Reconcile Exchange'}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setRefreshing(true);
                setRefreshIndex((k) => k + 1);
              }}
              disabled={refreshing || reconciling}
              style={{ fontSize: 12, padding: '8px 14px' }}
            >
              {refreshing ? 'Refreshing…' : '🔄 Refresh Report'}
            </button>
          </div>
        </div>

        {/* Sync & Stale Banner */}
        <div style={{
          marginTop: 14,
          padding: '10px 14px',
          borderRadius: 8,
          background: isStale ? 'rgba(239, 68, 68, 0.1)' : 'var(--surface-raised)',
          border: `1px solid ${isStale ? 'rgba(239, 68, 68, 0.3)' : 'var(--surface-border)'}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          fontSize: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: isStale ? '#ef4444' : '#10b981',
              display: 'inline-block',
            }} />
            <span>
              {isStale ? (
                <strong style={{ color: '#ef4444' }}>Stale Data Warning: </strong>
              ) : (
                <strong style={{ color: 'var(--text-success)' }}>Exchange Sync Active: </strong>
              )}
              {syncCheckpoint?.lastSyncAt
                ? `Last synchronized with Binance Demo at ${fmtDate(syncCheckpoint.lastSyncAt)}`
                : 'Initial sync pending…'}
            </span>
            {syncCheckpoint?.reconciledCount !== undefined && (
              <span className="mono" style={{ color: 'var(--text-muted)' }}>
                ({syncCheckpoint.reconciledCount} executions reconciled · {syncCheckpoint.openPositionsCount} positions open)
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--text-muted)' }}>Auto-refreshes every 60s</span>
            <span style={{ color: 'var(--surface-border)' }}>|</span>
            <span style={{ color: 'var(--text-muted)' }}>Supervisor: {adminEmail}</span>
          </div>
        </div>
      </section>

      {/* Filter Toolbar */}
      <section className="card" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Row 1: Date Filter Presets */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 4 }}>PERIOD:</span>
            {[
              { id: 'TODAY', label: 'Today' },
              { id: 'YESTERDAY', label: 'Yesterday' },
              { id: 'LAST_7_DAYS', label: 'Last 7 Days' },
              { id: 'THIS_WEEK', label: 'This Week' },
              { id: 'LAST_WEEK', label: 'Last Week' },
              { id: 'THIS_MONTH', label: 'This Month' },
              { id: 'ALL_TIME', label: 'All Time' },
              { id: 'CUSTOM', label: 'Custom Range' },
              { id: 'INDIVIDUAL_DATE', label: 'Single Date' },
            ].map((p) => (
              <button
                key={p.id}
                type="button"
                className={dateFilter === p.id ? 'button' : 'button-secondary'}
                onClick={() => setDateFilter(p.id as PresetType)}
                style={{
                  padding: '5px 11px',
                  fontSize: 12,
                  fontWeight: dateFilter === p.id ? 700 : 500,
                  borderRadius: 6,
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Period Mode Selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>ACCOUNTING:</span>
            <select
              value={periodMode}
              onChange={(e) => setPeriodMode(e.target.value as 'opened' | 'closed')}
              style={{
                padding: '5px 10px',
                fontSize: 12,
                borderRadius: 6,
                background: 'var(--surface-raised)',
                border: '1px solid var(--surface-border)',
                color: 'var(--text-primary)',
              }}
            >
              <option value="opened">Trades Opened During Period</option>
              <option value="closed">Trades Closed During Period</option>
            </select>
          </div>
        </div>

        {/* Row 2: Custom / Single Date Pickers (Conditional) */}
        {dateFilter === 'CUSTOM' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface-raised)', padding: 10, borderRadius: 8 }}>
            <span className="mono" style={{ fontSize: 12 }}>IST Date Range:</span>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              From:
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                style={{
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--surface-border)',
                  background: 'var(--surface)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                }}
              />
            </label>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              To:
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                style={{
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--surface-border)',
                  background: 'var(--surface)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                }}
              />
            </label>
            <button
              type="button"
              className="button"
              onClick={() => setRefreshIndex((k) => k + 1)}
              style={{ padding: '4px 12px', fontSize: 12 }}
            >
              Apply Custom Range
            </button>
          </div>
        )}

        {dateFilter === 'INDIVIDUAL_DATE' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface-raised)', padding: 10, borderRadius: 8 }}>
            <span className="mono" style={{ fontSize: 12 }}>Individual Date (IST):</span>
            <input
              type="date"
              value={specificDate}
              onChange={(e) => setSpecificDate(e.target.value)}
              style={{
                padding: '4px 8px',
                borderRadius: 6,
                border: '1px solid var(--surface-border)',
                background: 'var(--surface)',
                color: 'var(--text-primary)',
                fontSize: 12,
              }}
            />
            <button
              type="button"
              className="button"
              onClick={() => setRefreshIndex((k) => k + 1)}
              style={{ padding: '4px 12px', fontSize: 12 }}
            >
              Apply Date
            </button>
          </div>
        )}

        {/* Row 3: Dimension Dropdown Filters & CSV Export Dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingTop: 4, borderTop: '1px solid var(--surface-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>STRATEGY:</span>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as 'ALL' | 'STANDARD' | 'HIGH_RISK_SCALPING')}
              style={{ padding: '4px 8px', fontSize: 12, borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)' }}
            >
              <option value="ALL">All Strategies</option>
              <option value="STANDARD">Standard Strategy</option>
              <option value="HIGH_RISK_SCALPING">High-Risk Scalping</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>SYMBOL:</span>
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              style={{ padding: '4px 8px', fontSize: 12, borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)' }}
            >
              <option value="ALL">All Symbols</option>
              {analytics?.symbolRanking.map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.symbol}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>SIDE:</span>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'ALL' | 'LONG' | 'SHORT')}
              style={{ padding: '4px 8px', fontSize: 12, borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)' }}
            >
              <option value="ALL">All Sides</option>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>STATUS:</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as 'ALL' | 'OPEN' | 'CLOSED')}
              style={{ padding: '4px 8px', fontSize: 12, borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)' }}
            >
              <option value="ALL">All Statuses</option>
              <option value="OPEN">Open Only</option>
              <option value="CLOSED">Closed Only</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>CUSTOMER:</span>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              style={{ padding: '4px 8px', fontSize: 12, borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)' }}
            >
              <option value="ALL">All Customers</option>
              {analytics?.customerPerformance.map((c) => (
                <option key={c.userId} value={String(c.userId)}>
                  {c.userEmail} (ID: {c.userId})
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginLeft: 'auto', position: 'relative' }}>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setExportDropdownOpen((prev) => !prev)}
              style={{ fontSize: 12, padding: '5px 12px' }}
            >
              📥 Download Report ▾
            </button>
            {exportDropdownOpen && (
              <div style={{
                position: 'absolute',
                right: 0,
                top: '100%',
                marginTop: 4,
                background: 'var(--surface)',
                border: '1px solid var(--surface-border)',
                borderRadius: 8,
                boxShadow: 'var(--card-shadow-hover)',
                zIndex: 100,
                minWidth: 190,
                padding: '6px 0',
              }}>
                {[
                  { id: 'daily', label: 'Daily Trade Report' },
                  { id: 'weekly', label: 'Weekly Summary Report' },
                  { id: 'custom', label: 'Date Range Report' },
                  { id: 'executions', label: 'Detailed Execution Ledger' },
                  { id: 'customer', label: 'Customer-wise Breakdown' },
                  { id: 'strategy', label: 'Strategy-wise Breakdown' },
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleExport(item.id)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 14px',
                      background: 'none',
                      border: 'none',
                      fontSize: 12,
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                      display: 'block',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-raised)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Error Notice */}
      {error && (
        <div className="card" style={{ borderLeft: '4px solid #ef4444', padding: '14px 18px', background: 'rgba(239, 68, 68, 0.08)' }}>
          <strong style={{ color: '#ef4444' }}>Reporting System Notice: </strong>
          <span>{error}</span>
        </div>
      )}

      {/* 23 Dashboard Summary Cards */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Executive Performance Scorecard (23 Key Metrics)</h2>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Filtered Window: {analytics?.filterRange.label || 'All Available Demo Executions'}
          </span>
        </div>

        {/* 4 Groups of Summary Cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Group 1: Financial Bottom Line & PnL */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
          }}>
            {/* Card 1: Net Realized PnL */}
            <div className="card" style={{
              padding: '16px 18px',
              border: `1px solid ${(s?.netRealizedPnl ?? 0) >= 0 ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
              background: (s?.netRealizedPnl ?? 0) >= 0 ? 'rgba(16, 185, 129, 0.04)' : 'rgba(239, 68, 68, 0.04)',
            }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>1. NET REALIZED P&L</span>
              <div style={{
                fontSize: 22,
                fontWeight: 700,
                marginTop: 6,
                color: (s?.netRealizedPnl ?? 0) >= 0 ? 'var(--text-success)' : 'var(--text-danger)',
              }}>
                {loading ? '…' : fmtUsdt(s?.netRealizedPnl, true)}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Gross PnL − Fees + Funding</small>
            </div>

            {/* Card 2: Gross Realized Profit */}
            <div className="card" style={{ padding: '16px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>2. GROSS PROFIT</span>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, color: 'var(--text-success)' }}>
                {loading ? '…' : fmtUsdt(s?.grossRealizedProfit)}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Exchange fills</small>
            </div>

            {/* Card 3: Gross Realized Loss */}
            <div className="card" style={{ padding: '16px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>3. GROSS LOSS</span>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, color: 'var(--text-danger)' }}>
                {loading ? '…' : fmtUsdt(s?.grossRealizedLoss ? -s.grossRealizedLoss : 0)}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Exchange fills</small>
            </div>

            {/* Card 4: Total Trading Commissions */}
            <div className="card" style={{ padding: '16px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>4. COMMISSIONS</span>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, color: 'var(--text-warning)' }}>
                {loading ? '…' : fmtUsdt(s?.totalCommissions)}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Entry + exit taker/maker</small>
            </div>

            {/* Card 5: Net Funding Fees */}
            <div className="card" style={{ padding: '16px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>5. NET FUNDING FEES</span>
              <div style={{
                fontSize: 18,
                fontWeight: 700,
                marginTop: 6,
                color: (s?.netFundingFees ?? 0) >= 0 ? 'var(--text-success)' : 'var(--text-warning)',
              }}>
                {loading ? '…' : fmtUsdt(s?.netFundingFees, true)}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Signed 8h funding income</small>
            </div>

            {/* Card 6: Current Unrealized PnL */}
            <div className="card" style={{ padding: '16px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>6. UNREALIZED P&L</span>
              <div style={{
                fontSize: 18,
                fontWeight: 700,
                marginTop: 6,
                color: (s?.currentUnrealizedPnl ?? 0) >= 0 ? 'var(--text-success)' : 'var(--text-danger)',
              }}>
                {loading ? '…' : fmtUsdt(s?.currentUnrealizedPnl, true)}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>{s?.currentlyOpenTrades ?? 0} active positions</small>
            </div>
          </div>

          {/* Group 2: Volume, Win Rate & Profit Factor */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
          }}>
            {/* Card 7: Total Executed Trades */}
            <div className="card" style={{ padding: '14px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>7. TOTAL EXECUTED</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                {loading ? '…' : s?.totalExecutedTrades ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Logical trades</small>
            </div>

            {/* Card 8: Opened in Period */}
            <div className="card" style={{ padding: '14px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>8. OPENED IN PERIOD</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                {loading ? '…' : s?.tradesOpenedInPeriod ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>IST start boundary</small>
            </div>

            {/* Card 9: Currently Open */}
            <div className="card" style={{ padding: '14px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>9. CURRENTLY OPEN</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: '#3b82f6' }}>
                {loading ? '…' : s?.currentlyOpenTrades ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Active in market</small>
            </div>

            {/* Card 10: Closed Trades */}
            <div className="card" style={{ padding: '14px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>10. CLOSED TRADES</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                {loading ? '…' : s?.closedTrades ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Fully exited</small>
            </div>

            {/* Card 11: Win Rate */}
            <div className="card" style={{ padding: '14px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>11. WIN RATE</span>
              <div style={{
                fontSize: 20,
                fontWeight: 700,
                marginTop: 4,
                color: (s?.winRate ?? 0) >= 50 ? 'var(--text-success)' : 'var(--text-warning)',
              }}>
                {loading ? '…' : fmtPercent(s?.winRate)}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>From Net Realized PnL</small>
            </div>

            {/* Card 12: Profit Factor */}
            <div className="card" style={{ padding: '14px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>12. PROFIT FACTOR</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                {loading ? '…' : s?.profitFactor !== null && s?.profitFactor !== undefined ? s.profitFactor.toFixed(2) : '∞'}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Gross Profit / Gross Loss</small>
            </div>
          </div>

          {/* Group 3: Win / Loss / Breakeven Counts & Averages */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
          }}>
            {/* Card 13: Winning Trades */}
            <div className="card" style={{ padding: '14px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>13. WINNING TRADES</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: 'var(--text-success)' }}>
                {loading ? '…' : s?.winningTrades ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Net PnL &gt; $0</small>
            </div>

            {/* Card 14: Losing Trades */}
            <div className="card" style={{ padding: '14px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>14. LOSING TRADES</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: 'var(--text-danger)' }}>
                {loading ? '…' : s?.losingTrades ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Net PnL &lt; $0</small>
            </div>

            {/* Card 15: Breakeven Trades */}
            <div className="card" style={{ padding: '14px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>15. BREAKEVEN TRADES</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: 'var(--text-muted)' }}>
                {loading ? '…' : s?.breakevenTrades ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Net PnL = $0</small>
            </div>

            {/* Card 16: Avg Profit Per Trade */}
            <div className="card" style={{ padding: '14px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>16. AVG PROFIT / WIN</span>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, color: 'var(--text-success)' }}>
                {loading ? '…' : fmtUsdt(s?.avgProfitPerTrade)}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Winning trades average</small>
            </div>

            {/* Card 17: Avg Loss Per Trade */}
            <div className="card" style={{ padding: '14px 18px' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>17. AVG LOSS / LOSS</span>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, color: 'var(--text-danger)' }}>
                {loading ? '…' : fmtUsdt(s?.avgLossPerTrade ? -s.avgLossPerTrade : 0)}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Losing trades average</small>
            </div>
          </div>

          {/* Group 4: Milestone Hits & Exit Types */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
          }}>
            {/* Card 18: TP1 Hit Count */}
            <div className="card" style={{ padding: '14px 18px', borderLeft: '3px solid #10b981' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>18. TP1 HIT COUNT</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: 'var(--text-success)' }}>
                {loading ? '…' : s?.tp1HitCount ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Non-exclusive milestone</small>
            </div>

            {/* Card 19: TP2 Hit Count */}
            <div className="card" style={{ padding: '14px 18px', borderLeft: '3px solid #10b981' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>19. TP2 HIT COUNT</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: 'var(--text-success)' }}>
                {loading ? '…' : s?.tp2HitCount ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Non-exclusive milestone</small>
            </div>

            {/* Card 20: TP3 Hit Count */}
            <div className="card" style={{ padding: '14px 18px', borderLeft: '3px solid #10b981' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>20. TP3 HIT COUNT</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: 'var(--text-success)' }}>
                {loading ? '…' : s?.tp3HitCount ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Runner target reached</small>
            </div>

            {/* Card 21: Stop-Loss Hit Count */}
            <div className="card" style={{ padding: '14px 18px', borderLeft: '3px solid #ef4444' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>21. STOP-LOSS HITS</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: 'var(--text-danger)' }}>
                {loading ? '…' : s?.stopLossHitCount ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Initial SL trigger</small>
            </div>

            {/* Card 22: Trailing-Stop Hit Count */}
            <div className="card" style={{ padding: '14px 18px', borderLeft: '3px solid #f59e0b' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>22. TRAILING-STOP HITS</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: 'var(--text-warning)' }}>
                {loading ? '…' : s?.trailingStopHitCount ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>Protected profit exit</small>
            </div>

            {/* Card 23: Manual Close Count */}
            <div className="card" style={{ padding: '14px 18px', borderLeft: '3px solid #6b7280' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>23. MANUAL CLOSES</span>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: 'var(--text-muted)' }}>
                {loading ? '…' : s?.manualCloseCount ?? 0}
              </div>
              <small style={{ color: 'var(--text-muted)', fontSize: 10 }}>User or admin override</small>
            </div>
          </div>
        </div>
      </section>

      {/* Tabs for Views */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--surface-border)', paddingBottom: 0 }}>
        {[
          { id: 'overview', label: '📊 Charts & Analytics' },
          { id: 'breakdown', label: '📅 Daily & Weekly Breakdown' },
          { id: 'executions', label: `📋 Execution History (${executionsTotal})` },
          { id: 'unmatched', label: `⚠️ Unmatched Exchange Trades (${unmatchedTrades.length})` },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            style={{
              padding: '10px 16px',
              fontSize: 13,
              fontWeight: activeTab === tab.id ? 700 : 500,
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab 1: Charts & Analytics */}
      {activeTab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Chart Row 1: Daily PnL Bars & Cumulative Equity Curve */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 16 }}>
            {/* Daily Net Realized PnL Chart */}
            <div className="card" style={{ padding: '18px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Daily Net Realized P&L (IST)</h3>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>USDT / Day</span>
              </div>

              {analytics?.dailySeries && analytics.dailySeries.length > 0 ? (
                <div style={{ height: 200, display: 'flex', alignItems: 'flex-end', gap: 8, paddingTop: 20 }}>
                  {(() => {
                    const maxAbs = Math.max(
                      1,
                      ...analytics.dailySeries.map((d) => Math.abs(d.netRealizedPnl)),
                    );
                    return analytics.dailySeries.map((d) => {
                      const isPositive = d.netRealizedPnl >= 0;
                      const heightPct = Math.min(100, (Math.abs(d.netRealizedPnl) / maxAbs) * 100);
                      return (
                        <div
                          key={d.dateIst}
                          style={{
                            flex: 1,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            height: '100%',
                            justifyContent: 'flex-end',
                          }}
                        >
                          <div
                            title={`${d.dateIst}: ${fmtUsdt(d.netRealizedPnl, true)}`}
                            style={{
                              width: '80%',
                              minWidth: 12,
                              maxWidth: 36,
                              height: `${Math.max(4, heightPct)}%`,
                              background: isPositive ? '#10b981' : '#ef4444',
                              borderRadius: '4px 4px 0 0',
                              transition: 'height 0.3s ease',
                            }}
                          />
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, whiteSpace: 'nowrap' }}>
                            {d.dateIst.slice(5)}
                          </span>
                        </div>
                      );
                    });
                  })()}
                </div>
              ) : (
                <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                  No realized P&L records in selected window.
                </div>
              )}
            </div>

            {/* Cumulative Realized PnL (Equity Curve) */}
            <div className="card" style={{ padding: '18px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Cumulative Net Realized Equity Curve</h3>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>Cumulative USDT</span>
              </div>

              {analytics?.dailySeries && analytics.dailySeries.length > 0 ? (
                <div style={{ height: 200, display: 'flex', alignItems: 'flex-end', gap: 6 }}>
                  {(() => {
                    const values = analytics.dailySeries.map((d) => d.cumulativePnl);
                    const min = Math.min(0, ...values);
                    const max = Math.max(1, ...values);
                    const range = max - min || 1;

                    return (
                      <svg width="100%" height="160" viewBox="0 0 500 160" preserveAspectRatio="none" style={{ overflow: 'visible' }}>
                        <defs>
                          <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
                            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
                          </linearGradient>
                        </defs>
                        {/* Area fill and stroke */}
                        {(() => {
                          const pts = analytics.dailySeries.map((d, i) => {
                            const x = (i / (analytics.dailySeries.length - 1 || 1)) * 500;
                            const y = 160 - ((d.cumulativePnl - min) / range) * 140 - 10;
                            return `${x},${y}`;
                          });
                          const linePath = `M ${pts.join(' L ')}`;
                          const areaPath = `M ${pts[0]} L ${pts.join(' L ')} L 500,160 L 0,160 Z`;
                          return (
                            <>
                              <path d={areaPath} fill="url(#equityGrad)" />
                              <path d={linePath} fill="none" stroke="#3b82f6" strokeWidth="2.5" />
                              {analytics.dailySeries.map((d, i) => {
                                const x = (i / (analytics.dailySeries.length - 1 || 1)) * 500;
                                const y = 160 - ((d.cumulativePnl - min) / range) * 140 - 10;
                                return (
                                  <circle
                                    key={d.dateIst}
                                    cx={x}
                                    cy={y}
                                    r="4"
                                    fill="#3b82f6"
                                    stroke="var(--surface)"
                                    strokeWidth="2"
                                  >
                                    <title>{`${d.dateIst}: ${fmtUsdt(d.cumulativePnl, true)}`}</title>
                                  </circle>
                                );
                              })}
                            </>
                          );
                        })()}
                      </svg>
                    );
                  })()}
                </div>
              ) : (
                <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                  No equity curve points available.
                </div>
              )}
            </div>
          </div>

          {/* Row 2: Strategy Comparison & Side Breakdown */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
            {/* Standard vs High-Risk Strategy Comparison */}
            <div className="card" style={{ padding: '18px 20px' }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 12px' }}>Standard vs High-Risk Strategy Performance</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[analytics?.strategyComparison.standard, analytics?.strategyComparison.highRisk].map((st) => {
                  if (!st) return null;
                  const isStd = st.strategy === 'STANDARD';
                  return (
                    <div
                      key={st.strategy}
                      style={{
                        padding: 12,
                        borderRadius: 8,
                        background: 'var(--surface-raised)',
                        border: '1px solid var(--surface-border)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>
                          {isStd ? '🛡️ Standard Strategy' : '⚡ High-Risk Scalping'}
                        </span>
                        <span style={{
                          fontWeight: 700,
                          fontSize: 13,
                          color: st.netRealizedPnl >= 0 ? 'var(--text-success)' : 'var(--text-danger)',
                        }}>
                          {fmtUsdt(st.netRealizedPnl, true)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                        <span>Trades: {st.totalTrades} ({st.closedTrades} closed)</span>
                        <span>Win Rate: {fmtPercent(st.winRate)}</span>
                        <span>Fees: {fmtUsdt(st.totalCommissions)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* LONG vs SHORT Performance */}
            <div className="card" style={{ padding: '18px 20px' }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 12px' }}>Directional Profitability (LONG vs SHORT)</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[analytics?.directionComparison.long, analytics?.directionComparison.short].map((dir) => {
                  if (!dir) return null;
                  const isLong = dir.direction === 'LONG';
                  return (
                    <div
                      key={dir.direction}
                      style={{
                        padding: 12,
                        borderRadius: 8,
                        background: 'var(--surface-raised)',
                        border: '1px solid var(--surface-border)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>
                          {isLong ? '🟢 LONG Positions' : '🔴 SHORT Positions'}
                        </span>
                        <span style={{
                          fontWeight: 700,
                          fontSize: 13,
                          color: dir.netRealizedPnl >= 0 ? 'var(--text-success)' : 'var(--text-danger)',
                        }}>
                          {fmtUsdt(dir.netRealizedPnl, true)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                        <span>Trades: {dir.totalTrades} ({dir.closedTrades} closed)</span>
                        <span>Wins: {dir.winningTrades} / Losses: {dir.losingTrades}</span>
                        <span>Win Rate: {fmtPercent(dir.winRate)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Milestones Distribution */}
            <div className="card" style={{ padding: '18px 20px' }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 12px' }}>Milestone & Exit Breakdown</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { label: 'Take-Profit 1 (TP1)', count: s?.tp1HitCount ?? 0, color: '#10b981' },
                  { label: 'Take-Profit 2 (TP2)', count: s?.tp2HitCount ?? 0, color: '#10b981' },
                  { label: 'Take-Profit 3 (TP3)', count: s?.tp3HitCount ?? 0, color: '#10b981' },
                  { label: 'Stop-Loss (SL)', count: s?.stopLossHitCount ?? 0, color: '#ef4444' },
                  { label: 'Trailing Stop', count: s?.trailingStopHitCount ?? 0, color: '#f59e0b' },
                  { label: 'Manual Close', count: s?.manualCloseCount ?? 0, color: '#6b7280' },
                ].map((item) => (
                  <div key={item.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.color }} />
                      {item.label}
                    </span>
                    <strong>{item.count}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Row 3: Symbol Profitability & Customer Performance */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 16 }}>
            {/* Symbol Ranking */}
            <div className="card" style={{ padding: '18px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Symbol Profitability Ranking</h3>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>Top Performed</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--surface-border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '6px 8px' }}>Symbol</th>
                      <th style={{ padding: '6px 8px' }}>Trades</th>
                      <th style={{ padding: '6px 8px' }}>Win Rate</th>
                      <th style={{ padding: '6px 8px' }}>Commissions</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Net Realized P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics?.symbolRanking.map((sym) => (
                      <tr key={sym.symbol} style={{ borderBottom: '1px solid var(--surface-border-subtle)' }}>
                        <td style={{ padding: '6px 8px', fontWeight: 600 }}>{sym.symbol}</td>
                        <td style={{ padding: '6px 8px' }}>{sym.totalTrades}</td>
                        <td style={{ padding: '6px 8px' }}>{fmtPercent(sym.winRate)}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{fmtUsdt(sym.totalCommissions)}</td>
                        <td style={{
                          padding: '6px 8px',
                          textAlign: 'right',
                          fontWeight: 700,
                          color: sym.netRealizedPnl >= 0 ? 'var(--text-success)' : 'var(--text-danger)',
                        }}>
                          {fmtUsdt(sym.netRealizedPnl, true)}
                        </td>
                      </tr>
                    ))}
                    {(!analytics?.symbolRanking || analytics.symbolRanking.length === 0) && (
                      <tr>
                        <td colSpan={5} style={{ padding: 14, textAlign: 'center', color: 'var(--text-muted)' }}>
                          No symbol executions recorded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Customer Performance Ranking */}
            <div className="card" style={{ padding: '18px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Customer-wise Performance</h3>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>Demo Accounts</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--surface-border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '6px 8px' }}>Customer Email</th>
                      <th style={{ padding: '6px 8px' }}>Trades</th>
                      <th style={{ padding: '6px 8px' }}>Win Rate</th>
                      <th style={{ padding: '6px 8px' }}>Fees</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Net Realized P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics?.customerPerformance.map((cust) => (
                      <tr key={cust.userId} style={{ borderBottom: '1px solid var(--surface-border-subtle)' }}>
                        <td style={{ padding: '6px 8px', fontWeight: 600 }}>{cust.userEmail}</td>
                        <td style={{ padding: '6px 8px' }}>{cust.totalTrades}</td>
                        <td style={{ padding: '6px 8px' }}>{fmtPercent(cust.winRate)}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{fmtUsdt(cust.totalCommissions)}</td>
                        <td style={{
                          padding: '6px 8px',
                          textAlign: 'right',
                          fontWeight: 700,
                          color: cust.netRealizedPnl >= 0 ? 'var(--text-success)' : 'var(--text-danger)',
                        }}>
                          {fmtUsdt(cust.netRealizedPnl, true)}
                        </td>
                      </tr>
                    ))}
                    {(!analytics?.customerPerformance || analytics.customerPerformance.length === 0) && (
                      <tr>
                        <td colSpan={5} style={{ padding: 14, textAlign: 'center', color: 'var(--text-muted)' }}>
                          No customer executions recorded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Daily & Weekly Breakdown Table */}
      {activeTab === 'breakdown' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: '18px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Daily Performance Breakdown (Asia/Kolkata Calendar)</h3>
              <button
                type="button"
                className="button-secondary"
                onClick={() => handleExport('daily')}
                style={{ fontSize: 11, padding: '4px 10px' }}
              >
                Export Daily CSV
              </button>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--surface-border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                    <th style={{ padding: '8px' }}>Date (IST)</th>
                    <th style={{ padding: '8px' }}>Executed</th>
                    <th style={{ padding: '8px' }}>Opened</th>
                    <th style={{ padding: '8px' }}>Closed</th>
                    <th style={{ padding: '8px' }}>Wins</th>
                    <th style={{ padding: '8px' }}>Losses</th>
                    <th style={{ padding: '8px' }}>TP1</th>
                    <th style={{ padding: '8px' }}>TP2</th>
                    <th style={{ padding: '8px' }}>TP3</th>
                    <th style={{ padding: '8px' }}>SL</th>
                    <th style={{ padding: '8px' }}>Gross Profit</th>
                    <th style={{ padding: '8px' }}>Gross Loss</th>
                    <th style={{ padding: '8px' }}>Commissions</th>
                    <th style={{ padding: '8px' }}>Net Funding</th>
                    <th style={{ padding: '8px' }}>Net Realized P&L</th>
                    <th style={{ padding: '8px', textAlign: 'right' }}>Win Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics?.dailyBreakdown.map((row) => (
                    <tr key={row.dateIst} style={{ borderBottom: '1px solid var(--surface-border-subtle)' }}>
                      <td style={{ padding: '8px', fontWeight: 600 }}>{row.dateIst}</td>
                      <td style={{ padding: '8px' }}>{row.totalExecuted}</td>
                      <td style={{ padding: '8px' }}>{row.tradesOpened}</td>
                      <td style={{ padding: '8px' }}>{row.tradesClosed}</td>
                      <td style={{ padding: '8px', color: 'var(--text-success)' }}>{row.winningTrades}</td>
                      <td style={{ padding: '8px', color: 'var(--text-danger)' }}>{row.losingTrades}</td>
                      <td style={{ padding: '8px' }}>{row.tp1Hits}</td>
                      <td style={{ padding: '8px' }}>{row.tp2Hits}</td>
                      <td style={{ padding: '8px' }}>{row.tp3Hits}</td>
                      <td style={{ padding: '8px', color: 'var(--text-danger)' }}>{row.slHits}</td>
                      <td style={{ padding: '8px', color: 'var(--text-success)' }}>{fmtUsdt(row.grossProfit)}</td>
                      <td style={{ padding: '8px', color: 'var(--text-danger)' }}>{fmtUsdt(row.grossLoss ? -row.grossLoss : 0)}</td>
                      <td style={{ padding: '8px', color: 'var(--text-warning)' }}>{fmtUsdt(row.totalCommissions)}</td>
                      <td style={{ padding: '8px' }}>{fmtUsdt(row.netFundingFees, true)}</td>
                      <td style={{
                        padding: '8px',
                        fontWeight: 700,
                        color: row.netRealizedPnl >= 0 ? 'var(--text-success)' : 'var(--text-danger)',
                      }}>
                        {fmtUsdt(row.netRealizedPnl, true)}
                      </td>
                      <td style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }}>{fmtPercent(row.winRate)}</td>
                    </tr>
                  ))}
                  {(!analytics?.dailyBreakdown || analytics.dailyBreakdown.length === 0) && (
                    <tr>
                      <td colSpan={16} style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>
                        No daily breakdown records in selected window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Detailed Execution History Table */}
      {activeTab === 'executions' && (
        <div className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Search & Sort Controls */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="text"
                placeholder="Search symbol, user email, order ID…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  padding: '6px 12px',
                  fontSize: 12,
                  borderRadius: 6,
                  border: '1px solid var(--surface-border)',
                  background: 'var(--surface-raised)',
                  color: 'var(--text-primary)',
                  minWidth: 260,
                }}
              />
              <button
                type="button"
                className="button-secondary"
                onClick={() => setRefreshIndex((k) => k + 1)}
                style={{ fontSize: 12, padding: '6px 12px' }}
              >
                Search
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sort by:</label>
              <select
                value={sortField}
                onChange={(e) => setSortField(e.target.value)}
                style={{ padding: '4px 8px', fontSize: 12, borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)' }}
              >
                <option value="created_at">Opened Time</option>
                <option value="closed_at">Closed Time</option>
                <option value="net_realized_pnl">Net Realized P&L</option>
                <option value="symbol">Symbol</option>
                <option value="status">Status</option>
              </select>

              <button
                type="button"
                className="button-secondary"
                onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                style={{ fontSize: 11, padding: '4px 8px' }}
              >
                {sortOrder.toUpperCase()}
              </button>

              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                style={{ padding: '4px 8px', fontSize: 12, borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)' }}
              >
                <option value={10}>10 / page</option>
                <option value={25}>25 / page</option>
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
              </select>

              <button
                type="button"
                className="button-secondary"
                onClick={() => handleExport('executions')}
                style={{ fontSize: 12, padding: '5px 12px' }}
              >
                📥 Export Ledger CSV
              </button>
            </div>
          </div>

          {/* Executions Table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--surface-border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '8px' }}>ID</th>
                  <th style={{ padding: '8px' }}>Customer</th>
                  <th style={{ padding: '8px' }}>Symbol</th>
                  <th style={{ padding: '8px' }}>Strategy</th>
                  <th style={{ padding: '8px' }}>Side</th>
                  <th style={{ padding: '8px' }}>Entry Time (IST)</th>
                  <th style={{ padding: '8px' }}>Entry Fill</th>
                  <th style={{ padding: '8px' }}>Exit Fill</th>
                  <th style={{ padding: '8px' }}>Qty (Remain)</th>
                  <th style={{ padding: '8px' }}>Milestones</th>
                  <th style={{ padding: '8px' }}>Fees</th>
                  <th style={{ padding: '8px' }}>Net Realized P&L</th>
                  <th style={{ padding: '8px' }}>Status</th>
                  <th style={{ padding: '8px' }}>Reconciliation</th>
                  <th style={{ padding: '8px', textAlign: 'center' }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((e) => (
                  <tr key={e.id} style={{ borderBottom: '1px solid var(--surface-border-subtle)' }}>
                    <td style={{ padding: '8px', fontFamily: 'monospace' }}>#{e.id}</td>
                    <td style={{ padding: '8px' }} title={e.userEmail}>
                      <span style={{ maxWidth: 140, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.userEmail}
                      </span>
                    </td>
                    <td style={{ padding: '8px', fontWeight: 600 }}>{e.symbol}</td>
                    <td style={{ padding: '8px' }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {e.strategy === 'STANDARD' ? 'Standard' : 'Scalping'}
                      </span>
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span className={`table-badge ${e.direction === 'LONG' ? 'table-badge-long' : 'table-badge-short'}`}>
                        {e.direction}
                      </span>
                    </td>
                    <td style={{ padding: '8px', whiteSpace: 'nowrap', fontSize: 11 }}>{fmtDate(e.createdAt)}</td>
                    <td style={{ padding: '8px', fontFamily: 'monospace' }}>${e.entryFillPrice.toFixed(2)}</td>
                    <td style={{ padding: '8px', fontFamily: 'monospace' }}>
                      {e.exitFillPrice !== null ? `$${e.exitFillPrice.toFixed(2)}` : '—'}
                    </td>
                    <td style={{ padding: '8px', fontFamily: 'monospace' }}>
                      {e.executedQty} ({e.remainingQty})
                    </td>
                    <td style={{ padding: '8px' }}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {e.tp1ReachedAt && <span className="table-badge table-badge-ready" style={{ fontSize: 10 }}>TP1</span>}
                        {e.tp2ReachedAt && <span className="table-badge table-badge-ready" style={{ fontSize: 10 }}>TP2</span>}
                        {e.tp3ReachedAt && <span className="table-badge table-badge-ready" style={{ fontSize: 10 }}>TP3</span>}
                        {e.stopLossHitAt && <span className="table-badge table-badge-diag-error" style={{ fontSize: 10 }}>SL</span>}
                        {e.trailingStopHitAt && <span className="table-badge table-badge-diag-warning" style={{ fontSize: 10 }}>TR</span>}
                      </div>
                    </td>
                    <td style={{ padding: '8px', fontSize: 11, color: 'var(--text-muted)' }}>
                      {fmtUsdt(e.commissionUsdt)}
                    </td>
                    <td style={{
                      padding: '8px',
                      fontWeight: 700,
                      color: e.netRealizedPnl >= 0 ? 'var(--text-success)' : 'var(--text-danger)',
                    }}>
                      {fmtUsdt(e.netRealizedPnl, true)}
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span className={`table-badge ${
                        e.status === 'CLOSED'
                          ? 'table-badge-diag-muted'
                          : e.status === 'PROTECTED'
                            ? 'table-badge-ready'
                            : 'table-badge-wait'
                      }`}>
                        {e.status}
                      </span>
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span className={`table-badge ${
                        e.reconciliationStatus === 'RECONCILED'
                          ? 'table-badge-ready'
                          : e.reconciliationStatus === 'DISCREPANCY'
                            ? 'table-badge-diag-error'
                            : 'table-badge-wait'
                      }`}>
                        {e.reconciliationStatus || 'PENDING'}
                      </span>
                    </td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => setSelectedExecution(e)}
                        style={{ padding: '3px 8px', fontSize: 11 }}
                      >
                        Timeline
                      </button>
                    </td>
                  </tr>
                ))}
                {executions.length === 0 && (
                  <tr>
                    <td colSpan={15} style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                      No matching executions found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Showing {executions.length > 0 ? (page - 1) * pageSize + 1 : 0}–
              {Math.min(page * pageSize, executionsTotal)} of {executionsTotal} executions
            </span>

            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="button-secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                style={{ fontSize: 11, padding: '4px 10px' }}
              >
                ◀ Previous
              </button>
              <span style={{ fontSize: 12, padding: '4px 8px' }}>
                Page {page} of {Math.max(1, Math.ceil(executionsTotal / pageSize))}
              </span>
              <button
                type="button"
                className="button-secondary"
                disabled={page * pageSize >= executionsTotal}
                onClick={() => setPage((p) => p + 1)}
                style={{ fontSize: 11, padding: '4px 10px' }}
              >
                Next ▶
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tab 4: Unmatched Exchange Trades */}
      {activeTab === 'unmatched' && (
        <div className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Unmatched Binance Demo Fills</h3>
              <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
                Fills executed on the Demo Binance Futures account not initiated by SmartExit automated strategy rules.
                Preserved separately to prevent polluting SmartExit strategy performance reporting.
              </p>
            </div>
            <span className="mono" style={{ fontSize: 12 }}>Total Unmatched: {unmatchedTrades.length}</span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--surface-border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '8px' }}>Trade ID</th>
                  <th style={{ padding: '8px' }}>Order ID</th>
                  <th style={{ padding: '8px' }}>Symbol</th>
                  <th style={{ padding: '8px' }}>Side</th>
                  <th style={{ padding: '8px' }}>Fill Price</th>
                  <th style={{ padding: '8px' }}>Executed Qty</th>
                  <th style={{ padding: '8px' }}>Realized P&L</th>
                  <th style={{ padding: '8px' }}>Commission</th>
                  <th style={{ padding: '8px' }}>Exchange Time</th>
                </tr>
              </thead>
              <tbody>
                {unmatchedTrades.map((t) => (
                  <tr key={t.id} style={{ borderBottom: '1px solid var(--surface-border-subtle)' }}>
                    <td style={{ padding: '8px', fontFamily: 'monospace' }}>{t.id}</td>
                    <td style={{ padding: '8px', fontFamily: 'monospace' }}>{t.orderId}</td>
                    <td style={{ padding: '8px', fontWeight: 600 }}>{t.symbol}</td>
                    <td style={{ padding: '8px' }}>
                      <span className={`table-badge ${t.side === 'BUY' ? 'table-badge-long' : 'table-badge-short'}`}>
                        {t.side}
                      </span>
                    </td>
                    <td style={{ padding: '8px', fontFamily: 'monospace' }}>${t.price.toFixed(2)}</td>
                    <td style={{ padding: '8px', fontFamily: 'monospace' }}>{t.qty}</td>
                    <td style={{
                      padding: '8px',
                      fontWeight: 700,
                      color: t.realizedPnl >= 0 ? 'var(--text-success)' : 'var(--text-danger)',
                    }}>
                      {fmtUsdt(t.realizedPnl, true)}
                    </td>
                    <td style={{ padding: '8px', color: 'var(--text-muted)' }}>
                      ${t.commission.toFixed(4)} {t.commissionAsset}
                    </td>
                    <td style={{ padding: '8px', fontSize: 11 }}>{fmtDate(t.time)}</td>
                  </tr>
                ))}
                {unmatchedTrades.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                      No unmatched exchange trades detected. All exchange fills match SmartExit trade lifecycle records.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Execution Details Drawer / Modal */}
      {selectedExecution && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.6)',
          zIndex: 9999,
          display: 'flex',
          justifyContent: 'flex-end',
        }}>
          <div style={{
            width: '100%',
            maxWidth: 620,
            height: '100%',
            background: 'var(--surface)',
            boxShadow: 'var(--card-shadow-hover)',
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
            padding: 24,
            gap: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  EXECUTION AUDIT #{selectedExecution.id}
                </span>
                <h2 style={{ margin: '4px 0 0', fontSize: 20, fontWeight: 700 }}>
                  {selectedExecution.symbol} {selectedExecution.direction} ({selectedExecution.strategy})
                </h2>
              </div>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setSelectedExecution(null)}
                style={{ padding: '6px 12px', fontSize: 13 }}
              >
                ✕ Close
              </button>
            </div>

            {/* Reconciliation Audit Card */}
            <div className="card" style={{
              padding: 16,
              background: 'var(--surface-raised)',
              border: '1px solid var(--surface-border)',
            }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>FINANCIAL RECONCILIATION SUMMARY</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginTop: 10 }}>
                <div>
                  <small style={{ color: 'var(--text-muted)' }}>Gross Realized P&L</small>
                  <div style={{ fontWeight: 700, color: selectedExecution.grossRealizedPnl >= 0 ? 'var(--text-success)' : 'var(--text-danger)' }}>
                    {fmtUsdt(selectedExecution.grossRealizedPnl, true)}
                  </div>
                </div>
                <div>
                  <small style={{ color: 'var(--text-muted)' }}>Trading Commissions</small>
                  <div style={{ fontWeight: 700, color: 'var(--text-warning)' }}>
                    {fmtUsdt(selectedExecution.commissionUsdt)}
                  </div>
                </div>
                <div>
                  <small style={{ color: 'var(--text-muted)' }}>Net Funding Fees</small>
                  <div style={{ fontWeight: 700 }}>
                    {fmtUsdt(selectedExecution.fundingFeeUsdt, true)}
                  </div>
                </div>
                <div>
                  <small style={{ color: 'var(--text-muted)' }}>Net Realized P&L</small>
                  <div style={{ fontWeight: 700, fontSize: 16, color: selectedExecution.netRealizedPnl >= 0 ? 'var(--text-success)' : 'var(--text-danger)' }}>
                    {fmtUsdt(selectedExecution.netRealizedPnl, true)}
                  </div>
                </div>
              </div>
            </div>

            {/* Complete Execution Timeline */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Confirmed Exchange Timeline</h3>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Event 1: Entry */}
                <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-raised)', borderLeft: '3px solid #3b82f6' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <strong>1. Entry Order Filled</strong>
                    <span style={{ color: 'var(--text-muted)' }}>{fmtDate(selectedExecution.createdAt)}</span>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text-secondary)' }}>
                    Price: <strong>${selectedExecution.entryFillPrice.toFixed(2)}</strong> · Qty: <strong>{selectedExecution.executedQty}</strong> · Leverage: <strong>{selectedExecution.leverage}x</strong>
                  </div>
                  {selectedExecution.binanceOrderId && (
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      Binance Order ID: {selectedExecution.binanceOrderId}
                    </div>
                  )}
                </div>

                {/* Event 2: TP1 */}
                {selectedExecution.tp1ReachedAt && (
                  <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-raised)', borderLeft: '3px solid #10b981' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <strong style={{ color: 'var(--text-success)' }}>2. Take-Profit 1 (TP1) Reached</strong>
                      <span style={{ color: 'var(--text-muted)' }}>{fmtDate(selectedExecution.tp1ReachedAt)}</span>
                    </div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      Milestone filled · Stop-Loss moved to Breakeven
                    </div>
                  </div>
                )}

                {/* Event 3: TP2 */}
                {selectedExecution.tp2ReachedAt && (
                  <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-raised)', borderLeft: '3px solid #10b981' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <strong style={{ color: 'var(--text-success)' }}>3. Take-Profit 2 (TP2) Reached</strong>
                      <span style={{ color: 'var(--text-muted)' }}>{fmtDate(selectedExecution.tp2ReachedAt)}</span>
                    </div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      Second partial profit secured · Trailing stop active
                    </div>
                  </div>
                )}

                {/* Event 4: TP3 */}
                {selectedExecution.tp3ReachedAt && (
                  <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-raised)', borderLeft: '3px solid #10b981' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <strong style={{ color: 'var(--text-success)' }}>4. Take-Profit 3 (TP3) Runner Reached</strong>
                      <span style={{ color: 'var(--text-muted)' }}>{fmtDate(selectedExecution.tp3ReachedAt)}</span>
                    </div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      Target milestone reached
                    </div>
                  </div>
                )}

                {/* Event 5: Stop-Loss */}
                {selectedExecution.stopLossHitAt && (
                  <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-raised)', borderLeft: '3px solid #ef4444' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <strong style={{ color: 'var(--text-danger)' }}>Stop-Loss Triggered</strong>
                      <span style={{ color: 'var(--text-muted)' }}>{fmtDate(selectedExecution.stopLossHitAt)}</span>
                    </div>
                  </div>
                )}

                {/* Event 6: Trailing Stop */}
                {selectedExecution.trailingStopHitAt && (
                  <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-raised)', borderLeft: '3px solid #f59e0b' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <strong style={{ color: 'var(--text-warning)' }}>Trailing Stop Triggered</strong>
                      <span style={{ color: 'var(--text-muted)' }}>{fmtDate(selectedExecution.trailingStopHitAt)}</span>
                    </div>
                  </div>
                )}

                {/* Final Exit */}
                {selectedExecution.closedAt && (
                  <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-raised)', borderLeft: '3px solid #6b7280' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <strong>Position Closed ({selectedExecution.exitReason || 'EXCHANGE_EXIT'})</strong>
                      <span style={{ color: 'var(--text-muted)' }}>{fmtDate(selectedExecution.closedAt)}</span>
                    </div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      Exit Fill Price: <strong>${selectedExecution.exitFillPrice?.toFixed(2) ?? '—'}</strong> ·
                      Remaining Qty: <strong>{selectedExecution.remainingQty}</strong>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Account & Metadata */}
            <div style={{ fontSize: 12, color: 'var(--text-muted)', borderTop: '1px solid var(--surface-border)', paddingTop: 12 }}>
              <div>Trader Account: {selectedExecution.userEmail} (ID: {selectedExecution.userId})</div>
              <div>Reconciliation Status: {selectedExecution.reconciliationStatus}</div>
              <div>Environment: Binance USDⓈ-M Futures (Demo)</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
