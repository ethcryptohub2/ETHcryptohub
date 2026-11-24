'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ExchangePositionsPanel } from './exchange-positions-panel';
import { POSITIONS_PAGE_SIZE } from '../../lib/pagination';
import { Pagination } from '../../components/pagination';

type ExecutionItem = {
  id: string;
  signal_id: string;
  exchange: 'BINANCE' | 'BYBIT' | 'OKX' | 'BITGET' | 'GATE';
  strategy: 'STANDARD' | 'HIGH_RISK_SCALPING';
  environment: 'DEMO' | 'LIVE';
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: string;
  notional_usdt: string;
  leverage: number;
  entry_price: string;
  actual_fill_price: string | null;
  stop_loss: string;
  take_profit: string;
  tp1_price: string;
  tp2_price: string;
  tp3_price: string | null;
  protection_status: string;
  realized_pnl: string | null;
  execution_status: string;
  execution_mode: string;
  created_at: string;
  updated_at: string;
};

type ExecutionResponse = {
  data?: {
    items: ExecutionItem[];
    total: number;
    page: number;
    pageSize: number;
    performance: {
      DEMO: { total: number; protected: number; failed: number };
      LIVE: { total: number; protected: number; failed: number };
    };
  };
  error?: string;
};

function formatPrice(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumSignificantDigits: 8 }) : value;
}

function exchangeBadgeColor(exchange: string): { bg: string; color: string; border: string } {
  switch (exchange) {
    case 'BINANCE':
      return { bg: '#fef3c7', color: '#92400e', border: '#fcd34d' };
    case 'BYBIT':
      return { bg: '#e0e7ff', color: '#3730a3', border: '#a5b4fc' };
    case 'OKX':
      return { bg: '#f3f4f6', color: '#111827', border: '#d1d5db' };
    case 'BITGET':
      return { bg: '#ccfbf1', color: '#115e59', border: '#5eead4' };
    case 'GATE':
      return { bg: '#fce7f3', color: '#9d174d', border: '#f472b6' };
    default:
      return { bg: 'var(--surface-raised)', color: 'var(--text-muted)', border: 'var(--surface-border)' };
  }
}

