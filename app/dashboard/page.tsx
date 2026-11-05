import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { LogoutButton } from '../logout-button';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return (
    <main className="shell">
      <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/scanner">Market Scanner</Link><Link href="/settings">Settings</Link><Link href="/binance">Binance API</Link>{user.role === 'admin' && <Link href="/admin">Admin</Link>}<LogoutButton /></nav></header>
      <section className="hero"><p className="mono">ACCOUNT · {user.role.toUpperCase()}</p><h1>Trading terminal.</h1><p className="muted">Connected as {user.email}. Email verification is active. Live Binance order execution remains disabled.</p><div className="links" style={{ marginTop: 24 }}><Link className="button" href="/scanner">Open live market scanner</Link><Link href="/smartexit">SmartExit</Link><Link href="/settings">Account settings</Link></div></section>
      <section className="grid"><article className="card"><p className="mono">ACCOUNT STATUS</p><h2>Verified</h2><p className="muted">Your account is active and eligible to view the terminal.</p></article><article className="card"><p className="mono">BINANCE FUTURES</p><h2>Public feed</h2><p className="muted">Market information uses public Binance endpoints; private API access is not required for scanning.</p></article><article className="card"><p className="mono">ORDER EXECUTION</p><h2>Disabled</h2><p className="muted">No live orders are sent by this application.</p></article></section>
    </main>
  );
}
