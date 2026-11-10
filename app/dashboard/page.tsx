import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { NotificationsCenter } from './notifications-center';
import { getSubscriptionEntitlement } from '../../lib/subscriptions';
import { SubscriptionPanel } from '../subscription-panel';
import { FuturesBalanceCard } from './futures-balance-card';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const subscription = await getSubscriptionEntitlement(user.id);
  return (
    <main className="shell">
      <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/scanner">Market Scanner</Link><Link href="/settings">Settings</Link><Link href="/binance">Binance API</Link>{user.role === 'admin' && <Link href="/admin">Admin</Link>}</nav></header>
      <section className="hero"><p className="mono">ACCOUNT · {user.role.toUpperCase()}</p><h1>Market intelligence dashboard.</h1><p className="muted">Connected as {user.email}. Review public perpetual-futures market data, manage account details, and configure separate Demo and Live Binance API credentials.</p><div className="links" style={{ marginTop: 24 }}><Link className="button" href="/scanner">Open market scanner</Link><Link href="/settings">Account settings</Link><Link href="/binance">Exchange API setup</Link></div></section>
      <SubscriptionPanel />
      <FuturesBalanceCard />
      {subscription.hasPremiumAccess
        ? <NotificationsCenter />
        : <section id="notifications" className="card stack notification-center">
          <h2>Notifications</h2>
          <p className="muted">News notifications are available to all members. Premium members also receive signal alerts here.</p>
          <Link href="/news">Open crypto news</Link>
        </section>}
      <section className="grid"><article className="card"><p className="mono">ACCOUNT STATUS</p><h2>Verified</h2><p className="muted">Your account is active. Update your account details and security settings at any time.</p></article><article className="card"><p className="mono">MARKET INFORMATION</p><h2>Public feeds</h2><p className="muted">Technical analysis uses Binance USDⓈ-M Futures public data and shows which exchange supplied each scan.</p></article><article className="card"><p className="mono">OPTIONAL DATA ENTRY</p><h2>Demo / Live API</h2><p className="muted">Configure Demo and Live credentials independently. Demo uses virtual funds; Live uses real funds and remains locked unless explicitly approved.</p></article></section>
    </main>
  );
}
