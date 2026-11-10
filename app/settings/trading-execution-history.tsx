'use client';

import { useEffect, useState } from 'react';

type Execution = {
  id: string;
  signal_id: string;
  environment: 'DEMO' | 'LIVE';
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: string;
  notional_usdt: string;
  leverage: number;
  actual_fill_price: string | null;
  stop_loss: string;
  take_profit: string;
  execution_status: string;
  execution_mode: string;
  error_message: string | null;
  created_at: string;
};

type Performance = { total: number; protected: number; failed: number };
type Page = {
  items: Execution[];
  total: number;
  page: number;
  pageSize: number;
  performance: { DEMO: Performance; LIVE: Performance };
};

function display(value: string | null) {
  if (value === null) return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumSignificantDigits: 9 }) : value;
}

export function TradingExecutionHistory() {
  const [data, setData] = useState<Page | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [environment, setEnvironment] = useState<'ALL' | 'DEMO' | 'LIVE'>('ALL');
  const [symbol, setSymbol] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ page: String(page) });
    params.set('environment', environment);
    if (status) params.set('status', status);
    if (symbol.trim()) params.set('symbol', symbol.trim().toUpperCase());
    void fetch(`/api/trading/executions?${params}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { data?: Page; error?: string };
        if (!response.ok || !body.data) throw new Error(body.error ?? 'Execution history unavailable.');
        if (active) {
          setData(body.data);
          setError('');
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Execution history unavailable.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [environment, page, refresh, status, symbol]);

  return <section className="card stack">
    <div><p className="mono">BINANCE FUTURES · DEMO / LIVE ISOLATED</p><h2>Trade execution history</h2>
      <p className="muted">Only executions belonging to your account are shown. Always verify fills and protective orders in Binance.</p>
    </div>
    <div className="notification-control-grid">
      <label>Environment<select value={environment} onChange={(event) => { setEnvironment(event.target.value as 'ALL' | 'DEMO' | 'LIVE'); setPage(1); }}>
        <option value="ALL">All environments</option><option value="DEMO">Demo · Virtual funds</option><option value="LIVE">Live · Real funds</option>
      </select></label>
      <label>Filter by status<select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
        <option value="">All statuses</option>
        <option value="PROTECTED">Protected</option>
        <option value="PROTECTION_FAILED">Protection failed / review required</option>
        <option value="ENTRY_FILLED">Entry filled</option>
        <option value="FAILED">Failed</option>
        <option value="REJECTED">Rejected</option>
      </select></label>
      <label>Filter by pair<input value={symbol} maxLength={30} onChange={(event) => { setSymbol(event.target.value); setPage(1); }} placeholder="BTCUSDT" /></label>
    </div>
    {data && <div className="notification-control-grid">
      {(['DEMO', 'LIVE'] as const).map((env) => <div key={env}>
        <p className="mono">{env === 'DEMO' ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'} STATS</p>
        <p className="muted">Executions {data.performance[env].total} · Protected {data.performance[env].protected} · Failed/review {data.performance[env].failed}</p>
      </div>)}
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    {loading && <p className="muted">Loading executions…</p>}
    {!loading && data?.items.length === 0 && <p className="muted">No trade executions match these filters.</p>}
    {!!data?.items.length && <div className="stack">
      {data.items.map((item) => <article className="card stack" key={item.id}>
        <div className="signal-detail-heading">
          <div><strong>{item.symbol} · {item.side}</strong><p className="muted">{new Date(item.created_at).toLocaleString()} · {item.execution_mode}</p></div>
          <span className="scanner-signal-badge">{item.environment} · {item.execution_status.replaceAll('_', ' ')}</span>
        </div>
        <div className="signal-detail-grid">
          <div><span>Quantity</span><strong>{display(item.quantity)}</strong></div>
          <div><span>Notional</span><strong>{display(item.notional_usdt)} USDT</strong></div>
          <div><span>Leverage</span><strong>{item.leverage}x</strong></div>
          <div><span>Actual fill</span><strong>{display(item.actual_fill_price)}</strong></div>
          <div><span>Stop Loss</span><strong>{display(item.stop_loss)}</strong></div>
          <div><span>Take Profit</span><strong>{display(item.take_profit)}</strong></div>
        </div>
        {item.error_message && <p className="error" role="alert">{item.error_message}</p>}
        {item.execution_status === 'PROTECTION_FAILED' && <p className="scanner-warning"><strong>Action required:</strong> immediately check Binance positions, open orders, and algo orders before proceeding.</p>}
      </article>)}
      <div className="links">
        <button type="button" className="button-secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button>
        <span className="muted">Page {page} · {data.total} total</span>
        <button type="button" className="button-secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage((value) => value + 1)}>Next</button>
        <button type="button" className="button-secondary" disabled={loading} onClick={() => { setLoading(true); setRefresh((value) => value + 1); }}>Refresh</button>
      </div>
    </div>}
  </section>;
}
