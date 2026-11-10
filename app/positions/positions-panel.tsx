'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ExchangePositionsPanel } from './exchange-positions-panel';

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

function price(value: string | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumSignificantDigits: 8 }) : '—';
}

export function PositionsPanel() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/positions', { cache: 'no-store' });
      const body = await response.json() as { data?: Position[]; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Position records could not be loaded.');
      setPositions(body.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Position records could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const visible = positions.filter((position) => showClosed ? position.status === 'CLOSED' : position.status === 'ENTERED');
  return <main className="shell">
    <header className="topbar"><span className="brand">ETHCRYPTOHUB</span></header>
    <section className="hero">
      <p className="mono">USER-RECORDED SIGNAL ENTRIES</p>
      <h1>Position records.</h1>
      <p className="muted">These are entries you recorded against signals. They are not exchange positions; the platform does not execute or verify orders.</p>
    </section>
    <ExchangePositionsPanel />
    <section className="card stack">
      <div className="position-toolbar">
        <div className="links" role="group" aria-label="Position record filter">
          <button type="button" className={!showClosed ? '' : 'button-secondary'} onClick={() => setShowClosed(false)}>Open entries</button>
          <button type="button" className={showClosed ? '' : 'button-secondary'} onClick={() => setShowClosed(true)}>Closed history</button>
        </div>
        <button type="button" className="button-secondary" onClick={() => void load()} disabled={loading}>Refresh</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {loading && <p className="muted">Loading your recorded entries…</p>}
      {!loading && !error && visible.length === 0 && <p className="muted">{showClosed ? 'No closed user-recorded entries yet.' : 'No open user-recorded entries yet. Record an entry from signal history.'}</p>}
      {!loading && visible.length > 0 && <div className="scanner-table-wrap"><table className="scan-table position-table">
        <thead><tr><th>Pair</th><th>Mode</th><th>Direction</th><th>Actual entry</th><th>Stop Loss</th><th>TP1 / TP2 / TP3</th><th>Exit / PnL</th><th>Recorded</th><th>Signal</th></tr></thead>
        <tbody>{visible.map((position) => <tr key={position.signal_id}>
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
    </section>
  </main>;
}
