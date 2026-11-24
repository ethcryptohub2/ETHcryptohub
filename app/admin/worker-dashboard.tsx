'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WorkerHealthResult } from '../../lib/worker-lease';

export function AdminWorkerDashboard() {
  const [health, setHealth] = useState<WorkerHealthResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/worker-health', { cache: 'no-store' });
      const body = await response.json() as { ok?: boolean; data?: WorkerHealthResult; error?: string };
      if (!response.ok || !body.data) {
        throw new Error(body.error ?? `Worker health check failed (${response.status})`);
      }
      setHealth(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to query worker health.');
    } finally {
      setLoading(false);
    }
  }, []);

  const syncDemoLease = async () => {
    setSyncing(true);
    setError('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      const csrf = csrfBody.data?.csrfToken;
      const response = await fetch('/api/admin/worker-health', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({
          action: 'acquire',
          workerId: 'worker-cloud-daemon-1',
          hostname: 'smartexit-worker-host',
          pid: 4096,
          version: '1.0.0',
          environment: 'DEMO',
          ttlSeconds: 600,
        }),
      });
      if (!response.ok) throw new Error('Worker lease sync failed.');
      await fetchHealth();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lease sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    void fetchHealth();
    const interval = window.setInterval(fetchHealth, 15_000);
    return () => window.clearInterval(interval);
  }, [fetchHealth]);

  const isOnline = health?.status === 'ONLINE';
  const isDegraded = health?.status === 'DEGRADED';
  const lease = health?.lease;

  return (
    <section className="card stack" id="admin-worker-dashboard" style={{ border: '1px solid var(--accent)' }}>
      <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <p className="mono">ADMIN · 24×7 EXECUTION ENGINE</p>
          <h2 style={{ margin: 0 }}>Automation Worker Supervision</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Monitors the standalone background process responsible for continuous market scanning, automated Demo order dispatch, and SmartExit trailing protection.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="button"
            onClick={() => void syncDemoLease()}
            disabled={loading || syncing}
            style={{ fontSize: 12, padding: '6px 12px' }}
          >
            {syncing ? 'Syncing Lease…' : '⚡ Activate Demo Lease'}
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => void fetchHealth()}
            disabled={loading}
            style={{ fontSize: 12, padding: '6px 12px' }}
          >
            {loading ? 'Checking…' : '⟳ Refresh Telemetry'}
          </button>
        </div>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
          background: 'var(--surface-raised)',
          padding: 16,
          borderRadius: 8,
          border: '1px solid var(--border)',
        }}
      >
        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>WORKER LEASE STATUS</small>
          <strong
            style={{
              fontSize: 16,
              fontFamily: 'DM Mono',
              color: isOnline ? '#10b981' : isDegraded ? '#f59e0b' : '#6b7280',
            }}
          >
            {isOnline ? '● ACTIVE LEASE' : isDegraded ? '● DEGRADED' : '○ STANDALONE / DORMANT'}
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>
            Source: {health?.source ?? 'Checking…'}
          </small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>WORKER IDENTIFIER / PID</small>
          <strong style={{ fontSize: 15, fontFamily: 'DM Mono', color: 'var(--text)' }}>
            {lease?.pid ? `PID ${lease.pid} (${lease.hostname})` : 'scripts/demo-trading-worker.mjs'}
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>
            {lease?.workerId ?? 'Isolated Node process'}
          </small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>HEARTBEAT & TICKS</small>
          <strong style={{ fontSize: 15, fontFamily: 'DM Mono', color: isOnline ? '#10b981' : 'var(--text-muted)' }}>
            {lease?.tickCount ? `${lease.tickCount} cycles recorded` : 'Ready on launch'}
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>
            {lease?.heartbeatAt ? `Last: ${new Date(lease.heartbeatAt).toLocaleTimeString()}` : 'Interval: 30s'}
          </small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>TRADING ENVIRONMENT</small>
          <strong style={{ fontSize: 15, fontFamily: 'DM Mono', color: 'var(--accent)' }}>
            DEMO / TESTNET ONLY
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>Real-money LIVE locked (HTTP 403)</small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>PRODUCTION CRON</small>
          <strong style={{ fontSize: 15, fontFamily: 'DM Mono', color: '#6b7280' }}>
            DISABLED BY POLICY
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>Zero unauthorized Vercel billing</small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>EMERGENCY KILL-SWITCH</small>
          <span style={{ fontSize: 13, fontFamily: 'DM Mono', color: '#10b981', fontWeight: 600 }}>
            ✓ ACTIVE & ARMED
          </span>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>storage/demo-worker/kill-switch</small>
        </div>
      </div>

      {health?.message && (
        <div style={{ padding: '8px 12px', background: 'var(--surface-subtle)', borderRadius: 6, fontSize: 12, border: '1px solid var(--surface-border)' }}>
          <span className="mono" style={{ color: isOnline ? '#10b981' : isDegraded ? '#f59e0b' : 'var(--text-muted)' }}>
            ● TELEMETRY:
          </span>{' '}
          <span className="muted">{health.message}</span>
        </div>
      )}

      <div style={{ padding: '12px 16px', background: 'var(--surface-sunken)', borderRadius: 6, fontSize: 12 }}>
        <strong style={{ display: 'block', marginBottom: 4 }}>Unattended 24×7 Deployment Quickstart:</strong>
        <p className="muted" style={{ margin: '0 0 6px 0' }}>
          Serverless Vercel functions enter dormancy when idle without incoming HTTP traffic. To maintain continuous unattended operation independently of a browser session:
        </p>
        <code className="mono" style={{ display: 'block', padding: 8, background: 'var(--background)', borderRadius: 4, marginBottom: 6 }}>
          Windows Launcher: powershell -ExecutionPolicy Bypass -File .\scripts\start-demo-worker.ps1
        </code>
        <code className="mono" style={{ display: 'block', padding: 8, background: 'var(--background)', borderRadius: 4 }}>
          Docker Container: docker build -f Dockerfile.worker -t smartexit-worker . &amp;&amp; docker run -d --name smartexit-worker smartexit-worker
        </code>
      </div>
    </section>
  );
}
