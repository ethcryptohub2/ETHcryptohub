'use client';

import { useCallback, useEffect, useState } from 'react';

type SignalRow = {
  id: string;
  scanner_type: string;
  symbol: string;
  side: string;
  timeframe: string;
  setup_score: number;
  generated_at: string;
  status: string;
};

type AdminData = {
  stats: {
    summary: Record<string, string>;
    persistenceFailures: Record<string, string>;
    pendingEvents: number;
    duplicatePreventionEvents: number;
    lastSuccessfulWrite: string | null;
    byScanner: Array<Record<string, string>>;
  };
  history: { items: SignalRow[]; total: number; page: number; pageSize: number };
};

export function AdminSignalManagement() {
  const [data, setData] = useState<AdminData | null>(null);
  const [page, setPage] = useState(1);
  const [symbol, setSymbol] = useState('');
  const [scannerType, setScannerType] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    const params = new URLSearchParams({ page: String(page) });
    if (symbol.trim()) params.set('symbol', symbol.trim());
    if (scannerType) params.set('scannerType', scannerType);
    try {
      const response = await fetch(`/api/admin/signals?${params}`, { cache: 'no-store' });
      const body = await response.json() as { data?: AdminData; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Signal management is unavailable.');
      setData(body.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Signal management is unavailable.');
    } finally {
      setBusy(false);
    }
  }, [page, symbol, scannerType]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const summary = data?.stats.summary;
  const failures = data?.stats.persistenceFailures;
  const pageCount = data ? Math.max(1, Math.ceil(data.history.total / data.history.pageSize)) : 1;

  return <section className="card stack admin-signal-management" id="admin-signal-management">
    <div><p className="mono">RESTRICTED OPERATIONS</p><h2>Signal Management</h2><p className="muted">Search and monitor immutable scanner records. Historical records cannot be deleted here.</p></div>
    {summary && failures && <div className="notification-preference-grid admin-stat-grid">
      <p>Total signals stored <strong>{summary.total ?? '0'}</strong></p>
      <p>Generated today <strong>{summary.generated_today ?? '0'}</strong></p>
      <p>Successful target milestones <strong>{summary.successful_targets ?? '0'}</strong></p>
      <p>Active <strong>{summary.active ?? '0'}</strong></p>
      <p>Stop-loss outcomes <strong>{summary.stop_loss ?? '0'}</strong></p>
      <p>Expired / missed / invalidated <strong>{summary.expired ?? '0'} / {summary.missed ?? '0'} / {summary.invalidated ?? '0'}</strong></p>
      <p>Persistence failures · 24h <strong>{failures.last_24_hours ?? '0'}</strong></p>
      <p>Unresolved persistence failures <strong>{failures.unresolved ?? '0'}</strong></p>
      <p>Pending lifecycle/notification events <strong>{data.stats.pendingEvents}</strong></p>
      <p>Repeated Standard scans deduplicated <strong>{data.stats.duplicatePreventionEvents}</strong></p>
      <p>Last successful signal write <strong>{data.stats.lastSuccessfulWrite ? new Date(data.stats.lastSuccessfulWrite).toLocaleString() : '—'}</strong></p>
      {data.stats.byScanner.map((item) => <p key={item.scanner_type}>{item.scanner_type} signals <strong>{item.total}</strong></p>)}
    </div>}
    <div className="signal-history-filters">
      <label>Coin pair<input value={symbol} maxLength={30} placeholder="Search pair" onChange={(event) => { setPage(1); setSymbol(event.target.value); }} /></label>
      <label>Scanner<select value={scannerType} onChange={(event) => { setPage(1); setScannerType(event.target.value); }}><option value="">All scanners</option><option value="STANDARD">Standard</option><option value="HIGH_RISK">High-Risk</option></select></label>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <p className="muted">Loading persisted signal records…</p>}
    {data && <div className="scanner-table-wrap"><table className="scan-table signal-history-table">
      <thead><tr><th>ID</th><th>Generated</th><th>Scanner</th><th>Pair</th><th>Direction</th><th>Timeframe</th><th>Score</th><th>Status</th></tr></thead>
      <tbody>{data.history.items.map((signal) => <tr key={signal.id}><td>{signal.id}</td><td>{new Date(signal.generated_at).toLocaleString()}</td><td>{signal.scanner_type}</td><td>{signal.symbol}</td><td>{signal.side}</td><td>{signal.timeframe}</td><td>{signal.setup_score}</td><td>{signal.status}</td></tr>)}
        {!data.history.items.length && <tr><td colSpan={8}>No matching signals.</td></tr>}</tbody>
    </table></div>}
    {data && <div className="signal-history-pagination"><span>{data.history.total} signals · page {page} of {pageCount}</span><button type="button" className="button-secondary" disabled={page <= 1 || busy} onClick={() => setPage((value) => value - 1)}>Previous</button><button type="button" className="button-secondary" disabled={page >= pageCount || busy} onClick={() => setPage((value) => value + 1)}>Next</button></div>}
  </section>;
}
