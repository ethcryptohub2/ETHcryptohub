'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { StoredScalpingSignal } from '../../lib/high-risk-scalping-types';
import { SCALPING_TIMEFRAMES } from '../../lib/high-risk-scalping-types';
import { formatSignalStatusText, highRiskEntryWindowOpen } from '../../lib/high-risk-scalping-status';
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
  return value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
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
  const request = useRef<AbortController | null>(null);
  const now = clock.serverAt + clock.elapsed;

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const startedAt = performance.now();
    try {
      const response = await fetch('/api/scalping', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const body = await response.json() as { data?: Data; error?: string; code?: string };
      if (controller.signal.aborted) return;
      if (!response.ok || !body.data || !Number.isSafeInteger(body.data.serverNow) || body.data.serverNow <= 0) {
        if (body.code === 'SUBSCRIPTION_REQUIRED') throw new Error('An active trial or premium subscription is required for scalping signals.');
        throw new Error(body.error ?? 'High-risk scalping data is unavailable.');
      }
      const receivedAt = performance.now();
      setClock({ serverAt: body.data.serverNow + receivedAt - startedAt, receivedAt, elapsed: 0 });
      setData(body.data);
      setLoadError('');
    } catch (reason) {
      if (controller.signal.aborted) return;
      setData(null);
      setLoadError(reason instanceof Error ? reason.message : 'Scalping refresh failed.');
    } finally {
      if (request.current === controller) request.current = null;
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
    const refresh = window.setInterval(() => {
      void load();
    }, 30_000);
    const updateClock = () => {
      const current = performance.now();
      setClock((previous) => ({ ...previous, elapsed: current - previous.receivedAt }));
    };
    const clockTimer = window.setInterval(updateClock, 1000);
    document.addEventListener('visibilitychange', updateClock);
    return () => {
      request.current?.abort();
      window.clearTimeout(initial);
      window.clearInterval(refresh);
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

  function signalCard(signal: StoredScalpingSignal, entered = false) {
    return <article className={`scanner-signal-card ${signal.side === 'LONG' ? 'is-long' : 'is-short'}`} key={signal.id}>
      <div className="scanner-signal-header">
        <div><p className="mono">HIGH RISK · {signal.timeframe}</p><h3>{signal.symbol} · {signal.side}</h3></div>
        <div className="scanner-card-meta">
          <div className="scanner-card-score"><span>STATUS · {formatSignalStatusText(signal.lifecycleStatus)}</span><small>Generated {new Date(signal.generatedAt).toLocaleString()}</small></div>
          <strong className="scanner-signal-badge">{signal.score}/100</strong>
        </div>
      </div>
      <p className="error">HIGH RISK · Informational research only. No orders are placed; a score does not guarantee results.</p>
      <div className="scanner-price-grid">
        <div className="scanner-price-cell"><span>Entry reference</span><strong>{formatPrice(signal.entryPrice)}</strong><small>{formatPrice(signal.entryZoneLow)} – {formatPrice(signal.entryZoneHigh)}</small></div>
        <div className="scanner-price-cell is-stop"><span>Invalidation / stop reference</span><strong>{formatPrice(signal.stop)}</strong></div>
        <div className="scanner-price-cell"><span>Targets · TP1 1R / TP2 1.5R</span><strong>{formatPrice(signal.tp1)} / {formatPrice(signal.tp2)}</strong><small>TP3 is not configured.</small></div>
      </div>
      <p className="muted">RSI {signal.context.rsi.toFixed(1)} · Relative volume {signal.context.relativeVolume.toFixed(2)}× · ADX {signal.context.adx.toFixed(1)} · BTC {signal.context.btcDirection}</p>
      {entered
        ? <p className="success">{signal.userState === 'CLOSED' ? 'This recorded entry is closed.' : 'Marked entered by you.'}</p>
        : <div className="links"><span className="muted">Entry window {countdown(Math.min(Date.parse(signal.entryExpiresAt), Date.parse(signal.expiresAt)), now)} · signal expiry {new Date(signal.expiresAt).toLocaleTimeString()}</span>
          <button type="button" disabled={busy !== ''} onClick={() => void markEntered(signal.id)}>
            {busy === signal.id ? 'Saving…' : 'Mark as entered'}
          </button>
        </div>}
    </article>;
  }

  const active = data?.active.filter((signal) => highRiskEntryWindowOpen(signal, now)) ?? [];
  const recentlyClosed = data?.active.filter((signal) => !highRiskEntryWindowOpen(signal, now)) ?? [];
  const history = [...recentlyClosed, ...(data?.history ?? [])];

  return <main className="shell">
    <ScannerTabs active={activeTab} onChange={onTabChange} />
    <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/scanner/successful">Successful Signals</Link><Link href="/scanner/history">Signal History</Link><Link href="/scanner/performance">Performance</Link><Link href="/dashboard">Dashboard</Link><Link href="/settings">Settings</Link>{isAdmin && <Link href="/admin">Admin</Link>}</nav></header>
    <section className="hero scanner-hero">
      <p className="mono">SEPARATE STRATEGY · SERVERLESS BEST-EFFORT SCANS</p>
      <h1>High-Risk Scalping</h1>
      <p className="muted">Independent short-timeframe research from saved scanner results. Short-lived opportunities may expire between scans.</p>
      <p className="scanner-research-target" role="note">High-Risk research target: 95% win rate · unverified objective, not an achieved result.</p>
    </section>
    <section className="card stack">
      <div className="links">
        <p className="muted">{!data ? 'Scalping settings unavailable.' : data.settings.enabled ? `Enabled timeframes: ${SCALPING_TIMEFRAMES.filter((timeframe) => data.settings.enabledTimeframes.includes(timeframe)).join(', ') || 'none'}` : 'Scalping signals are disabled by an administrator.'}</p>
        <button type="button" className="button-secondary" disabled={busy !== '' || pushEnabled === null} onClick={() => void togglePush()}>
          {pushEnabled === null ? 'Scalping alert preference unavailable' : pushEnabled ? 'Disable scalping alerts' : 'Enable scalping alerts'}
        </button>
      </div>
      <p className="scanner-warning"><strong>Saved signal status</strong><span>Entry controls close at the expiry time. The recorded lifecycle can update on a later scan.</span></p>
      {loadError && <p className="error" role="alert">{loadError}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="success" role="status">{notice}</p>}
      {!data && !loadError && <p className="muted">Loading scalping opportunities…</p>}
    </section>
    {data && <>
      <section className="stack scalping-signal-section"><h2>Active opportunities <span className="mono">{active.length}</span></h2>
        {active.length ? active.map((signal) => signalCard(signal)) : <p className="scanner-empty"><strong>No active setups</strong><span>A setup appears only after the configured breakout, trend, momentum and volume checks pass.</span></p>}
      </section>
      {data.entered.length > 0 && <section className="stack scalping-signal-section"><h2>Recorded entries</h2>{data.entered.map((signal) => signalCard(signal, true))}</section>}
      <details className="card stack"><summary>Scalping history · {history.length}</summary>
        {history.length
            ? history.map((signal) => <p key={signal.id}>{signal.symbol} {signal.side} · {signal.timeframe} · Entry unavailable · Last recorded status {formatSignalStatusText(signal.lifecycleStatus)} · {new Date(signal.generatedAt).toLocaleString()}</p>)
          : <p className="muted">No closed scalping signals yet.</p>}
      </details>
    </>}
  </main>;
}
