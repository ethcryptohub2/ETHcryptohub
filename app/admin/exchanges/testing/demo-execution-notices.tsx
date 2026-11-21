'use client';

import { useEffect, useState } from 'react';
import type { AdminDemoProvider } from '../../../../lib/admin-demo-provider-contract';
import { projectDemoAuditNotices, type DemoAuditNotice } from '../../../../lib/admin-demo-audit-notifications';

export function DemoExecutionNotices({ provider }: { provider: AdminDemoProvider }) {
  const [monitoring, setMonitoring] = useState(false);
  const [history, setHistory] = useState<DemoAuditNotice[] | null>(null);
  const [toast, setToast] = useState<DemoAuditNotice | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!monitoring) return;
    const lifetime = new AbortController();
    let lastId: bigint | null = null;
    let timer = 0;
    async function refresh() {
      try {
        if (document.visibilityState !== 'visible') return;
        const response = await fetch(`/api/admin/demo/providers/${provider}/history?limit=50`, {
          cache: 'no-store', credentials: 'same-origin',
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(8_000)]),
        });
        const body = await response.json() as { data?: { auditEvents?: unknown } };
        if (lifetime.signal.aborted) return;
        if (!response.ok || !Array.isArray(body.data?.auditEvents)) throw new Error('Demo execution history is unavailable.');
        const notices = projectDemoAuditNotices(provider, body.data.auditEvents);
        const latest = notices.reduce((highest, notice) => BigInt(notice.id) > highest ? BigInt(notice.id) : highest, lastId ?? BigInt(0));
        if (lastId !== null) {
          const unseen = notices.filter(notice => BigInt(notice.id) > lastId!);
          const next = unseen.find(notice => notice.critical) ?? unseen[0];
          if (next) setToast(current => current?.critical && !next.critical ? current : next);
        }
        lastId = latest;
        setHistory(notices);
        setError('');
      } catch {
        if (!lifetime.signal.aborted) setError('Demo execution history is unavailable. Monitoring will retry.');
      } finally {
        if (!lifetime.signal.aborted) timer = window.setTimeout(() => void refresh(), 5_000);
      }
    }
    const start = window.setTimeout(() => void refresh(), 0);
    return () => {
      lifetime.abort();
      window.clearTimeout(start);
      window.clearTimeout(timer);
    };
  }, [monitoring, provider]);

  useEffect(() => {
    if (!toast || toast.critical) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return <section className="card stack" aria-label="Demo execution alerts">
    <h2>Demo execution alerts</h2>
    <button type="button" className="button-secondary" onClick={() => {
      if (monitoring) setToast(null);
      setMonitoring(!monitoring);
    }}>{monitoring ? 'Stop monitoring' : 'Monitor saved execution events'}</button>
    {monitoring && error && <p role="alert">{error}</p>}
    {toast && <div key={toast.id} className={`notification-toast${toast.critical ? ' is-persistent' : ''}`} role={toast.critical ? 'alert' : 'status'}>
      <strong>{toast.label}</strong>
      <button type="button" onClick={() => setToast(null)}>Dismiss</button>
    </div>}
    {history && (history.length ? <ul>{history.map(event => <li key={event.id}>
      {event.label} · <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
    </li>)}</ul> : <p>No saved execution alerts.</p>)}
  </section>;
}
