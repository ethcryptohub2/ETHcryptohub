'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

type SignalItem = {
  id: string;
  scanner_type: 'STANDARD' | 'HIGH_RISK';
  symbol: string;
  side: 'LONG' | 'SHORT';
  timeframe: string;
  strategy_name: string;
  setup_score: number;
  entry_price: string;
  stop_loss: string;
  take_profit_1: string;
  take_profit_2: string;
  take_profit_3: string | null;
  actual_exit_price: string | null;
  realized_pnl: string | null;
  simulated_pnl: string | null;
  generated_at: string;
  entry_expires_at: string;
  status: string;
  entry_status: string;
  achieved_targets: string[];
  first_target_hit_at: string | null;
};

type HistoryData = { items: SignalItem[]; total: number; page: number; pageSize: number };
type Detail = {
  signal: SignalItem;
  events: Array<{ event_type: string; event_price: string | null; event_timestamp: string; payload: Record<string, unknown> }>;
  userEntry: { entry_price: string | null; exit_price: string | null; realized_pnl: string | null; status: 'ENTERED' | 'CLOSED' } | null;
};

function price(value: string | null) {
  if (!value) return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumSignificantDigits: 8 }) : '—';
}

export function SignalHistory({ successfulOnly = false }: { successfulOnly?: boolean }) {
  const [data, setData] = useState<HistoryData | null>(null);
  const [page, setPage] = useState(1);
  const [scannerType, setScannerType] = useState('');
  const [side, setSide] = useState('');
  const [status, setStatus] = useState('');
  const [symbol, setSymbol] = useState('');
  const [selected, setSelected] = useState<Detail | null>(null);
  const [userEntryPrice, setUserEntryPrice] = useState('');
  const [userExitPrice, setUserExitPrice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    const params = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (scannerType) params.set('scannerType', scannerType);
    if (side) params.set('side', side);
    if (status && !successfulOnly) params.set('status', status);
    if (symbol.trim()) params.set('symbol', symbol.trim());
    if (successfulOnly) params.set('successful', 'true');
    try {
      const response = await fetch(`/api/signals/history?${params}`, { cache: 'no-store' });
      const body = await response.json() as { data?: HistoryData; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Signal history could not be loaded.');
      setData(body.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Signal history could not be loaded.');
    } finally {
      setBusy(false);
    }
  }, [page, scannerType, side, status, symbol, successfulOnly]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function showDetails(id: string) {
    setError('');
    try {
      const response = await fetch(`/api/signals/${id}`, { cache: 'no-store' });
      const body = await response.json() as { data?: Detail; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Signal details could not be loaded.');
      setSelected(body.data);
      setUserEntryPrice(body.data.userEntry?.entry_price ?? '');
      setUserExitPrice(body.data.userEntry?.exit_price ?? '');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Signal details could not be loaded.');
    }
  }

  async function saveUserTrade(closeTrade: boolean) {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      if (!csrfResponse.ok || !csrfBody.data?.csrfToken) throw new Error('Secure session unavailable.');
      const response = await fetch(`/api/signals/${selected.signal.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfBody.data.csrfToken },
        body: JSON.stringify(closeTrade
          ? { exitPrice: userExitPrice }
          : { entryPrice: userEntryPrice }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'User-reported trade could not be saved.');
      await showDetails(selected.signal.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'User-reported trade could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const title = successfulOnly ? 'Successful Signals' : 'Signal History';

  return <main className="shell">
    <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/scanner">Scanner</Link><Link href="/scanner/performance">Performance</Link><Link href="/dashboard">Dashboard</Link></nav></header>
    <section className="hero scanner-hero"><p className="mono">PERSISTED SIGNAL RECORDS</p><h1>{title}</h1>
      <p className="muted">{successfulOnly ? 'Target achievements are milestones, not proof of a completed profitable trade.' : 'Generated signals and immutable lifecycle events. Records are retained; filters do not delete data.'}</p>
    </section>
    <section className="card stack">
      <div className="signal-history-filters">
        <label>Scanner<select value={scannerType} onChange={(event) => { setPage(1); setScannerType(event.target.value); }}><option value="">All scanners</option><option value="STANDARD">Standard Signals</option><option value="HIGH_RISK">High-Risk Scalping</option></select></label>
        <label>Direction<select value={side} onChange={(event) => { setPage(1); setSide(event.target.value); }}><option value="">All directions</option><option value="LONG">Long</option><option value="SHORT">Short</option></select></label>
        {!successfulOnly && <label>Lifecycle<select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}><option value="">All states</option>{['ACTIVE', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'COMPLETED', 'STOP_LOSS_HIT', 'EXPIRED', 'MISSED', 'ENTRY_INVALIDATED', 'AMBIGUOUS'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>}
        <label>Coin pair<input value={symbol} maxLength={30} placeholder="e.g. BTCUSDT" onChange={(event) => { setPage(1); setSymbol(event.target.value); }} /></label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {busy && <p className="muted">Loading persisted signals…</p>}
      {!busy && data && <div className="scanner-table-wrap"><table className="scan-table signal-history-table">
        <thead><tr><th>Generated</th><th>Coin</th><th>Scanner</th><th>Direction</th><th>TF</th><th>Entry</th><th>Achieved</th><th>Lifecycle</th><th>Outcome PnL</th><th></th></tr></thead>
        <tbody>{data.items.map((signal) => <tr key={signal.id}>
          <td>{new Date(signal.generated_at).toLocaleString()}</td><td>{signal.symbol}</td><td>{signal.scanner_type === 'HIGH_RISK' ? 'High-Risk' : 'Standard'}</td>
          <td>{signal.side}</td><td>{signal.timeframe}</td><td>{price(signal.entry_price)}</td>
          <td>{signal.achieved_targets.length ? [...new Set(signal.achieved_targets)].join(', ').replaceAll('_HIT', '') : '—'}{signal.first_target_hit_at && <small className="history-target-time">{new Date(signal.first_target_hit_at).toLocaleString()}</small>}</td>
          <td>{signal.status.replaceAll('_', ' ')} · {signal.entry_status}</td>
          <td>{signal.realized_pnl ? `Realized ${signal.realized_pnl}` : signal.simulated_pnl ? `Simulated ${signal.simulated_pnl}` : '—'}</td>
          <td><button className="text-button" type="button" onClick={() => void showDetails(signal.id)}>Details</button></td>
        </tr>)}
        {!data.items.length && <tr><td colSpan={10}>No matching persisted signals.</td></tr>}</tbody>
      </table></div>}
      {data && <div className="signal-history-pagination"><span>{data.total} signals · page {data.page} of {pageCount}</span><button type="button" className="button-secondary" disabled={page <= 1 || busy} onClick={() => setPage((value) => value - 1)}>Previous</button><button type="button" className="button-secondary" disabled={page >= pageCount || busy} onClick={() => setPage((value) => value + 1)}>Next</button></div>}
    </section>
    {selected && <section className="card stack signal-history-detail">
      <div className="signal-detail-heading"><h2>{selected.signal.symbol} · {selected.signal.side} · {selected.signal.timeframe}</h2><button className="button-secondary" type="button" onClick={() => setSelected(null)}>Close</button></div>
      <p className="muted">{selected.signal.scanner_type} · {selected.signal.strategy_name} · status {selected.signal.status}</p>
      <h3>Lifecycle events</h3>
      {selected.events.length ? <ol>{selected.events.map((event, index) => <li key={`${event.event_type}-${event.event_timestamp}-${index}`}>{event.event_type.replaceAll('_', ' ')} · {new Date(event.event_timestamp).toLocaleString()} · price {price(event.event_price)}</li>)}</ol> : <p className="muted">No lifecycle events are recorded yet.</p>}
      <div className="user-trade-record">
        <h3>Your trade record · user-reported, not exchange-verified</h3>
        <p className="muted">Recording a fill does not place or verify an order. Realized PnL uses one underlying unit and excludes leverage, fees and funding.</p>
        {selected.userEntry?.status === 'CLOSED'
          ? <p className="success">Closed · entry {price(selected.userEntry.entry_price)} · exit {price(selected.userEntry.exit_price)} · PnL {price(selected.userEntry.realized_pnl)}</p>
          : <div className="signal-history-filters">
            {!selected.userEntry?.entry_price && <label>Actual entry price<input inputMode="decimal" value={userEntryPrice} onChange={(event) => setUserEntryPrice(event.target.value)} placeholder="User-reported fill" /></label>}
            {selected.userEntry?.entry_price && <p className="muted">Recorded entry price: {price(selected.userEntry.entry_price)}</p>}
            {selected.userEntry?.entry_price && <label>Actual exit price<input inputMode="decimal" value={userExitPrice} onChange={(event) => setUserExitPrice(event.target.value)} placeholder="User-reported fill" /></label>}
            {!selected.userEntry?.entry_price
              ? <button type="button" disabled={busy || !userEntryPrice.trim()} onClick={() => void saveUserTrade(false)}>{busy ? 'Saving…' : 'Record entry fill'}</button>
              : <button type="button" disabled={busy || !userExitPrice.trim()} onClick={() => void saveUserTrade(true)}>{busy ? 'Saving…' : 'Record exit and close trade'}</button>}
          </div>}
      </div>
    </section>}
  </main>;
}
