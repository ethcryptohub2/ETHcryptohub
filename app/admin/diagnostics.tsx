'use client';

import { useCallback, useEffect, useState } from 'react';

type DiagnosticCheck = {
  id: string;
  label: string;
  status: 'ok' | 'warning' | 'error';
  detail: string;
  recommendation?: string;
};

type DiagnosticReport = { checks: DiagnosticCheck[]; checkedAt: string };
type ScannerActionResponse = {
  data?: { added?: number; updated?: number; inactive?: number; candidates?: number; timeframe?: string };
  error?: string;
};

async function scannerAction(csrfToken: string, action: 'sync_now' | 'scan_now') {
  const response = await fetch('/api/admin/scanner-management', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ action }),
  });
  const body = await response.json() as ScannerActionResponse;
  if (!response.ok || !body.data) throw new Error(body.error ?? `${action === 'sync_now' ? 'Universe sync' : 'Scanner run'} failed.`);
  return body.data;
}

export function AdminDiagnostics() {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [busy, setBusy] = useState<'check' | 'recover' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const response = await fetch('/api/admin/diagnostics', { cache: 'no-store' });
    const body = await response.json() as { data?: DiagnosticReport; error?: string };
    if (!response.ok || !body.data) throw new Error(body.error ?? 'System diagnostics could not be loaded.');
    setReport(body.data);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'System diagnostics could not be loaded.'),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function checkAgain() {
    setBusy('check');
    setError('');
    setNotice('');
    try {
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'System diagnostics could not be loaded.');
    } finally {
      setBusy(null);
    }
  }

  async function recoverScanner() {
    if (!window.confirm('Sync the Binance pair list and run one scanner pass? This does not place or execute trades.')) return;
    setBusy('recover');
    setError('');
    setNotice('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      const csrfToken = csrfBody.data?.csrfToken;
      if (!csrfResponse.ok || !csrfToken) throw new Error('Secure admin session unavailable.');

      const sync = await scannerAction(csrfToken, 'sync_now');
      let scan: Awaited<ReturnType<typeof scannerAction>>;
      try {
        scan = await scannerAction(csrfToken, 'scan_now');
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : 'Unknown scanner error.';
        throw new Error(`Pair sync succeeded, but the scanner run failed: ${detail}`);
      }

      await load();
      setNotice(`Recovery finished: ${sync.added ?? 0} pairs added, ${sync.updated ?? 0} updated; ${scan.candidates ?? 0} candidates evaluated on ${scan.timeframe ?? '15m'}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Safe scanner recovery failed.');
      await load().catch((loadReason: unknown) => {
        setError((current) => `${current} Diagnostics refresh also failed: ${loadReason instanceof Error ? loadReason.message : 'Unknown error.'}`);
      });
    } finally {
      setBusy(null);
    }
  }

  return <section className="card stack admin-diagnostics" id="system-diagnostics">
    <div className="admin-diagnostics-heading">
      <div>
        <p className="mono">ADMIN · SYSTEM HEALTH</p>
        <h2>Diagnostics &amp; recovery</h2>
        <p className="muted">Check core configuration, database access, Binance connectivity, and the last scanner sync. Unknown server issues need investigation; they cannot be safely repaired by a generic button.</p>
      </div>
      <div className="links">
        <button type="button" className="button-secondary" disabled={busy !== null} onClick={() => void checkAgain()}>
          {busy === 'check' ? 'Checking…' : 'Run diagnostics'}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void recoverScanner()}>
          {busy === 'recover' ? 'Recovering…' : 'Attempt safe scanner recovery'}
        </button>
      </div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success" role="status">{notice}</p>}
    {!report && !error && <p className="muted">Checking system health…</p>}
    {report && <>
      <p className="mono">LAST CHECKED {new Date(report.checkedAt).toLocaleString()}</p>
      <div className="admin-diagnostic-list">
        {report.checks.map((check) => <article className={`admin-diagnostic-item is-${check.status}`} key={check.id}>
          <div className="admin-diagnostic-title">
            <strong>{check.label}</strong>
            <span>{check.status.toUpperCase()}</span>
          </div>
          <p>{check.detail}</p>
          {check.recommendation && <p className="muted">{check.recommendation}</p>}
        </article>)}
      </div>
    </>}
    <p className="muted admin-diagnostics-note">Safe recovery only updates the scanner pair list and runs one signal scan. It never places trades or changes account settings.</p>
  </section>;
}
