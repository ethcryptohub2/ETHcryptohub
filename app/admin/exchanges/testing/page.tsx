import Link from 'next/link';
import { forbidden, redirect } from 'next/navigation';
import { currentUser } from '../../../../lib/auth';
import { ExchangeDemoReview } from './exchange-demo-review';

export const dynamic = 'force-dynamic';

export default async function ExchangeTestingPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') forbidden();

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/">ETHCRYPTOHUB · CONTROL</Link>
        <nav className="links">
          <Link href="/admin/exchanges">Exchange Control</Link>
          <Link href="/admin">Admin</Link>
        </nav>
      </header>
      <section className="hero">
        <p className="mono">ADMIN ONLY · DEMO / TESTNET</p>
        <h1>Exchange Demo Lab</h1>
        <p className="muted">Review provider readiness and the approvals required for Staging demo testing.</p>
      </section>
      <ExchangeDemoReview />
      <p className="muted"><Link href="/admin/exchanges">Review provider readiness</Link></p>
    </main>
  );
}
