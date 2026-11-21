import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../../lib/auth';
import { BacktestWorkspace } from './workspace';

export const dynamic = 'force-dynamic';

export default async function BacktestingPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/dashboard');
  return <main className="shell">
    <header className="hero">
      <nav className="links"><Link href="/admin">Admin</Link><Link href="/scanner">Scanner</Link></nav>
      <h1>Backtesting</h1>
      <p className="muted">Replay supplied signal levels against historical candles. Files and reports stay in this browser.</p>
    </header>
    <BacktestWorkspace />
  </main>;
}
