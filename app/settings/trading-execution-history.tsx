'use client';

import { useEffect, useState } from 'react';
import { Pagination } from '../../components/pagination';

type Execution = {
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
  tp1_price: string | null;
  tp2_price: string | null;
  tp3_price: string | null;
  tp1_reached_at: string | null;
  tp2_reached_at: string | null;
  last_reconciled_at: string | null;
  closed_at: string | null;
  protection_status: string;
  realized_pnl: string | null;
  binance_order_id: string | null;
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
  const [strategy, setStrategy] = useState<'ALL' | 'STANDARD' | 'HIGH_RISK_SCALPING'>('ALL');
  const [exchange, setExchange] = useState<'ALL' | Execution['exchange']>('ALL');
  const [direction, setDirection] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [symbol, setSymbol] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ page: String(page) });
    params.set('environment', environment);
    params.set('strategy', strategy);
    params.set('exchange', exchange);
    params.set('direction', direction);
    if (status) params.set('status', status);
    if (symbol.trim()) params.set('symbol', symbol.trim().toUpperCase());
    if (from) params.set('from', from);
    if (to) params.set('to', to);
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
  }, [direction, environment, exchange, from, page, refresh, status, strategy, symbol, to]);

  function riskAtStop(item: Execution) {
    const entry = Number(item.actual_fill_price ?? item.entry_price);
    const stop = Number(item.stop_loss);
    const quantity = Number(item.quantity);
    if (![entry, stop, quantity].every(Number.isFinite)) return null;
    return String(Math.abs(entry - stop) * quantity);
  }

  return <section className="card stack">
    <div><p className="mono">SMARTEXIT · STRATEGY HISTORY</p><h2>Trade execution history</h2>
      <p className="muted">Only actual exchange execution records belonging to your account are shown. Signal outcomes are not presented as exchange fills.</p>
    </div>
    <div className="notification-control-grid">
      <label>Strategy<select value={strategy} onChange={(event) => { setStrategy(event.target.value as typeof strategy); setPage(1); }}>
        <option value="ALL">All strategies</option><option value="STANDARD">Standard</option><option value="HIGH_RISK_SCALPING">High-Risk Scalping</option>
      </select></label>
      <label>Exchange<select value={exchange} onChange={(event) => { setExchange(event.target.value as typeof exchange); setPage(1); }}>
        <option value="ALL">All exchanges</option><option value="BINANCE">Binance</option><option value="BYBIT">Bybit</option><option value="OKX">OKX</option><option value="BITGET">Bitget</option><option value="GATE">Gate.io</option>
      </select></label>
      <label>Environment<select value={environment} onChange={(event) => { setEnvironment(event.target.value as 'ALL' | 'DEMO' | 'LIVE'); setPage(1); }}>
        <option value="ALL">All environments</option><option value="DEMO">Demo · Virtual funds</option><option value="LIVE">Live · Real funds</option>
      </select></label>
      <label>Direction<select value={direction} onChange={(event) => { setDirection(event.target.value as typeof direction); setPage(1); }}>
        <option value="ALL">Long and Short</option><option value="LONG">Long</option><option value="SHORT">Short</option>
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
      <label>From date<input type="date" value={from} max={to || undefined} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label>
      <label>To date<input type="date" value={to} min={from || undefined} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label>
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
          <div><strong>{item.symbol} · {item.side}</strong><p className="muted">{item.strategy === 'STANDARD' ? 'Standard' : 'High-Risk Scalping'} · {item.exchange} · {new Date(item.created_at).toLocaleString()} · {item.execution_mode}</p></div>
          <span className="scanner-signal-badge">{item.environment} · {item.execution_status.replaceAll('_', ' ')}</span>
        </div>
        <div className="signal-detail-grid">
          <div><span>Quantity</span><strong>{display(item.quantity)}</strong></div>
          <div><span>Notional</span><strong>{display(item.notional_usdt)} USDT</strong></div>
          <div><span>Leverage</span><strong>{item.leverage}x</strong></div>
          <div><span>Confirmed entry</span><strong>{item.actual_fill_price && Number(item.actual_fill_price) > 0 ? display(item.actual_fill_price) : 'Pending confirmation'}</strong></div>
          <div><span>Initial risk at stop</span><strong>{display(riskAtStop(item))} USDT</strong></div>
          <div><span>Stop Loss</span><strong>{display(item.stop_loss)}</strong></div>
          <div><span>TP1 / TP2 / TP3</span><strong>{display(item.tp1_price)} / {display(item.tp2_price)} / {display(item.tp3_price)}</strong></div>
          <div><span>TP1 reached</span><strong>{item.tp1_reached_at ? new Date(item.tp1_reached_at).toLocaleString() : 'Not recorded'}</strong></div>
          <div><span>TP2 reached</span><strong>{item.tp2_reached_at ? new Date(item.tp2_reached_at).toLocaleString() : 'Not recorded'}</strong></div>
          <div><span>Protection</span><strong>{item.protection_status}</strong></div>
          <div><span>Last exchange reconciliation</span><strong>{item.last_reconciled_at ? new Date(item.last_reconciled_at).toLocaleString() : 'Not reconciled'}</strong></div>
          {item.closed_at && <div><span>Closed</span><strong>{new Date(item.closed_at).toLocaleString()}</strong></div>}
          <div><span>Order ID</span><strong>{item.binance_order_id ?? '—'}</strong></div>
          <div><span>Realized PnL</span><strong>{display(item.realized_pnl)}</strong></div>
        </div>
        {item.error_message && <p className="error" role="alert">{item.error_message}</p>}
        {item.execution_status === 'PROTECTION_FAILED' && <p className="scanner-warning"><strong>Action required:</strong> immediately check Binance positions, open orders, and algo orders before proceeding.</p>}
      </article>)}
      <Pagination
        page={page}
        totalPages={Math.max(1, Math.ceil(data.total / data.pageSize))}
        totalItems={data.total}
        pageSize={data.pageSize}
        onPageChange={(value) => setPage(value)}
        itemLabel="executions"
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" className="button-secondary" disabled={loading} onClick={() => { setLoading(true); setRefresh((value) => value + 1); }}>Refresh</button>
      </div>
    </div>}
  </section>;
}
