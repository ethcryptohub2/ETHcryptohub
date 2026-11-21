'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { StoredScalpingSignal } from '../../lib/high-risk-scalping-types';
import { SCALPING_TIMEFRAMES } from '../../lib/high-risk-scalping-types';
import { formatSignalStatusText, highRiskEntryWindowOpen } from '../../lib/high-risk-scalping-status';
import { TABLE_PAGE_SIZE } from '../../lib/pagination';
import { ScannerTabs } from './scanner-tabs';

type Data = {
  active: StoredScalpingSignal[];
  entered: StoredScalpingSignal[];
  history: StoredScalpingSignal[];
  settings: { enabled: boolean; enabledTimeframes: typeof SCALPING_TIMEFRAMES[number][] };
  serverNow: number;
};

function countdown(target: number, now: number) {
  const remaining = Math.ceil(Math.max(0, target - now) / 1000);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatPrice(value: number) {
  return Number.isFinite(value) && value > 0
    ? value.toLocaleString(undefined, { maximumSignificantDigits: 8 })
    : 'Unavailable';
}

export function HighRiskScalping({
  activeTab,
  onTabChange,
  isAdmin,
}: {
  activeTab: 'standard' | 'scalping';
  onTabChange: (tab: 'standard' | 'scalping') => void;
  isAdmin: boolean;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null);
  const [clock, setClock] = useState({ serverAt: 0, receivedAt: 0, elapsed: 0 });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'active' | 'entered' | 'history'>('active');
  const [symbol, setSymbol] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [direction, setDirection] = useState('');
  const [page, setPage] = useState(1);
  const request = useRef<AbortController | null>(null);
  const now = clock.serverAt + clock.elapsed;

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setLoadError('');
    const startedAt = performance.now();
    try {
      const response = await fetch('/api/scalping', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const body = await response.json() as { data?: Data; error?: string; code?: string };
      if (controller.signal.aborted) return;
      if (!response.ok || !body.data || !Number.isSafeInteger(body.data.serverNow) || body.data.serverNow <= 0) {
        if (response.status === 401 || response.status === 403) setData(null);
        if (body.code === 'SUBSCRIPTION_REQUIRED') throw new Error('An active trial or premium subscription is required for scalping signals.');
        throw new Error(body.error ?? 'High-risk scalping data is unavailable.');
      }
      const receivedAt = performance.now();
      setClock({ serverAt: body.data.serverNow + receivedAt - startedAt, receivedAt, elapsed: 0 });
      setData(body.data);
      setLoadError('');
    } catch (reason) {
      if (controller.signal.aborted) return;
      setLoadError(reason instanceof Error ? reason.message : 'Scalping refresh failed.');
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }, []);

  const loadPreference = useCallback(async () => {
    const response = await fetch('/api/scalping/preferences', { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json() as { data?: { pushEnabled: boolean }; error?: string };
    if (!response.ok || !body.data) throw new Error(body.error ?? 'Scalping notification preference is unavailable.');
    setPushEnabled(body.data.pushEnabled);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void load();
      void loadPreference().catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Scalping alert preference is unavailable.'),
      );
    }, 0);
    const updateClock = () => {
      const current = performance.now();
      setClock((previous) => ({ ...previous, elapsed: current - previous.receivedAt }));
    };
    const clockTimer = window.setInterval(updateClock, 1000);
    document.addEventListener('visibilitychange', updateClock);
    return () => {
      request.current?.abort();
      window.clearTimeout(initial);
      window.clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', updateClock);
    };
  }, [load, loadPreference]);

  async function markEntered(signalId: string) {
    setBusy(signalId);
    setError('');
    setNotice('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      const csrf = csrfBody.data?.csrfToken;
      if (!csrfResponse.ok || !csrf) throw new Error('Secure session unavailable.');
      const response = await fetch('/api/scalping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ action: 'mark_entered', signalId }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Entry status could not be saved.');
      await load();
      setNotice('Marked as entered for your account. No order was placed.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Entry status could not be saved.');
    } finally {
      setBusy('');
    }
  }

  async function togglePush() {
    if (pushEnabled === null) return;
    setBusy('push');
    setError('');
    setNotice('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      const csrf = csrfBody.data?.csrfToken;
      if (!csrfResponse.ok || !csrf) throw new Error('Secure session unavailable.');
      const response = await fetch('/api/scalping/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ pushEnabled: !pushEnabled }),
      });
      const body = await response.json() as { data?: { pushEnabled: boolean }; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Could not update scalping notifications.');
      setPushEnabled(body.data.pushEnabled);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update scalping notifications.');
    } finally {
      setBusy('');
    }
  }

  function signalCard(signal: StoredScalpingSignal) {
    const generatedAt = Date.parse(signal.generatedAt);
    const age = Number.isFinite(generatedAt) && now >= generatedAt
      ? `${Math.floor((now - generatedAt) / 60_000)}m ago`
      : null;
    const context = signal.context;
    const status = view === 'history' && signal.lifecycleStatus === 'ACTIVE'
      ? 'Entry unavailable'
      : formatSignalStatusText(signal.lifecycleStatus);
    const indicators = [
      Number.isFinite(context?.rsi) && `RSI ${context.rsi.toFixed(1)}`,
      Number.isFinite(context?.relativeVolume) && `Relative volume ${context.relativeVolume.toFixed(2)}×`,
      Number.isFinite(context?.adx) && `ADX ${context.adx.toFixed(1)}`,
      context?.btcDirection && `BTC ${context.btcDirection}`,
    ].filter(Boolean);
    return <article className={`scanner-signal-card ${signal.side === 'LONG' ? 'is-long' : 'is-short'}`} key={signal.id}>
      <div className="scanner-signal-header">
        <div><p className="mono">HIGH RISK · {signal.timeframe}</p><h3>{signal.symbol} · {signal.side}</h3></div>
        <div className="scanner-card-meta">
          <div className="scanner-card-score"><span>STATUS · {status}</span><small>Generated {new Date(signal.generatedAt).toLocaleString()}{age && ` · ${age}`}</small></div>
          <strong className="scanner-signal-badge">{signal.score}/100</strong>
        </div>
      </div>
      <p className="error">HIGH RISK · Informational research only. No orders are placed; a score does not guarantee results.</p>
      <div className="scanner-price-grid">
        <div className="scanner-price-cell"><span>Last recorded market price</span><strong>{formatPrice(signal.lastPrice)}</strong></div>
        <div className="scanner-price-cell"><span>Entry reference</span><strong>{formatPrice(signal.entryPrice)}</strong><small>{formatPrice(signal.entryZoneLow)} – {formatPrice(signal.entryZoneHigh)}</small></div>
        <div className="scanner-price-cell is-stop"><span>Invalidation / stop reference</span><strong>{formatPrice(signal.stop)}</strong></div>
        <div className="scanner-price-cell"><span>Targets · TP1 / TP2</span><strong>{formatPrice(signal.tp1)} / {formatPrice(signal.tp2)}</strong><small>TP3 · {signal.tp3 == null ? 'Not recorded' : formatPrice(signal.tp3)}</small></div>
      </div>
      {indicators.length > 0 && <p className="muted">{indicators.join(' · ')}</p>}
      <p className="muted">Signal expiry {new Date(signal.expiresAt).toLocaleString()}</p>
      {view === 'entered'
        ? <p className="success">{signal.userState === 'CLOSED' ? 'This recorded entry is closed.' : 'Marked entered by you.'}</p>
        : view === 'active' && <div className="links"><span className="muted">Entry window {countdown(Math.min(Date.parse(signal.entryExpiresAt), Date.parse(signal.expiresAt)), now)}</span>
          <button type="button" disabled={busy !== '' || !!loadError || loading} onClick={() => void markEntered(signal.id)}>
            {busy === signal.id ? 'Saving…' : 'Mark as entered'}
          </button>
        </div>}
    </article>;
  }

  const active = data?.active.filter((signal) => highRiskEntryWindowOpen(signal, now)) ?? [];
  const recentlyClosed = data?.active.filter((signal) => !highRiskEntryWindowOpen(signal, now)) ?? [];
  const history = [...recentlyClosed, ...(data?.history ?? [])].sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  const results = (view === 'active' ? active : view === 'entered' ? data?.entered ?? [] : history)
    .filter((signal) => signal.symbol.startsWith(symbol.trim().toUpperCase()) &&
      (!timeframe || timeframe === signal.timeframe) && (!direction || direction === signal.side));
  const totalPages = Math.max(1, Math.ceil(results.length / TABLE_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visibleSignals = results.slice((currentPage - 1) * TABLE_PAGE_SIZE, currentPage * TABLE_PAGE_SIZE);

  return <main className="shell">
    <ScannerTabs active={activeTab} onChange={onTabChange} />
    <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/scanner/successful">Successful Signals</Link><Link href="/dashboard">Dashboard</Link><Link href="/settings">Settings</Link>{isAdmin && <Link href="/admin">Admin</Link>}</nav></header>
    <section className="hero scanner-hero">
      <p className="mono">HIGH RISK · SAVED SIGNALS</p>
      <h1>High-Risk Scalping</h1>
      <p className="muted">Independent short-timeframe research from saved scanner results. Short-lived opportunities may expire between scans.</p>
    </section>
    <section className="card stack">
      <div className="links">
        {data && <p className="muted">{data.settings.enabled ? `Enabled timeframes: ${SCALPING_TIMEFRAMES.filter((timeframe) => data.settings.enabledTimeframes.includes(timeframe)).join(', ') || 'none'}` : 'Scalping signal generation is disabled in the saved settings.'}</p>}
        <button type="button" className="button-secondary" disabled={loading} onClick={() => void load()}>{loading ? 'Loading saved signals…' : 'Refresh saved signals'}</button>
        <button type="button" className="button-secondary" disabled={busy !== '' || pushEnabled === null} onClick={() => void togglePush()}>
          {pushEnabled === null ? 'Scalping alert preference unavailable' : pushEnabled ? 'Disable scalping alerts' : 'Enable scalping alerts'}
        </button>
      </div>
      <p className="scanner-warning"><strong>Saved signal status</strong><span>Entry controls close at the expiry time. The recorded lifecycle can update on a later scan.</span></p>
      {loadError && <p className="error" role="alert">{loadError}{data && ' Showing the last loaded records.'}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="success" role="status">{notice}</p>}
      {!data && !loadError && <p className="muted">Loading scalping opportunities…</p>}
    </section>
    <section className="card stack"><h2>High-Risk setups</h2>
      <p className="muted">Browse the latest 200 saved High-Risk signal records. Refresh reads saved records without requesting new market data.</p>
      <nav className="links" aria-label="High-Risk signal records">
        <Link href="/scanner/history?scannerType=HIGH_RISK">High-Risk Signal History</Link>
        <Link href="/scanner/performance">Signal Performance</Link>
      </nav>
      <div className="links">
        <label>View<select value={view} onChange={(event) => { setPage(1); setView(event.target.value as typeof view); }}><option value="active">Active opportunities</option><option value="entered">Recorded entries</option><option value="history">Inactive and expired</option></select></label>
        <label>Symbol<input value={symbol} maxLength={25} onChange={(event) => { setPage(1); setSymbol(event.target.value); }} /></label>
        <label>Timeframe<select value={timeframe} onChange={(event) => { setPage(1); setTimeframe(event.target.value); }}><option value="">All timeframes</option>{SCALPING_TIMEFRAMES.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Direction<select value={direction} onChange={(event) => { setPage(1); setDirection(event.target.value); }}><option value="">Both directions</option><option>LONG</option><option>SHORT</option></select></label>
      </div>
    </section>
    {data && <section className="stack scalping-signal-section">
      {visibleSignals.length > 0 ? visibleSignals.map(signalCard) : <p className="scanner-empty"><strong>{view === 'active' && active.length === 0 ? 'No qualified setups' : 'No matching saved records'}</strong><span>{view === 'active' && active.length === 0 ? 'No saved High-Risk setup has an open entry window.' : 'Choose a different view or adjust the filters.'}</span></p>}
      {visibleSignals.length > 0 && <nav className="links" aria-label="High-Risk setup pagination">
        <button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
        <span>Page {currentPage} of {totalPages} · {results.length} matching records</span>
        <button type="button" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>Next</button>
      </nav>}
    </section>}
  </main>;
}
