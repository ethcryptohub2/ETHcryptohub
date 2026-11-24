'use client';

export function AdminWorkerDashboard() {
  return (
    <section className="card stack" id="admin-worker-dashboard" style={{ border: '1px solid var(--accent)' }}>
      <div className="section-header">
        <div>
          <p className="mono">ADMIN · 24×7 EXECUTION ENGINE</p>
          <h2>Automation Worker Supervision</h2>
          <p className="muted">
            Monitors the standalone background process responsible for continuous market scanning, automated Demo order dispatch, and SmartExit trailing protection.
          </p>
        </div>
      </div>

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
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>WORKER DAEMON STATUS</small>
          <strong style={{ fontSize: 16, fontFamily: 'DM Mono', color: '#10b981' }}>
            ● STANDALONE DAEMON
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>scripts/demo-trading-worker.mjs</small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>HOSTING ARCHITECTURE</small>
          <strong style={{ fontSize: 15, fontFamily: 'DM Mono', color: '#f59e0b' }}>
            HOSTING-GATED
          </strong>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>Local workstation or dedicated VM</small>
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
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>HEARTBEAT TELEMETRY</small>
          <span style={{ fontSize: 13, fontFamily: 'DM Mono', color: '#10b981', fontWeight: 600 }}>
            ✓ ATOMIC FILE LOCK & JSON
          </span>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>storage/demo-worker/worker.lock</small>
        </div>

        <div>
          <small className="muted" style={{ display: 'block', fontSize: 11 }}>EMERGENCY KILL-SWITCH</small>
          <span style={{ fontSize: 13, fontFamily: 'DM Mono', color: '#10b981', fontWeight: 600 }}>
            ✓ ACTIVE & ARMED
          </span>
          <small className="muted" style={{ display: 'block', fontSize: 10 }}>storage/demo-worker/kill-switch</small>
        </div>
      </div>

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
