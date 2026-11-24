import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { AdminUsers } from './users';
import { AdminMarketResearch } from './market-research';
import { AdminNotifications } from './notifications';
import { AdminScannerManagement } from './scanner-management';
import { AdminSubscriptions } from './subscriptions';
import { AdminDiagnostics } from './diagnostics';
import { AdminScalping } from './scalping';
import { AdminSignalManagement } from './signal-management';
import { AdminNewsSettings } from './news-settings';
import { AdminWorkerDashboard } from './worker-dashboard';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/dashboard');

  return (
    <main className="shell">
      <section className="hero">
        <p className="mono">SMARTEXIT · RESTRICTED OPERATIONS</p>
        <h1>Admin Command Center</h1>
        <p className="muted">
          Platform supervision, exchange gate controls, quantitative scanner management, user authorization, and system diagnostics.
        </p>
        <div className="links">
          <Link href="/admin/exchanges" className="button">
            Exchange Control
          </Link>
          <Link href="/admin/exchanges/testing" className="button-secondary">
            Demo Testing Lab
          </Link>
          <Link href="/dashboard" className="button-secondary">
            User Dashboard View
          </Link>
        </div>
      </section>

      {/* Admin Quick Jump Bar */}
      <section className="card" style={{ marginBottom: 20, padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="mono" style={{ color: 'var(--text-muted)', marginRight: 6 }}>SECTIONS:</span>
          <a href="#system-diagnostics" className="button-secondary" style={{ padding: '6px 12px', fontSize: 12 }}>
            Diagnostics
          </a>
          <a href="#scanner-management" className="button-secondary" style={{ padding: '6px 12px', fontSize: 12 }}>
            Scanner Coins
          </a>
          <a href="#admin-signal-management" className="button-secondary" style={{ padding: '6px 12px', fontSize: 12 }}>
            Signals
          </a>
          <a href="#admin-subscriptions" className="button-secondary" style={{ padding: '6px 12px', fontSize: 12 }}>
            Subscriptions
          </a>
          <a href="#admin-users" className="button-secondary" style={{ padding: '6px 12px', fontSize: 12 }}>
            Users
          </a>
          <a href="#admin-news" className="button-secondary" style={{ padding: '6px 12px', fontSize: 12 }}>
            News Settings
          </a>
          <a href="#admin-worker-dashboard" className="button-secondary" style={{ padding: '6px 12px', fontSize: 12, border: '1px solid var(--accent)' }}>
            24×7 Worker
          </a>
        </div>
      </section>

      {/* Main Administrative Modules */}
      <div className="stack" style={{ gap: 24 }}>
        <AdminWorkerDashboard />
        <AdminDiagnostics />
        <AdminSubscriptions />
        <AdminNotifications />
        <AdminNewsSettings />
        <AdminScannerManagement />
        <AdminScalping />
        <AdminSignalManagement />
        <AdminMarketResearch />
        <AdminUsers />
      </div>
    </main>
  );
}
