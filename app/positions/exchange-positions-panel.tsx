'use client';

import { useCallback, useEffect, useState } from 'react';

type Position = {
  symbol: string;
  positionAmt: string;
  entryPrice: string | null;
  markPrice: string;
  unRealizedProfit: string;
  leverage: string | null;
  direction?: 'LONG' | 'SHORT';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
};

type Positions = {
  environment: 'DEMO' | 'LIVE';
  virtualFunds: boolean;
  positions: Position[];
};

function amount(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumSignificantDigits: 9 }) : '—';
}

function direction(position: Position) {
  if (position.direction) return position.direction;
  if (position.positionSide !== 'BOTH') return position.positionSide;
  return Number(position.positionAmt) > 0 ? 'LONG' : 'SHORT';
}

export function ExchangePositionsPanel() {
  const [data, setData] = useState<Positions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/trading/positions', { cache: 'no-store' });
      const body = await response.json() as { data?: Positions; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Exchange positions are unavailable.');
      setData(body.data);
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : 'Exchange positions are unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return <section className="card stack">
    <div className="notification-center-heading">
      <div>
        <p className="mono">BINANCE FUTURES{data && (data.virtualFunds ? ' · DEMO / VIRTUAL FUNDS' : ' · LIVE / REAL FUNDS')}</p>
        <h2>Binance Open Positions</h2>
      </div>
      <button type="button" className="button-secondary" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : '↻ Refresh'}</button>
    </div>
    <p className="muted">
      This view shows open positions returned by Binance for the selected environment.
    </p>
    {error && <p className="error" role="alert">{error}</p>}
    {loading && <p className="muted">Loading exchange positions…</p>}
    {!loading && !error && data?.positions.length === 0 && <p className="muted">Binance reported no open positions in this environment.</p>}
    {!!data?.positions.length && <div className="scanner-table-wrap"><table className="scan-table position-table">
      <thead><tr><th>Pair</th><th>Position</th><th>Entry / Mark</th><th>Leverage</th><th>Unrealized PnL</th></tr></thead>
      <tbody>{data.positions.map((position) => <tr key={`${position.symbol}-${position.positionSide}`}>
        <td>{position.symbol}<small>{data.environment}</small></td>
        <td>{amount(position.positionAmt)} · {direction(position)}</td>
        <td>{position.entryPrice && Number(position.entryPrice) > 0 ? amount(position.entryPrice) : 'Pending confirmation'} / {amount(position.markPrice)}</td>
        <td>{position.leverage && Number(position.leverage) > 0 ? `${position.leverage}x` : 'Unavailable'}</td>
        <td>{amount(position.unRealizedProfit)} USDT</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
