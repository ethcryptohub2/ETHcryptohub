import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../../lib/auth';
import { ExchangeControl } from './exchange-control';

export const dynamic = 'force-dynamic';

export default async function ExchangeControlPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/dashboard');
  return <main className="shell">
    <header className="topbar">
      <Link className="brand" href="/">ETHCRYPTOHUB · CONTROL</Link>
      <nav className="links"><Link href="/admin/exchanges/testing">Demo/Testnet testing lab</Link><Link href="/admin">Admin</Link><Link href="/dashboard">User view</Link></nav>
    </header>
    <section className="hero">
      <p className="mono">RESTRICTED OPERATIONS · {user.email}</p>
      <h1>Exchange control.</h1>
      <p className="muted">Provider readiness and environment gates. This panel never exposes user API credentials.</p>
    </section>
    <ExchangeControl />
  </main>;
}
