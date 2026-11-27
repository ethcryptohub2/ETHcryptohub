import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { NotificationsCenter } from './notifications-center';
import { getSubscriptionEntitlement } from '../../lib/subscriptions';
import { SubscriptionPanel } from '../subscription-panel';
import { FuturesBalanceCard } from './futures-balance-card';
import { isCredentialEncryptionConfigured } from '../../lib/binance-credentials';
import { isBinanceBalanceReadAllowed, isStagingDemoTarget } from '../../lib/binance-demo-access';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  let user;
  try {
    user = await currentUser();
  } catch {
    user = null;
  }
  if (!user) redirect('/login');

  let subscription;
  try {
    subscription = await getSubscriptionEntitlement(user.id, { reconcile: false });
  } catch {
    subscription = null;
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="mono">SMARTEXIT · QUANTITATIVE TRADING INTELLIGENCE</p>
        <h1>Trading Dashboard</h1>
        <p className="muted">
          Welcome back, {user.email}. Real-time market scanner, automated indicator confluence, and risk-controlled Demo execution.
        </p>
        <div className="links">
          <Link className="button" href="/scanner">
            Open Market Scanner
          </Link>
          <Link className="button-secondary" href="/positions">
            Open Positions
          </Link>
          <Link className="button-secondary" href="/binance">
            Exchange Connections
          </Link>
          {user.role === 'admin' && (
            <Link className="button-secondary" href="/admin">
              Admin Command Center
            </Link>
          )}
        </div>
      </section>

      {/* Financial Metrics Cards */}
      <section className="grid" style={{ marginBottom: 20 }}>
        <article className="card">
          <p className="mono">EXECUTION ENVIRONMENTS</p>
          <h2 style={{ margin: '8px 0', fontSize: 20, color: '#10b981' }}>Exchange Demo Only (Active)</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            <strong>[EXCHANGE DEMO]:</strong> Remote signed API execution across 5 connected exchanges.<br />
            <strong>[ZERO SIMULATION]:</strong> No internal paper wallets or artificial balances.<br />
            <strong>[LIVE TRADING]:</strong> Locked fail-closed (HTTP 403) for complete safety.
          </p>
        </article>

        <article className="card">
          <p className="mono">MARKET SCANNER STATUS</p>
          <h2 style={{ margin: '8px 0', fontSize: 20 }}>500+ Contracts Active</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Continuous algorithmic confluence scan across all 522 active Binance USDⓈ-M perpetual Futures.
          </p>
        </article>

        <article className="card">
          <p className="mono">MEMBERSHIP ACCESS</p>
          <h2 style={{ margin: '8px 0', fontSize: 20 }}>
            {subscription?.status === 'PREMIUM_ACTIVE' ? 'Premium Active' :
              subscription?.status === 'FREE_TRIAL' ? 'Free Trial Active' :
              subscription?.status === 'TRIAL_EXPIRED' ? 'Free Trial Expired' :
              subscription?.status === 'PREMIUM_EXPIRED' ? 'Premium Expired' : 'Membership Status Unavailable'}
          </h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {subscription?.hasPremiumAccess ? 'Your membership includes market signals and trading alerts.' :
              'An active trial or subscription is required for market signals.'}
          </p>
        </article>

        <article className="card">
          <p className="mono">INFRASTRUCTURE REGION</p>
          <h2 style={{ margin: '8px 0', fontSize: 20 }}>
            {isStagingDemoTarget() ? 'Staging · Sydney (ap-southeast-2)' : 'Primary Cloud Region'}
          </h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {isStagingDemoTarget()
              ? 'Render web frontend integrated with persistent Northflank London market scanner & Demo engine, backed by isolated Staging Supabase.'
              : 'Connected directly to isolated primary Supabase cluster and market-data engine.'}
          </p>
        </article>
      </section>

      {/* Signals Quick Action Banner */}
      <section className="card" style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <span className="mono" style={{ color: 'var(--accent)' }}>● LIVE SIGNALS DETECTED</span>
          <h3 style={{ margin: '6px 0 4px', fontSize: 18 }}>High-Conviction Technical Setups Ready</h3>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            View qualified entry zones, invalidation stop losses, and multi-target profit levels on the scanner.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Link href="/scanner" className="button">
            View Live Setups
          </Link>
          <Link href="/scanner/history" className="button-secondary">
            Signal History
          </Link>
        </div>
      </section>

      {/* Balance Card */}
      <FuturesBalanceCard
        signedReadEnabled={isBinanceBalanceReadAllowed('DEMO') && isCredentialEncryptionConfigured()}
      />

      {/* Subscription Panel */}
      <SubscriptionPanel />

      {/* Notifications */}
      {subscription?.hasPremiumAccess ? (
        <NotificationsCenter />
      ) : (
        <section id="notifications" className="card stack">
          <h2>Notifications</h2>
          <p className="muted">
            News notifications are available to all members. Premium members also receive instant real-time signal alerts here.
          </p>
          <Link href="/news" className="button-secondary" style={{ width: 'fit-content' }}>
            Open Crypto News
          </Link>
        </section>
      )}

      {/* Security and Architectural Assurance Grid */}
      <section className="grid" style={{ marginTop: 20 }}>
        <article className="card">
          <p className="mono">EXCHANGE CONNECTIVITY</p>
          <h3 style={{ margin: '8px 0 6px' }}>Multi-Exchange Gateway</h3>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Connect Binance, Bybit, OKX, Bitget, and Gate.io Demo / Testnet APIs with client-side encrypted credentials.
          </p>
        </article>

        <article className="card">
          <p className="mono">SAFETY LOCKS</p>
          <h3 style={{ margin: '8px 0 6px' }}>Fail-Closed Live Trading</h3>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Live order execution is strictly blocked by both database policies and API guards. Zero real-capital risk.
          </p>
        </article>

        <article className="card">
          <p className="mono">DATA INTEGRITY</p>
          <h3 style={{ margin: '8px 0 6px' }}>Complete Isolation</h3>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            All 74 database tables are protected with strict Row-Level Security (RLS) ensuring strict customer isolation.
          </p>
        </article>
      </section>
    </main>
  );
}
