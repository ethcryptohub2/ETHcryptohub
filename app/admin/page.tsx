import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { AdminUsers } from './users';
import { AdminMarketResearch } from './market-research';
import { AdminNotifications } from './notifications';
import { AdminScannerManagement } from './scanner-management';
import { AdminSubscriptions } from './subscriptions';

export const dynamic = 'force-dynamic';
export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/dashboard');
  return <main className="shell"><header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB · CONTROL</Link><nav className="links"><Link href="/dashboard">User view</Link><Link href="/admin#scanner-management">Manage coins</Link><Link href="/admin#admin-users">Manage users</Link><Link href="/settings">Account settings</Link></nav></header><section className="hero"><p className="mono">RESTRICTED OPERATIONS · {user.email}</p><h1>Command center.</h1><p className="muted">Manage subscriptions and the live scanner universe, verified identities, account access, research providers, and notification delivery.</p></section><AdminSubscriptions /><AdminNotifications /><AdminScannerManagement /><AdminMarketResearch /><AdminUsers /></main>;
}
