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
export function AdminDiagnostics() {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
    setBusy(true);
    setError('');
    try {
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'System diagnostics could not be loaded.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="card stack admin-diagnostics" id="system-diagnostics">
    <div className="admin-diagnostics-heading">
      <div>
        <p className="mono">ADMIN · SYSTEM HEALTH</p>
        <h2>System diagnostics</h2>
        <p className="muted">Check core configuration, database access, and the last recorded scanner sync.</p>
      </div>
      <div className="links">
        <button type="button" className="button-secondary" disabled={busy || (!report && !error)} onClick={() => void checkAgain()}>
          {busy ? 'Checking…' : 'Refresh diagnostics'}
        </button>
      </div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
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
  </section>;
}
