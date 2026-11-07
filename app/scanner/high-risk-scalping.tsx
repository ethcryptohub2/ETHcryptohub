'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { StoredScalpingSignal } from '../../lib/high-risk-scalping-types';
import { SCALPING_TIMEFRAMES } from '../../lib/high-risk-scalping-types';
import { ScannerTabs } from './scanner-tabs';

type Data = {
  active: StoredScalpingSignal[];
  entered: StoredScalpingSignal[];
  history: StoredScalpingSignal[];
  settings: { enabled: boolean; enabledTimeframes: typeof SCALPING_TIMEFRAMES[number][] };
};

function countdown(target: string, now: number) {
  const remaining = Math.max(0, Date.parse(target) - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
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
  const [pushEnabled, setPushEnabled] = useState(false);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const response = await fetch('/api/scalping', { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json() as { data?: Data; error?: string; code?: string };
    if (!response.ok || !body.data) {
      if (body.code === 'SUBSCRIPTION_REQUIRED') throw new Error('An active trial or premium subscription is required for scalping signals.');
      throw new Error(body.error ?? 'High-risk scalping data is unavailable.');
    }
    setData(body.data);
    setNow(Date.now());
  }, []);

  const loadPreference = useCallback(async () => {
    const response = await fetch('/api/scalping/preferences', { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json() as { data?: { pushEnabled: boolean }; error?: string };
    if (!response.ok || !body.data) throw new Error(body.error ?? 'Scalping notification preference is unavailable.');
    setPushEnabled(body.data.pushEnabled);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void Promise.all([load(), loadPreference()]).catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'High-risk scalping is unavailable.'),
      );
    }, 0);
    const refresh = window.setInterval(() => {
      void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Scalping refresh failed.'));
    }, 30_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(refresh);
      window.clearInterval(clock);
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
        <strong className="scanner-signal-badge">{signal.score}/100</strong>
      </div>
      <p className="error">HIGH RISK · Informational research only. No orders are placed; a score does not guarantee results.</p>
      <div className="scanner-price-grid">
        <div className="scanner-price-cell"><span>Entry reference</span><strong>{formatPrice(signal.entryPrice)}</strong><small>{formatPrice(signal.entryZoneLow)} – {formatPrice(signal.entryZoneHigh)}</small></div>
        <div className="scanner-price-cell is-stop"><span>Invalidation / stop reference</span><strong>{formatPrice(signal.stop)}</strong></div>
        <div className="scanner-price-cell"><span>Targets · 1R / 1.5R</span><strong>{formatPrice(signal.tp1)} / {formatPrice(signal.tp2)}</strong></div>
      </div>
      <p className="muted">RSI {signal.context.rsi.toFixed(1)} · Relative volume {signal.context.relativeVolume.toFixed(2)}× · ADX {signal.context.adx.toFixed(1)} · BTC {signal.context.btcDirection}</p>
      {entered
        ? <p className="success">Marked entered by you · generated {new Date(signal.generatedAt).toLocaleString()}. This record stays in your entered list after countdown expiry.</p>
        : <div className="links"><span className="muted">Entry window {countdown(signal.entryExpiresAt, now)} · signal expiry {new Date(signal.expiresAt).toLocaleTimeString()}</span>
          <button type="button" disabled={busy !== '' || Date.parse(signal.entryExpiresAt) <= now} onClick={() => void markEntered(signal.id)}>
            {busy === signal.id ? 'Saving…' : 'Mark as entered'}
          </button>
        </div>}
    </article>;
  }

  return <main className="shell">
    <ScannerTabs active={activeTab} onChange={onTabChange} />
    <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/scanner/successful">Successful Signals</Link><Link href="/scanner/history">Signal History</Link><Link href="/scanner/performance">Performance</Link><Link href="/dashboard">Dashboard</Link><Link href="/settings">Settings</Link>{isAdmin && <Link href="/admin">Admin</Link>}</nav></header>
    <section className="hero scanner-hero">
      <p className="mono">SEPARATE STRATEGY · SERVERLESS BEST-EFFORT SCANS</p>
      <h1>High-Risk Scalping</h1>
      <p className="muted">Independent short-timeframe research. A five-minute scheduled scan can be delayed, so 1m/3m opportunities may be missed; this is not a real-time feed.</p>
    </section>
    <section className="card stack">
      <div className="links">
        <p className="muted">{data?.settings.enabled ? `Enabled timeframes: ${SCALPING_TIMEFRAMES.filter((timeframe) => data.settings.enabledTimeframes.includes(timeframe)).join(', ') || 'none'}` : 'Scalping signals are disabled by an administrator.'}</p>
        <button type="button" className="button-secondary" disabled={busy !== ''} onClick={() => void togglePush()}>
          {pushEnabled ? 'Disable scalping alerts' : 'Enable scalping alerts'}
        </button>
      </div>
      <p className="scanner-warning"><strong>Schedule limitation</strong><span>GitHub Actions runs approximately every five minutes and may run late. Expiry and invalidation are recorded on the next successful run, not continuously.</span></p>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="success" role="status">{notice}</p>}
      {!data && !error && <p className="muted">Loading scalping opportunities…</p>}
    </section>
    {data && <>
      <section className="stack scalping-signal-section"><h2>Active opportunities <span className="mono">{data.active.length}</span></h2>
        {data.active.length ? data.active.map((signal) => signalCard(signal)) : <p className="scanner-empty"><strong>No active setups</strong><span>A setup appears only after the configured breakout, trend, momentum and volume checks pass.</span></p>}
      </section>
      {data.entered.length > 0 && <section className="stack scalping-signal-section"><h2>Marked entered</h2>{data.entered.map((signal) => signalCard(signal, true))}</section>}
      <details className="card stack"><summary>Scalping history · {data.history.length}</summary>
        {data.history.length
          ? data.history.map((signal) => <p key={signal.id}>{signal.symbol} {signal.side} · {signal.timeframe} · {signal.lifecycleStatus} · {new Date(signal.generatedAt).toLocaleString()}</p>)
          : <p className="muted">No closed scalping signals yet.</p>}
      </details>
    </>}
  </main>;
}