export function PositionsPanel() {
  const [executions, setExecutions] = useState<ExecutionItem[]>([]);
  const [execTotal, setExecTotal] = useState(0);
  const [execPage, setExecPage] = useState(1);
  const [execTotalPages, setExecTotalPages] = useState(1);
  const [execLoading, setExecLoading] = useState(true);
  const [execError, setExecError] = useState('');
  const [filterExchange, setFilterExchange] = useState<string>('ALL');
  const [refreshKey, setRefreshKey] = useState(0);
  const loadExecutions = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;
    const fetchExecutions = async () => {
      setExecLoading(true);
      setExecError('');
      try {
        const params = new URLSearchParams({
          page: String(execPage),
          environment: 'DEMO',
          ...(filterExchange !== 'ALL' ? { exchange: filterExchange } : {}),
        });
        const response = await fetch(`/api/trading/executions?${params}`, { cache: 'no-store' });
        const body = (await response.json()) as ExecutionResponse;
        if (!active) return;
        if (!response.ok || !body.data) {
          throw new Error(body.error ?? 'Exchange trade executions could not be loaded.');
        }
        setExecutions(body.data.items);
        setExecTotal(body.data.total);
        setExecTotalPages(Math.max(1, Math.ceil(body.data.total / POSITIONS_PAGE_SIZE)));
      } catch (err) {
        if (active) {
          setExecError(err instanceof Error ? err.message : 'Execution history unavailable.');
        }
      } finally {
        if (active) {
          setExecLoading(false);
        }
      }
    };
    void fetchExecutions();
    return () => { active = false; };
  }, [execPage, filterExchange, refreshKey]);

  return (
    <main className="shell">
      <section className="hero">
        <p className="mono">MULTI-EXCHANGE GATEWAY · AUTHENTICATED DEMO &amp; TESTNET</p>
        <h1>Exchange Positions &amp; Executions</h1>
        <p className="muted">
          Real-time open positions and confirmed executions across authenticated exchange Demo accounts (Binance, Bybit, OKX, Bitget, Gate.io). Real-money Live Trading is strictly locked fail-closed (HTTP 403). Zero internal paper simulation.
        </p>
        <div className="links">
          <Link href="/scanner" className="button">
            ⚡ Open Market Scanner
          </Link>
          <Link href="/binance" className="button-secondary">
            Exchange Connections &amp; Switches
          </Link>
        </div>
      </section>

      {/* Primary: Live Signed Exchange Open Positions */}
      <ExchangePositionsPanel />

      {/* Secondary: Genuine Exchange Trade Execution History */}
      <section className="card stack" style={{ marginTop: 20 }}>
        <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <p className="mono">AUTHENTICATED EXCHANGE AUDIT LEDGER · DEMO EXECUTIONS</p>
            <h2 style={{ margin: 0 }}>Exchange Trade Execution History</h2>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              Every executed order is cryptographically signed and dispatched directly to remote exchange Demo / Testnet APIs.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={filterExchange}
              onChange={(e) => {
                setFilterExchange(e.target.value);
                setExecPage(1);
              }}
              style={{ padding: '6px 12px', fontSize: 12, borderRadius: 6, border: '1px solid var(--surface-border)', background: 'var(--surface-raised)', color: 'inherit' }}
            >
              <option value="ALL">All Exchanges</option>
              <option value="BINANCE">Binance Futures Demo</option>
              <option value="BYBIT">Bybit Demo</option>
              <option value="OKX">OKX Demo</option>
              <option value="BITGET">Bitget Demo</option>
              <option value="GATE">Gate.io Testnet</option>
            </select>
            <button
              type="button"
              className="button-secondary"
              onClick={() => void loadExecutions()}
              disabled={execLoading}
              style={{ fontSize: 12, padding: '6px 12px' }}
            >
              {execLoading ? 'Loading…' : '↻ Refresh History'}
            </button>
          </div>
        </div>

        {execError && <p className="error" role="alert">{execError}</p>}
        {execLoading && <p className="muted">Fetching authenticated exchange executions…</p>}

        {!execLoading && !execError && executions.length === 0 && (
          <div style={{ padding: '32px 16px', textAlign: 'center', background: 'var(--surface-subtle)', borderRadius: 8, border: '1px dashed var(--surface-border)' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>No Exchange Demo Executions Yet</h3>
            <p className="muted" style={{ margin: '0 0 14px', fontSize: 13, maxWidth: 480, marginLeft: 'auto', marginRight: 'auto' }}>
              When high-confluence setups appear on the Smart Scanner, execute Demo orders directly to your connected exchanges.
            </p>
            <Link href="/scanner" className="button" style={{ fontSize: 12, padding: '6px 14px' }}>
              Launch Scanner
            </Link>
          </div>
        )}

        {!execLoading && executions.length > 0 && (
          <div className="scanner-table-wrap">
            <table className="scan-table position-table">
              <thead>
                <tr>
                  <th>Exchange</th>
                  <th>Pair</th>
                  <th>Direction</th>
                  <th>Fill Price</th>
                  <th>Quantity / Notional</th>
                  <th>Stop Loss</th>
                  <th>Take Profit (TP1/2/3)</th>
                  <th>Status</th>
                  <th>Executed At</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((exec) => {
                  const badge = exchangeBadgeColor(exec.exchange);
                  return (
                    <tr key={exec.id}>
                      <td>
                        <span
                          style={{
                            padding: '3px 8px',
                            borderRadius: 4,
                            fontSize: 10,
                            fontWeight: 700,
                            fontFamily: 'DM Mono',
                            background: badge.bg,
                            color: badge.color,
                            border: `1px solid ${badge.border}`,
                          }}
                        >
                          {exec.exchange}
                        </span>
                      </td>
                      <td>
                        <strong>{exec.symbol}</strong>
                        <small style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)' }}>
                          {exec.strategy === 'HIGH_RISK_SCALPING' ? 'Scalping' : 'Standard'} · {exec.leverage}x
                        </small>
                      </td>
                      <td>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: 12,
                            color: exec.side === 'LONG' ? '#10b981' : '#ef4444',
                          }}
                        >
                          {exec.side}
                        </span>
                      </td>
                      <td>{formatPrice(exec.actual_fill_price || exec.entry_price)}</td>
                      <td>
                        {formatPrice(exec.quantity)}
                        <small style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)' }}>
                          ${formatPrice(exec.notional_usdt)} USDT
                        </small>
                      </td>
                      <td>{formatPrice(exec.stop_loss)}</td>
                      <td>
                        {formatPrice(exec.tp1_price)} / {formatPrice(exec.tp2_price)} / {formatPrice(exec.tp3_price)}
                      </td>
                      <td>
                        <span
                          style={{
                            padding: '2px 6px',
                            borderRadius: 4,
                            fontSize: 10,
                            fontWeight: 600,
                            fontFamily: 'DM Mono',
                            background: exec.execution_status === 'PROTECTED' ? '#f0fdf4' : exec.execution_status === 'CLOSED' ? 'var(--surface-raised)' : '#fef2f2',
                            color: exec.execution_status === 'PROTECTED' ? '#166534' : exec.execution_status === 'CLOSED' ? 'var(--text-muted)' : '#991b1b',
                          }}
                        >
                          {exec.execution_status}
                        </span>
                      </td>
                      <td>
                        <small style={{ fontSize: 11 }}>{new Date(exec.created_at).toLocaleString()}</small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {execTotal > 0 && (
          <Pagination
            page={execPage}
            totalPages={execTotalPages}
            totalItems={execTotal}
            pageSize={20}
            onPageChange={setExecPage}
            itemLabel="executions"
          />
        )}
      </section>
    </main>
  );
}
