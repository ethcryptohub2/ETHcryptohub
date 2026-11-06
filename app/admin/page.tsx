import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { AdminUsers } from './users';
import { AdminMarketResearch } from './market-research';

export const dynamic = 'force-dynamic';
export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/dashboard');
  return <main className="shell"><header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB · CONTROL</Link><nav className="links"><Link href="/dashboard">User view</Link><Link href="/settings">Settings</Link></nav></header><section className="hero"><p className="mono">RESTRICTED OPERATIONS · {user.email}</p><h1>Command center.</h1><p className="muted">Manage verified identities, account access, and market research provider keys.</p></section><AdminMarketResearch /><AdminUsers /></main>;
}
