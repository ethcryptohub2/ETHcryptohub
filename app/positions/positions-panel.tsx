'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ExchangePositionsPanel } from './exchange-positions-panel';
import { POSITIONS_PAGE_SIZE } from '../../lib/pagination';
import { Pagination } from '../../components/pagination';

type Position = {
  signal_id: string;
  scanner_type: 'STANDARD' | 'HIGH_RISK';
  symbol: string;
  side: 'LONG' | 'SHORT';
  timeframe: string;
  strategy_name: string;
  reference_entry: string;
  stop_loss: string;
  take_profit_1: string;
  take_profit_2: string;
  take_profit_3: string | null;
  actual_entry: string;
  actual_exit: string | null;
  realized_pnl: string | null;
  status: 'ENTERED' | 'CLOSED';
  entered_at: string;
  closed_at: string | null;
  signal_status: string;
};

type VirtualAccountSummary = {
  startingBalance: number;
  totalRealizedPnl: number;
  unrealizedPnl: number;
  estimatedTradingFees: number;
  currentVirtualEquity: number;
  openPositionsCount: number;
  closedTradesCount: number;
  winRatePercent: number;
  profitFactor: number;
  takerFeeRatePercent: number;
  storageType: string;
  table: string;
};

function price(value: string | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumSignificantDigits: 8 }) : '—';
}

export function PositionsPanel() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [summary, setSummary] = useState<VirtualAccountSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(POSITIONS_PAGE_SIZE),
        status: showClosed ? 'CLOSED' : 'ENTERED',
      });
      const response = await fetch(`/api/positions?${params}`, { cache: 'no-store' });
      const body = (await response.json()) as {
        data?: {
          positions: Position[];
          summary: VirtualAccountSummary;
          pagination?: { total: number; page: number; pageSize: number; totalPages: number };
        } | Position[];
        error?: string;
      };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Position records could not be loaded.');
      if (Array.isArray(body.data)) {
        setPositions(body.data);
        setTotalCount(body.data.length);
        setTotalPages(Math.max(1, Math.ceil(body.data.length / POSITIONS_PAGE_SIZE)));
      } else {
        setPositions(body.data.positions ?? []);
        setSummary(body.data.summary ?? null);
        if (body.data.pagination) {
          setTotalCount(body.data.pagination.total);
          setTotalPages(body.data.pagination.totalPages);
        } else {
          setTotalCount(body.data.positions?.length ?? 0);
          setTotalPages(Math.max(1, Math.ceil((body.data.positions?.length ?? 0) / POSITIONS_PAGE_SIZE)));
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Position records could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [page, showClosed]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const pagePositions = positions;
  return <main className="shell">
    <section className="hero">
      <p className="mono">EXECUTION LEDGER · [INTERNAL PAPER SIMULATION]</p>
      <h1>Paper Position Records</h1>
      <p className="muted">
        These are simulated positions tracked in your local virtual ledger with 0 capital risk. Remote signed exchange orders are tracked in the Authenticated Exchange Demo Positions panel below.
      </p>
    </section>
    {summary && (
      <section
        className="card"
        style={{
          padding: '16px 20px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
          background: 'var(--surface-raised)',
          border: '1px solid var(--accent)',
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>VIRTUAL PAPER EQUITY</small>
          <strong style={{ fontSize: 18, fontFamily: 'DM Mono', color: 'var(--accent)' }}>
            ${summary.currentVirtualEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>Base: ${summary.startingBalance.toLocaleString()} USDT Virtual Capital</small>
        </div>
        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>REALIZED / UNREALIZED PNL</small>
          <strong
            style={{
              fontSize: 18,
              fontFamily: 'DM Mono',
              color: (summary.totalRealizedPnl + (summary.unrealizedPnl ?? 0)) >= 0 ? '#10b981' : '#ef4444',
            }}
          >
            {summary.totalRealizedPnl >= 0 ? '+' : ''}${summary.totalRealizedPnl.toFixed(2)}
            {' '}<span style={{ fontSize: 13, color: (summary.unrealizedPnl ?? 0) >= 0 ? '#10b981' : '#ef4444' }}>
              ({(summary.unrealizedPnl ?? 0) >= 0 ? '+' : ''}${(summary.unrealizedPnl ?? 0).toFixed(2)} unrealized)
            </span>
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>
            {summary.closedTradesCount} closed ({summary.winRatePercent}% win rate)
          </small>
        </div>
        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>TRADING FEES (0.04% TAKER)</small>
          <strong style={{ fontSize: 18, fontFamily: 'DM Mono', color: '#f59e0b' }}>
            -${(summary.estimatedTradingFees ?? 0).toFixed(2)} USDT
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>Simulated VIP0 fees deducted</small>
        </div>
        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>ACTIVE OPEN POSITIONS</small>
          <strong style={{ fontSize: 18, fontFamily: 'DM Mono' }}>
            {summary.openPositionsCount}
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>Simulated positions</small>
        </div>
        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>PERSISTENCE ENGINE</small>
          <span style={{ fontSize: 12, fontFamily: 'DM Mono', color: '#10b981', fontWeight: 600 }}>
            ✓ POSTGRESQL PERSISTENT
          </span>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>public.signal_user_entries</small>
        </div>
      </section>
    )}
    <ExchangePositionsPanel />
    <section className="card stack">
      <div className="position-toolbar">
        <div className="links" role="group" aria-label="Position record filter">
          <button type="button" className={!showClosed ? '' : 'button-secondary'} onClick={() => { setShowClosed(false); setPage(1); }}>Open entries</button>
          <button type="button" className={showClosed ? '' : 'button-secondary'} onClick={() => { setShowClosed(true); setPage(1); }}>Closed history</button>
        </div>
        <button type="button" className="button-secondary" onClick={() => void load()} disabled={loading}>Refresh</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {loading && <p className="muted">Loading your recorded entries…</p>}
      {!loading && !error && pagePositions.length === 0 && <p className="muted">{showClosed ? 'No closed user-recorded entries yet.' : 'No open user-recorded entries yet. Record an entry from signal history.'}</p>}
      {!loading && pagePositions.length > 0 && <div className="scanner-table-wrap"><table className="scan-table position-table">
        <thead><tr><th>Pair</th><th>Mode</th><th>Direction</th><th>Actual entry</th><th>Stop Loss</th><th>TP1 / TP2 / TP3</th><th>Exit / PnL</th><th>Recorded</th><th>Signal</th></tr></thead>
        <tbody>{pagePositions.map((position) => <tr key={position.signal_id}>
          <td>{position.symbol}<small>{position.timeframe}</small></td>
          <td>{position.scanner_type === 'HIGH_RISK' ? 'High-Risk' : 'Standard'}</td>
          <td>{position.side}</td>
          <td>{price(position.actual_entry)}</td>
          <td>{price(position.stop_loss)}</td>
          <td>{price(position.take_profit_1)} / {price(position.take_profit_2)} / {price(position.take_profit_3)}</td>
          <td>{position.actual_exit ? `${price(position.actual_exit)} · PnL ${price(position.realized_pnl)}` : 'Open record'}</td>
          <td>{new Date(position.entered_at).toLocaleString()}</td>
          <td><Link href={`/signals/${position.signal_id}`}>{position.signal_status.replaceAll('_', ' ')}</Link></td>
        </tr>)}</tbody>
      </table></div>}
      {totalCount > 0 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={totalCount}
          pageSize={POSITIONS_PAGE_SIZE}
          onPageChange={setPage}
          itemLabel="positions"
        />
      )}
    </section>
  </main>;
}
