'use client';

import { useEffect, useState } from 'react';
import { SCALPING_TIMEFRAMES, type HighRiskScalpingSettings, type ScalpingTimeframe } from '../../lib/high-risk-scalping-types';

export function AdminScalping() {
  const [settings, setSettings] = useState<HighRiskScalpingSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('/api/admin/scalping', { cache: 'no-store' })
        .then(async (response) => {
          const body = await response.json() as { data?: HighRiskScalpingSettings; error?: string };
          if (!response.ok || !body.data) throw new Error(body.error ?? 'Scalping settings unavailable.');
          setSettings(body.data);
        })
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Scalping settings unavailable.'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      const csrf = csrfBody.data?.csrfToken;
      if (!csrfResponse.ok || !csrf) throw new Error('Secure admin session unavailable.');
      const response = await fetch('/api/admin/scalping', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(settings),
      });
      const body = await response.json() as { data?: HighRiskScalpingSettings; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Scalping settings could not be saved.');
      setSettings(body.data);
      setNotice('High-risk scalping settings saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Scalping settings could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  function updateTimeframe<K extends 'entryValidityMinutes' | 'signalValidityMinutes'>(
    field: K,
    timeframe: ScalpingTimeframe,
    value: number,
  ) {
    if (!settings) return;
    setSettings({ ...settings, [field]: { ...settings[field], [timeframe]: value } });
  }

  return <section className="card stack" id="admin-scalping">
    <div><p className="mono">ADMIN · SEPARATE STRATEGY</p><h2>High-Risk Scalping</h2>
      <p className="muted">Independent settings; standard signals, thresholds and lifecycle are unchanged. Scheduled scans are best-effort, not real-time.</p></div>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success" role="status">{notice}</p>}
    {!settings && !error && <p className="muted">Loading scalping settings…</p>}
    {settings && <>
      <label className="notification-toggle"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /> Enable independent scalping scanner</label>
      <div className="grid">
        {SCALPING_TIMEFRAMES.map((timeframe) => <label className="notification-toggle" key={timeframe}>
          <input type="checkbox" checked={settings.enabledTimeframes.includes(timeframe)} disabled={settings.enabledTimeframes.length === 1 && settings.enabledTimeframes.includes(timeframe)} onChange={(event) => setSettings({
            ...settings,
            enabledTimeframes: event.target.checked
              ? [...settings.enabledTimeframes, timeframe]
              : settings.enabledTimeframes.filter((item) => item !== timeframe),
          })} /> Enable {timeframe}
        </label>)}
      </div>
      <div className="notification-control-grid">
        <label>Minimum score (50–100)<input type="number" min="50" max="100" value={settings.minimumSetupScore} onChange={(event) => setSettings({ ...settings, minimumSetupScore: Number(event.target.value) })} /></label>
        <label>Minimum 24h quote volume<input type="number" min="0" value={settings.minimumQuoteVolume} onChange={(event) => setSettings({ ...settings, minimumQuoteVolume: Number(event.target.value) })} /></label>
        <label>Minimum relative volume<input type="number" min="1" max="20" step="0.1" value={settings.minimumRelativeVolume} onChange={(event) => setSettings({ ...settings, minimumRelativeVolume: Number(event.target.value) })} /></label>
      </div>
      <div className="notification-control-grid">
        {SCALPING_TIMEFRAMES.map((timeframe) => <label key={`entry-${timeframe}`}>{timeframe} entry window · minutes<input type="number" min="1" max="240" value={settings.entryValidityMinutes[timeframe]} onChange={(event) => updateTimeframe('entryValidityMinutes', timeframe, Number(event.target.value))} /></label>)}
        {SCALPING_TIMEFRAMES.map((timeframe) => <label key={`signal-${timeframe}`}>{timeframe} signal history · minutes<input type="number" min="1" max="240" value={settings.signalValidityMinutes[timeframe]} onChange={(event) => updateTimeframe('signalValidityMinutes', timeframe, Number(event.target.value))} /></label>)}
      </div>
      <p className="scanner-warning"><strong>High-risk notice</strong><span>Signals are informational research only. No trade is placed and high scores do not guarantee profitability.</span></p>
      <button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save scalping settings'}</button>
    </>}
  </section>;
}
