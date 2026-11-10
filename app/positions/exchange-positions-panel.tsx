'use client';

import { useCallback, useEffect, useState } from 'react';

type Position = {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  leverage: string;
  positionSide: string;
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

export function ExchangePositionsPanel() {
  const [environment, setEnvironment] = useState<'DEMO' | 'LIVE'>('DEMO');
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
      setError(reason instanceof Error ? reason.message : 'Exchange positions are unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetch('/api/trading/settings', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { data?: { active_environment: 'DEMO' | 'LIVE' } };
        if (response.ok && body.data && active) setEnvironment(body.data.active_environment);
      })
      .catch(() => {
        if (active) setError('Could not load the active trading environment.');
      });
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load]);

  return <section className="card stack">
    <div className="notification-center-heading">
      <div><p className="mono">BINANCE FUTURES · {environment === 'DEMO' ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'}</p><h2>Exchange open positions</h2></div>
      <button type="button" className="button-secondary" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : '↻ Refresh'}</button>
    </div>
    <p className="muted">Positions are fetched only from the active environment. Demo and Live accounts are never combined.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {loading && <p className="muted">Loading exchange positions…</p>}
    {!loading && !error && data?.positions.length === 0 && <p className="muted">No open exchange positions in the selected environment.</p>}
    {!!data?.positions.length && <div className="scanner-table-wrap"><table className="scan-table position-table">
      <thead><tr><th>Pair</th><th>Position</th><th>Entry / Mark</th><th>Leverage</th><th>Unrealized PnL</th></tr></thead>
      <tbody>{data.positions.map((position) => <tr key={`${position.symbol}-${position.positionSide}`}>
        <td>{position.symbol}<small>{data.environment}</small></td>
        <td>{amount(position.positionAmt)} · {position.positionSide}</td>
        <td>{amount(position.entryPrice)} / {amount(position.markPrice)}</td>
        <td>{position.leverage}x</td>
        <td>{amount(position.unRealizedProfit)} USDT</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
