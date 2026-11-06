import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { LogoutButton } from '../logout-button';
import { NotificationsCenter } from './notifications-center';
import { getSubscriptionEntitlement } from '../../lib/subscriptions';
import { SubscriptionPanel } from '../subscription-panel';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const subscription = await getSubscriptionEntitlement(user.id);
  return (
    <main className="shell">
      <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/scanner">Market Scanner</Link><Link href="/settings">Settings</Link><Link href="/binance">Binance API</Link>{user.role === 'admin' && <Link href="/admin">Admin</Link>}<LogoutButton /></nav></header>
      <section className="hero"><p className="mono">ACCOUNT · {user.role.toUpperCase()}</p><h1>Market intelligence dashboard.</h1><p className="muted">Connected as {user.email}. Review public perpetual-futures market data, manage account details, and optionally enter read-only exchange API credentials.</p><div className="links" style={{ marginTop: 24 }}><Link className="button" href="/scanner">Open market scanner</Link><Link href="/settings">Account settings</Link><Link href="/binance">Exchange API setup</Link></div></section>
      <SubscriptionPanel />
      {subscription.hasPremiumAccess && <NotificationsCenter />}
      <section className="grid"><article className="card"><p className="mono">ACCOUNT STATUS</p><h2>Verified</h2><p className="muted">Your account is active. Update your account details and security settings at any time.</p></article><article className="card"><p className="mono">MARKET INFORMATION</p><h2>Public feeds</h2><p className="muted">Technical analysis uses public perpetual-futures data and shows which exchange supplied each scan.</p></article><article className="card"><p className="mono">OPTIONAL DATA ENTRY</p><h2>Read-only API</h2><p className="muted">You can enter Binance API credentials to check account connectivity. Use read-only permissions; this app does not place orders.</p></article></section>
    </main>
  );
}
