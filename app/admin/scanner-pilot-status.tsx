'use client';

import { useEffect, useState } from 'react';

type Run = { slot_at: string; approved_sha: string; symbols: string[]; state: string; started_at: string;
  finished_at: string | null; failure_code: string | null; quote_observed_at: string | null;
  standard_created: string | null; high_risk_created: string | null;
  outcomes: { symbol: string; candle: string; standard: string; standardReason: string; highRisk: string; highRiskReason: string }[] | null };
type Status = { state: 'OUTSIDE_STAGING' | 'SCHEMA_PENDING' | 'WINDOW_CONFIGURED' | 'DISABLED' | 'STOPPED'; runs: Run[] };

const descriptions: Record<Status['state'], string> = {
  OUTSIDE_STAGING: 'Pilot history is available only on a validated Staging Preview.',
  SCHEMA_PENDING: 'Staging pilot history awaits the separately approved schema installation.',
  WINDOW_CONFIGURED: 'A pilot window is configured. A completed run below is the evidence of execution.',
  DISABLED: 'The automatic Staging pilot is inactive.',
  STOPPED: 'The Staging stop switch is set.',
};

export function ScannerPilotStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/admin/scanner-pilot', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Scanner pilot history unavailable');
        const body = await response.json() as Status;
        setStatus(body);
        setError(false);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [revision]);

  async function stop() {
    setStopping(true);
    setStopError(false);
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrf = (await csrfResponse.json() as { data?: { csrfToken?: string } }).data?.csrfToken;
      if (!csrfResponse.ok || !csrf) throw new Error('CSRF unavailable');
      const response = await fetch('/api/admin/scanner-pilot', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
      if (!response.ok) throw new Error('Pilot stop unavailable');
      setStatus(current => current ? { ...current, state: 'STOPPED' } : current);
      setRevision(value => value + 1);
    } catch {
      setStopError(true);
    } finally {
      setStopping(false);
    }
  }

  return <section className="card stack" aria-label="Automatic Staging pilot">
    <h3>Automatic Staging pilot</h3>
    {error ? <p role="alert">Pilot history could not be read.</p> :
      <p role="status">{status ? descriptions[status.state] : 'Checking saved pilot history…'}</p>}
    <button type="button" className="button-secondary" onClick={() => setRevision(value => value + 1)}>Refresh pilot history</button>
    {status?.state === 'WINDOW_CONFIGURED' && <button type="button" disabled={stopping}
      onClick={() => void stop()}>{stopping ? 'Stopping…' : 'Stop Staging pilot'}</button>}
    {stopError && <p role="alert">Could not verify the Staging stop. Disable the scheduler and review the pilot state.</p>}
    {!!status?.runs.length && <ul>{status.runs.map(run => <li key={run.slot_at}>
      <strong>{run.state}</strong> · {run.symbols.join(', ')} · Slot {run.slot_at}
      {' · '}Started {run.started_at}{run.finished_at && ` · Finished ${run.finished_at}`}
      {' · '}Commit {run.approved_sha.slice(0, 8)}{run.failure_code && ` · ${run.failure_code}`}
      {run.quote_observed_at && <details><summary>Ticker {run.quote_observed_at} · New Standard {run.standard_created} · New High-Risk {run.high_risk_created}</summary>
        <ul>{run.outcomes?.map(row => <li key={row.symbol}>{row.symbol} · Candle {row.candle} ·
          {' '}Standard {row.standard} ({row.standardReason}) · High-Risk {row.highRisk} ({row.highRiskReason})</li>)}</ul>
      </details>}
    </li>)}</ul>}
  </section>;
}
