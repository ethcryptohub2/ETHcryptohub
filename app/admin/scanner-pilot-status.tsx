'use client';

import { useEffect, useState } from 'react';

type Run = { slot_at: string; approved_sha: string; symbols: string[]; state: string; started_at: string;
  finished_at: string | null; failure_code: string | null; quote_observed_at: string | null;
  standard_created: string | null; high_risk_created: string | null;
  outcomes: { symbol: string; candle: string; standard: string; standardReason: string; highRisk: string; highRiskReason: string }[] | null };
type Status = { state: 'OUTSIDE_STAGING' | 'SCHEMA_PENDING' | 'WINDOW_CONFIGURED' | 'DISABLED'; runs: Run[] };

const descriptions: Record<Status['state'], string> = {
  OUTSIDE_STAGING: 'Pilot history is available only on a validated Staging Preview.',
  SCHEMA_PENDING: 'Staging pilot history awaits the separately approved schema installation.',
  WINDOW_CONFIGURED: 'A pilot window is configured. A completed run below is the evidence of execution.',
  DISABLED: 'The automatic Staging pilot is inactive.',
};

export function ScannerPilotStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);

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

  return <section className="card stack" aria-label="Automatic Staging pilot">
    <h3>Automatic Staging pilot</h3>
    {error ? <p role="alert">Pilot history could not be read.</p> :
      <p role="status">{status ? descriptions[status.state] : 'Checking saved pilot history…'}</p>}
    <button type="button" className="button-secondary" onClick={() => setRevision(value => value + 1)}>Refresh pilot history</button>
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
