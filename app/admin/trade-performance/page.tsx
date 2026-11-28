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
      <header className="topbar perf-no-print" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Link className="brand" href="/">ETHCRYPTOHUB · CONTROL</Link>
        <nav className="links" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Link href="/admin">Command Center</Link>
          <Link href="/admin/trade-performance" style={{ fontWeight: 700, color: '#10b981' }}>Trade Performance</Link>
          <Link href="/admin/exchanges">Exchange Control</Link>
          <Link href="/admin/exchanges/testing">Demo Lab</Link>
          <Link href="/dashboard">Trader View</Link>
        </nav>
      </header>

      <TradePerformanceView adminEmail={user.email} />
    </main>
  );
}
