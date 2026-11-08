'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Summary = {
  total?: string;
  standard?: string;
  high_risk?: string;
  active?: string;
  tp1?: string;
  tp2?: string;
  tp3?: string;
  stop_loss?: string;
  expired?: string;
  missed?: string;
  invalidated?: string;
  tp1_rate?: string | null;
  tp2_rate?: string | null;
  tp3_rate?: string | null;
  entry_success_rate?: string | null;
  average_realized_pnl?: string | null;
  average_simulated_pnl?: string | null;
  average_holding_duration_seconds?: string | null;
};

type Performance = {
  definitions: Record<string, string>;
  summary: Summary;
  byScanner: Array<Record<string, string>>;
  byStrategy: Array<Record<string, string>>;
  byTimeframe: Array<Record<string, string>>;
  bySymbol: Array<Record<string, string>>;
};

const breakdowns: Array<{ title: string; key: keyof Pick<Performance, 'byScanner' | 'byStrategy' | 'byTimeframe' | 'bySymbol'> }> = [
  { title: 'By scanner', key: 'byScanner' },
  { title: 'By strategy', key: 'byStrategy' },
  { title: 'By timeframe', key: 'byTimeframe' },
  { title: 'By coin', key: 'bySymbol' },
];

function columnLabel(key: string) {
  return key.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const cards: Array<[keyof Summary, string]> = [
  ['total', 'Total generated'], ['standard', 'Standard'], ['high_risk', 'High-Risk'],
  ['active', 'Active'], ['tp1', 'TP1 achievements'], ['tp2', 'TP2 achievements'],
  ['tp3', 'TP3 achievements'], ['stop_loss', 'Stop-loss outcomes'],
  ['expired', 'Expired'], ['missed', 'Missed entries'], ['invalidated', 'Invalidated'],
];

export function SignalPerformance() {
  const [data, setData] = useState<Performance | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('/api/signals/performance', { cache: 'no-store' })
        .then(async (response) => {
          const body = await response.json() as { data?: Performance; error?: string };
          if (!response.ok || !body.data) throw new Error(body.error ?? 'Signal performance is unavailable.');
          setData(body.data);
        })
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Signal performance is unavailable.'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return <main className="shell">
    <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/scanner">Scanner</Link><Link href="/scanner/successful">Successful Signals</Link><Link href="/scanner/history">History</Link><Link href="/dashboard">Dashboard</Link></nav></header>
    <section className="hero scanner-hero"><p className="mono">VERIFIED SIGNAL EVENTS · NO FABRICATED PNL</p><h1>Signal Performance</h1><p className="muted">Target hits are milestones; expired signals are excluded from loss and win calculations.</p></section>
    {error && <p className="error" role="alert">{error}</p>}
    {!data && !error && <p className="muted">Loading performance metrics…</p>}
    {data && <>
      <section className="scanner-overview performance-overview">{cards.map(([key, label]) => <article className="scanner-stat-card" key={key}><span className="scanner-stat-label">{label}</span><strong>{data.summary[key] ?? '0'}</strong></article>)}</section>
      <section className="card stack">
        <h2>Rates and PnL</h2>
        <div className="admin-stat-grid performance-rate-grid">
          <p>TP1 achievement rate <strong>{data.summary.tp1_rate ?? '—'}%</strong></p>
          <p>TP2 achievement rate <strong>{data.summary.tp2_rate ?? '—'}%</strong></p>
          <p>TP3 achievement rate <strong>{data.summary.tp3_rate ?? '—'}%</strong></p>
          <p>Entry success rate <strong>{data.summary.entry_success_rate ?? '—'}%</strong></p>
          <p>Avg. user-reported realized PnL <strong>{data.summary.average_realized_pnl ?? 'Not recorded'}</strong></p>
          <p>Avg. simulated PnL <strong>{data.summary.average_simulated_pnl ?? 'Not calculated'}</strong></p>
          <p>Avg. holding duration (sec) <strong>{data.summary.average_holding_duration_seconds ?? '—'}</strong></p>
        </div>
        <p className="muted">{data.definitions.targetRates} {data.definitions.entrySuccessRate} {data.definitions.winRate} {data.definitions.averageRealizedPnl}</p>
      </section>
      <section className="card stack"><h2>Breakdowns</h2>
        {breakdowns.map(({ title, key }) => {
          const rows = data[key];
          const columns = rows[0] ? Object.keys(rows[0]) : [];
          return <section key={key} className="performance-breakdown">
            <h3>{title}</h3>
            {rows.length === 0
              ? <p className="muted">No records yet.</p>
              : <div className="performance-table-wrap"><table className="performance-table">
                <thead><tr>{columns.map((column) => <th key={column} scope="col">{columnLabel(column)}</th>)}</tr></thead>
                <tbody>{rows.map((row, index) => <tr key={`${key}-${index}`}>
                  {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                </tr>)}</tbody>
              </table></div>}
          </section>;
        })}
      </section>
    </>}
  </main>;
}
