'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WorkerHealthResult } from '../../lib/worker-lease';

type ExchangeProvider = {
  exchange: 'BINANCE' | 'BYBIT' | 'OKX' | 'BITGET' | 'GATE';
  name: string;
  customer_enabled: boolean;
  adapter_version: string;
  demo_verified_at: string | null;
  testnet_verified_at: string | null;
  environments: Array<{
    environment: 'DEMO' | 'TESTNET' | 'LIVE';
    enabled: boolean;
    supported: boolean;
    customerTradingReady: boolean;
    configuredAccounts: number;
  }>;
};

export function AdminWorkerDashboard() {
  const [health, setHealth] = useState<WorkerHealthResult | null>(null);
  const [providers, setProviders] = useState<ExchangeProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [updatingProvider, setUpdatingProvider] = useState<string | null>(null);
  const [error, setError] = useState('');

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [healthRes, exchangesRes] = await Promise.all([
        fetch('/api/admin/worker-health', { cache: 'no-store' }),
        fetch('/api/admin/exchanges', { cache: 'no-store' }),
      ]);

      const healthBody = (await healthRes.json()) as { ok?: boolean; data?: WorkerHealthResult; error?: string };
      if (healthRes.ok && healthBody.data) {
        setHealth(healthBody.data);
      }

      const exchangesBody = (await exchangesRes.json()) as { data?: ExchangeProvider[]; error?: string };
      if (exchangesRes.ok && exchangesBody.data) {
        setProviders(exchangesBody.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to query telemetry.');
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleCustomerAccess = async (exchange: string, current: boolean) => {
    setUpdatingProvider(exchange);
    try {
      const csrfRes = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = (await csrfRes.json()) as { data?: { csrfToken: string } };
      const csrf = csrfBody.data?.csrfToken;

      const res = await fetch('/api/admin/exchanges', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({
          type: 'customer',
          exchange,
          enabled: !current,
        }),
      });

      if (!res.ok) throw new Error('Failed to update exchange setting.');
      await fetchHealth();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed.');
    } finally {
      setUpdatingProvider(null);
    }
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [healthRes, exchangesRes] = await Promise.all([
          fetch('/api/admin/worker-health', { cache: 'no-store' }),
          fetch('/api/admin/exchanges', { cache: 'no-store' }),
        ]);

        const healthBody = (await healthRes.json()) as { ok?: boolean; data?: WorkerHealthResult; error?: string };
        if (active && healthRes.ok && healthBody.data) {
          setHealth(healthBody.data);
        }

        const exchangesBody = (await exchangesRes.json()) as { data?: ExchangeProvider[]; error?: string };
        if (active && exchangesRes.ok && exchangesBody.data) {
          setProviders(exchangesBody.data);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to query telemetry.');
      }
    };
    void load();
    const interval = window.setInterval(load, 15_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const isOnline = health?.status === 'ONLINE';
  const isDegraded = health?.status === 'DEGRADED';
  const isDormant = health?.status === 'DORMANT';
  const lease = health?.lease;
  const consecutiveFailures = Number(lease?.consecutiveFailures ?? 0);
  const protectionFailures = Number(lease?.protectionFailures ?? 0);
  const hasActiveTelemetry = isOnline || isDegraded;

  return (
    <section className="card stack" id="admin-worker-dashboard" style={{ border: '1px solid var(--accent)' }}>
      <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <p className="mono">ADMIN · 24×7 EXECUTION ENGINE &amp; EXCHANGES</p>
          <h2 style={{ margin: 0 }}>Automation Worker Supervision</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Monitors standalone daemon processes responsible for continuous scanning, automated Demo order dispatch, and SmartExit trailing protection.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="button-secondary"
            onClick={() => void fetchHealth()}
            disabled={loading}
            style={{ fontSize: 12, padding: '6px 14px' }}
          >
            {loading ? 'Checking…' : '⟳ Refresh Telemetry'}
          </button>
        </div>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {/* Honest Worker Status Telemetry */}
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
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>WORKER LEASE TELEMETRY</small>
          <strong
            style={{
              fontSize: 16,
              fontFamily: 'DM Mono',
              color: isOnline ? '#10b981' : isDegraded ? '#f59e0b' : isDormant ? '#ef4444' : '#6b7280',
            }}
          >
            {isOnline
              ? '● ACTIVE DAEMON ONLINE'
              : isDegraded
                ? '● DEGRADED / ERRORS'
                : isDormant
                  ? '○ LEASE EXPIRED / DORMANT'
                  : '○ OFFLINE / NO ACTIVE LEASE'}
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>
            {hasActiveTelemetry
              ? `Lease verified (${lease?.hostname}${lease?.safeMode ? ' · SafeMode' : ''})`
              : 'Awaiting running background daemon process'}
          </small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>WORKER PID / HOST</small>
          <strong style={{ fontSize: 15, fontFamily: 'DM Mono', color: 'var(--text)' }}>
            {hasActiveTelemetry && lease?.pid ? `PID ${lease.pid} (${lease.hostname})` : 'Not running'}
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>
            {lease?.workerId ?? 'scripts/demo-trading-worker.mjs'}
          </small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>HEARTBEAT &amp; TICKS</small>
          <strong style={{ fontSize: 15, fontFamily: 'DM Mono', color: isOnline ? '#10b981' : isDegraded ? '#f59e0b' : 'var(--text-muted)' }}>
            {lease?.tickCount ? `${lease.tickCount} ticks recorded` : '0 ticks recorded'}
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>
            {lease?.heartbeatAt ? `Last HB: ${new Date(lease.heartbeatAt).toLocaleString()}` : 'No heartbeat recorded'}
          </small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>TRADING ENVIRONMENT</small>
          <strong style={{ fontSize: 15, fontFamily: 'DM Mono', color: 'var(--accent)' }}>
            {lease?.safeMode ? 'DEMO (SAFE MODE)' : 'DEMO / TESTNET ONLY'}
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>Real-money LIVE locked (HTTP 403)</small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>PRODUCTION CRON</small>
          <strong style={{ fontSize: 15, fontFamily: 'DM Mono', color: '#6b7280' }}>
            DISABLED BY POLICY
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>Zero unauthorized cloud cron charges</small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>ACTIVE SCANNER CYCLE</small>
          <strong style={{ fontSize: 14, fontFamily: 'DM Mono', color: 'var(--text)' }}>
            {lease?.activeCycle ?? 'No scan cycle recorded'}
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>
            {lease?.batchProgress ?? 'Awaiting first batch'} · Scanned pairs: {lease?.scannedPairsCount ?? 0}
          </small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>LAST SUCCESSFUL SCAN</small>
          <strong style={{ fontSize: 14, fontFamily: 'DM Mono', color: lease?.lastSuccessfulScanAt ? '#10b981' : 'var(--text-muted)' }}>
            {lease?.lastScanDurationMs !== undefined
              ? `${lease.lastScanDurationMs}ms latency`
              : 'No successful scan yet'}
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>
            {lease?.lastSuccessfulScanAt
              ? `${new Date(lease.lastSuccessfulScanAt).toLocaleTimeString()} · Pairs: ${lease.lastCandidateCount ?? 0} · Qualified: ${lease.lastQualifiedCount ?? 0}`
              : 'Candidates: 0 · Qualified: 0'}
          </small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>DEMO TRADES &amp; EXECUTION</small>
          <strong style={{ fontSize: 14, fontFamily: 'DM Mono', color: 'var(--accent)' }}>
            {lease?.totalTradesExecuted ?? 0} executed
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>
            Mode: {lease?.exchangeExecutionStatus ?? 'OFFLINE'}
          </small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>SCAN &amp; PROTECTION FAILURES</small>
          <strong style={{ fontSize: 14, fontFamily: 'DM Mono', color: (protectionFailures > 0 || consecutiveFailures > 0) ? '#ef4444' : '#10b981' }}>
            {protectionFailures} protection · {consecutiveFailures} tick errors
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>
            {lease?.lastError ? lease.lastError.slice(0, 72) : 'No active execution errors'}
          </small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>EMERGENCY STOP STATUS</small>
          <strong style={{ fontSize: 14, fontFamily: 'DM Mono', color: lease?.emergencyStopStatus === 'ARMED' ? '#ef4444' : '#10b981' }}>
            {lease?.emergencyStopStatus ?? 'CLEAR'}
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>Blocks new entries; preserves open protection</small>
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

      {/* Admin Exchange Controls Table */}
      <div style={{ marginTop: 8 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Admin Exchange Provider Controls</h3>
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
          Manage provider availability, sandbox demo permissions, and customer accessibility across all 5 integrated exchange adapters.
        </p>
        <div className="scanner-table-wrap">
          <table className="scan-table position-table">
            <thead>
              <tr>
                <th>Exchange</th>
                <th>Adapter Version</th>
                <th>Environment</th>
                <th>Demo Sandbox</th>
                <th>Customer Access</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {providers.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 16 }}>
                    Loading exchange providers…
                  </td>
                </tr>
              ) : (
                providers.map((p) => {
                  const demoEnv = p.environments.find((e) => e.environment === 'DEMO' || e.environment === 'TESTNET');
                  const isBusy = updatingProvider === p.exchange;
                  return (
                    <tr key={p.exchange}>
                      <td>
                        <strong>{p.name}</strong>
                        <small style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)' }}>{p.exchange}</small>
                      </td>
                      <td>
                        <span className="mono" style={{ fontSize: 11 }}>{p.adapter_version}</span>
                      </td>
                      <td>
                        <span className="mono" style={{ fontSize: 11 }}>{demoEnv?.environment ?? 'DEMO'}</span>
                      </td>
                      <td>
                        <span
                          style={{
                            padding: '2px 6px',
                            borderRadius: 4,
                            fontSize: 10,
                            fontWeight: 600,
                            fontFamily: 'DM Mono',
                            background: demoEnv?.enabled ? '#f0fdf4' : 'var(--surface-raised)',
                            color: demoEnv?.enabled ? '#166534' : 'var(--text-muted)',
                          }}
                        >
                          {demoEnv?.enabled ? 'AVAILABLE' : 'STANDBY'}
                        </span>
                      </td>
                      <td>
                        <span
                          style={{
                            padding: '2px 6px',
                            borderRadius: 4,
                            fontSize: 10,
                            fontWeight: 600,
                            fontFamily: 'DM Mono',
                            background: p.customer_enabled ? '#f0fdf4' : 'var(--surface-raised)',
                            color: p.customer_enabled ? '#166534' : 'var(--text-muted)',
                          }}
                        >
                          {p.customer_enabled ? 'ENABLED' : 'DISABLED'}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => void toggleCustomerAccess(p.exchange, p.customer_enabled)}
                          disabled={isBusy}
                          style={{ fontSize: 11, padding: '4px 10px' }}
                        >
                          {isBusy ? 'Saving…' : p.customer_enabled ? 'Disable' : 'Enable'}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ padding: '12px 16px', background: 'var(--surface-sunken)', borderRadius: 6, fontSize: 12 }}>
        <strong style={{ display: 'block', marginBottom: 4 }}>Unattended Background Daemon Instructions:</strong>
        <p className="muted" style={{ margin: '0 0 6px 0' }}>
          To run continuous 24×7 scanning and automated trade dispatch independently of browser sessions:
        </p>
        <code className="mono" style={{ display: 'block', padding: 8, background: 'var(--background)', borderRadius: 4, marginBottom: 6 }}>
          Windows SafeMode: powershell -ExecutionPolicy RemoteSigned -File .\scripts\start-local-worker.ps1 -SafeMode -Continuous
        </code>
        <code className="mono" style={{ display: 'block', padding: 8, background: 'var(--background)', borderRadius: 4, marginBottom: 6 }}>
          Linux / VM Daemon: node --import tsx scripts/demo-trading-worker.mjs
        </code>
        <code className="mono" style={{ display: 'block', padding: 8, background: 'var(--background)', borderRadius: 4 }}>
          Docker Daemon: docker build -f Dockerfile.worker -t smartexit-worker . &amp;&amp; docker run -d --name smartexit-worker --env-file worker.env smartexit-worker
        </code>
      </div>
    </section>
  );
}
