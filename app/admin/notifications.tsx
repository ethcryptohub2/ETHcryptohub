'use client';

import { useEffect, useState } from 'react';

type Settings = {
  enabled: boolean;
  validityMinutes: { '5m': number; '15m': number; '1h': number; '4h': number };
  minimumSetupScore: number;
  highConvictionScore: number;
  entryZoneAtrFraction: number;
};

type Stats = {
  signalsLast24Hours: number;
  unprocessedEvents: number;
  failedPushAttemptsLast24Hours: number;
  sentPushAttemptsLast24Hours: number;
  repeatedSignalScans: number;
  recentFailedPushAttempts: Array<{
    symbol: string;
    event_type: string;
    attempts: number;
    last_error: string | null;
    updated_at: string;
  }>;
};

async function csrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

export function AdminNotifications() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void fetch('/api/admin/notifications', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { data?: { settings: Settings; stats: Stats }; error?: string };
        if (!response.ok || !body.data) throw new Error(body.error ?? 'Notification administration unavailable.');
        if (active) {
          setSettings(body.data.settings);
          setStats(body.data.stats);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Notification administration unavailable.');
      });
    return () => { active = false; };
  }, []);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const csrf = await csrfToken();
      const response = await fetch('/api/admin/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(settings),
      });
      const body = await response.json() as { data?: { settings: Settings }; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Could not save global notification settings.');
      setSettings(body.data.settings);
      setMessage('Global notification settings saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save global notification settings.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="card stack admin-notifications">
    <div><p className="mono">RESTRICTED OPERATIONS</p><h2>Global notifications</h2><p className="muted">Global controls do not override an individual user’s explicit preferences.</p></div>
    {stats && <div className="notification-preference-grid admin-stat-grid">
      <p>Signals · 24h <strong>{stats.signalsLast24Hours}</strong></p>
      <p>Unprocessed events <strong>{stats.unprocessedEvents}</strong></p>
      <p>Push sent · 24h <strong>{stats.sentPushAttemptsLast24Hours}</strong></p>
      <p>Push failed · 24h <strong>{stats.failedPushAttemptsLast24Hours}</strong></p>
      <p>Repeated scans deduplicated <strong>{stats.repeatedSignalScans}</strong></p>
    </div>}
    {stats?.recentFailedPushAttempts.length ? <div className="admin-push-failures">
      <h3>Recent failed push attempts</h3>
      {stats.recentFailedPushAttempts.map((attempt, index) => <p key={`${attempt.updated_at}-${index}`}>
        <strong>{attempt.symbol} · {attempt.event_type.replaceAll('_', ' ')}</strong>
        <span>{attempt.attempts} attempts · {new Date(attempt.updated_at).toLocaleString()}</span>
        {attempt.last_error && <small>{attempt.last_error}</small>}
      </p>)}
    </div> : null}
    {settings && <>
      <label className="notification-toggle"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /> Enable notification delivery globally</label>
      <div className="notification-control-grid">
        {(['5m', '15m', '1h', '4h'] as const).map((timeframe) => <label key={timeframe}>{timeframe} signal validity · minutes <input type="number" min="1" max="1440" value={settings.validityMinutes[timeframe]} onChange={(event) => setSettings({ ...settings, validityMinutes: { ...settings.validityMinutes, [timeframe]: Number(event.target.value) } })} /></label>)}
        <label>Minimum setup score <input type="number" min="0" max="100" value={settings.minimumSetupScore} onChange={(event) => setSettings({ ...settings, minimumSetupScore: Number(event.target.value) })} /></label>
        <label>High conviction score <input type="number" min="0" max="100" value={settings.highConvictionScore} onChange={(event) => setSettings({ ...settings, highConvictionScore: Number(event.target.value) })} /></label>
        <label>Entry zone ATR fraction <input type="number" min="0.01" max="2" step="0.01" value={settings.entryZoneAtrFraction} onChange={(event) => setSettings({ ...settings, entryZoneAtrFraction: Number(event.target.value) })} /></label>
      </div>
      <button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save Global Settings'}</button>
    </>}
    {message && <p className="success" role="status">{message}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <p className="muted">Scheduled scans rotate through the supported timeframes once per minute. Configure a deployment plan that supports Vercel Cron at one-minute intervals; otherwise signal generation and lifecycle updates will be delayed or unavailable.</p>
  </section>;
}
