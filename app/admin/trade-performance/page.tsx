import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../../lib/auth';
import { TradePerformanceView } from './trade-performance-view';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TradePerformancePage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/dashboard');

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/">ETHCRYPTOHUB · CONTROL</Link>
        <nav className="links">
          <Link href="/admin">Command Center</Link>
          <Link href="/admin/exchanges">Exchange Control</Link>
          <Link href="/admin/exchanges/testing">Demo Lab</Link>
          <Link href="/dashboard">Trader View</Link>
        </nav>
      </header>

      <TradePerformanceView adminEmail={user.email} />
    </main>
  );
}
