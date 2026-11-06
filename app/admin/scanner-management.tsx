'use client';

import { useEffect, useMemo, useState } from 'react';

type ScannerCoin = {
  id: string;
  symbol: string;
  base_asset: string;
  quote_asset: string;
  exchange: string;
  contract_type: string;
  trading_status: string;
  is_enabled: boolean;
  is_admin_disabled: boolean;
  disable_reason: string | null;
  first_listed_at: string | null;
  last_synced_at: string;
  updated_at: string;
};

type AuditEntry = {
  id: string;
  action: string;
  symbol: string | null;
  admin_user_id: number | null;
  reason: string | null;
  created_at: string;
};

type State = {
  coins: ScannerCoin[];
  metrics: { total: number; enabled: number; disabled: number; active: number; inactive: number };
  sync: {
    last_attempt_at: string | null;
    last_success_at: string | null;
    discovered_count: number;
    newly_added_count: number;
    updated_count: number;
    inactive_count: number;
    exchange_status: string;
    last_error: string | null;
  } | null;
  audit: AuditEntry[];
};

type Filter = 'ALL' | 'ENABLED' | 'DISABLED' | 'ACTIVE' | 'INACTIVE';

export function AdminScannerManagement() {
  const [state, setState] = useState<State | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    const response = await fetch('/api/admin/scanner-management', { cache: 'no-store' });
    const body = await response.json() as { data?: State; error?: string };
    if (!response.ok || !body.data) throw new Error(body.error ?? 'Could not load scanner management.');
    setState(body.data);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Scanner management failed to load.'),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const visibleCoins = useMemo(() => (state?.coins ?? []).filter((coin) => {
    if (search && !coin.symbol.includes(search.trim().toUpperCase())) return false;
    if (filter === 'ENABLED' && !(coin.is_enabled && coin.trading_status === 'TRADING')) return false;
    if (filter === 'DISABLED' && coin.is_enabled && coin.trading_status === 'TRADING') return false;
    if (filter === 'ACTIVE' && coin.trading_status !== 'TRADING') return false;
    if (filter === 'INACTIVE' && coin.trading_status === 'TRADING') return false;
    return true;
  }), [filter, search, state]);

  async function mutate(payload: Record<string, unknown>, successMessage: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      const csrf = csrfBody.data?.csrfToken;
      if (!csrfResponse.ok || !csrf) throw new Error('Secure admin session unavailable.');
      const response = await fetch('/api/admin/scanner-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { data?: { added?: number; changed?: number; updated?: number; inactive?: number }; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Scanner management action failed.');
      await load();
      setSelected([]);
      setNotice(payload.action === 'sync_now'
        ? `Sync complete: ${body.data?.added ?? 0} added, ${body.data?.updated ?? 0} updated, ${body.data?.inactive ?? 0} inactive.`
        : body.data?.changed === 0
          ? 'No matching coins needed a status change.'
          : successMessage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Scanner management action failed.');
    } finally {
      setBusy(false);
    }
  }

  function bulk(action: 'enable_selected' | 'disable_selected' | 'enable_all' | 'disable_all') {
    const allCoins = action.endsWith('_all');
    const actionText = action.startsWith('enable') ? 'enable' : 'disable';
    const subject = allCoins ? 'all listed coins' : `${selected.length} selected coins`;
    if (!window.confirm(`Confirm ${actionText} ${subject}? This changes scanner eligibility immediately.`)) return;
    const payload = allCoins
      ? { action, confirm: true }
      : { action, symbols: selected, confirm: true };
    void mutate(payload, `${actionText === 'enable' ? 'Enabled' : 'Disabled'} ${subject}.`);
  }

  function toggleSelected(symbol: string) {
    setSelected((current) => current.includes(symbol)
      ? current.filter((value) => value !== symbol)
      : [...current, symbol]);
  }

  const allVisibleSelected = visibleCoins.length > 0 && visibleCoins.every((coin) => selected.includes(coin.symbol));

  return <section className="card stack scanner-management" id="scanner-management">
    <div className="scanner-management-header">
      <div><p className="mono">ADMIN · MARKET UNIVERSE</p><h2>Scanner Management</h2>
        <p className="muted">Binance USDⓈ-M USDT perpetual contracts are synchronized from official exchange information. Admin-disabled pairs remain disabled across syncs.</p>
      </div>
      <button type="button" disabled={busy} onClick={() => void mutate({ action: 'sync_now' }, '')}>
        {busy ? 'Working…' : 'Sync Now'}
      </button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success" role="status">{notice}</p>}
    {!state && !error && <p className="muted">Loading scanner universe…</p>}
    {state && <>
      <div className="scanner-management-metrics">
        <article><span>Total Futures Pairs</span><strong>{state.metrics.total}</strong></article>
        <article><span>Enabled Pairs</span><strong>{state.metrics.enabled}</strong></article>
        <article><span>Disabled Pairs</span><strong>{state.metrics.disabled}</strong></article>
        <article><span>Active Contracts</span><strong>{state.metrics.active}</strong></article>
        <article><span>Inactive Contracts</span><strong>{state.metrics.inactive}</strong></article>
        <article><span>Last Successful Sync</span><strong>{state.sync?.last_success_at ? new Date(state.sync.last_success_at).toLocaleString() : 'Never'}</strong></article>
      </div>
      <p className={state.sync?.exchange_status === 'ERROR' ? 'error' : 'muted'}>
        Sync status: <strong>{state.sync?.exchange_status ?? 'NEVER_RUN'}</strong>
        {state.sync?.last_error ? ` · ${state.sync.last_error}` : ''}
      </p>
      <div className="scanner-management-toolbar">
        <label>Search symbol<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="e.g. BTCUSDT" /></label>
        <label>Filter<select value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
          <option value="ALL">All pairs</option><option value="ENABLED">Enabled</option><option value="DISABLED">Disabled</option><option value="ACTIVE">Active contracts</option><option value="INACTIVE">Inactive contracts</option>
        </select></label>
        <button type="button" className="button-secondary" disabled={!selected.length || busy} onClick={() => bulk('enable_selected')}>Enable Selected ({selected.length})</button>
        <button type="button" className="button-secondary" disabled={!selected.length || busy} onClick={() => bulk('disable_selected')}>Disable Selected</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={() => bulk('enable_all')}>Enable All Eligible</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={() => bulk('disable_all')}>Disable All Coins</button>
      </div>
      <div className="scanner-management-table-wrap">
        <table className="scanner-management-table">
          <thead><tr>
            <th><input type="checkbox" aria-label="Select visible coins" checked={allVisibleSelected} onChange={() => setSelected((current) => allVisibleSelected
              ? current.filter((symbol) => !visibleCoins.some((coin) => coin.symbol === symbol))
              : [...new Set([...current, ...visibleCoins.map((coin) => coin.symbol)])])} /></th>
            <th>Coin Symbol</th><th>Base</th><th>Quote</th><th>Exchange</th><th>Contract</th><th>Trading</th><th>Scanner</th><th>Updated</th><th>Action</th>
          </tr></thead>
          <tbody>{visibleCoins.map((coin) => {
            const enabled = coin.is_enabled && coin.trading_status === 'TRADING';
            return <tr key={coin.id}>
              <td><input type="checkbox" aria-label={`Select ${coin.symbol}`} checked={selected.includes(coin.symbol)} onChange={() => toggleSelected(coin.symbol)} /></td>
              <td><strong>{coin.symbol}</strong></td><td>{coin.base_asset}</td><td>{coin.quote_asset}</td><td>{coin.exchange}</td><td>{coin.contract_type}</td>
              <td>{coin.trading_status}</td><td><span className={enabled ? 'scanner-management-enabled' : 'scanner-management-disabled'}>{enabled ? 'Enabled' : 'Disabled'}</span>{coin.is_admin_disabled && <small>Admin disabled</small>}</td>
              <td>{new Date(coin.updated_at).toLocaleDateString()}</td>
              <td><button type="button" className="button-secondary" disabled={busy || (!enabled && coin.trading_status !== 'TRADING')} onClick={() => void mutate({
                action: enabled ? 'disable_coin' : 'enable_coin',
                symbol: coin.symbol,
              }, `${coin.symbol} ${enabled ? 'disabled' : 'enabled'}.`)}>{enabled ? 'Disable' : 'Enable'}</button></td>
            </tr>;
          })}</tbody>
        </table>
        {visibleCoins.length === 0 && <p className="muted">No pairs match this filter.</p>}
      </div>
      <div className="stack scanner-audit-list">
        <h3>Recent scanner audit log</h3>
        {state.audit.map((entry) => <p key={entry.id}><span className="mono">{entry.action}</span> {entry.symbol ?? 'universe'} · {new Date(entry.created_at).toLocaleString()}{entry.reason ? ` · ${entry.reason}` : ''}</p>)}
      </div>
    </>}
  </section>;
}
