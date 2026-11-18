import Link from 'next/link';
import { forbidden, redirect } from 'next/navigation';
import { currentUser } from '../../../../lib/auth';
import { UnifiedAdminDemoConsole } from './unified-admin-demo-console';

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
        <h1>Exchange testing lab.</h1>
        <p className="muted">
          Select a provider to review its isolated Admin Demo lifecycle availability.
          Environments are fixed per provider; unsupported providers have no enabled
          connection or order actions here.
        </p>
      </section>
      <UnifiedAdminDemoConsole />
      <p className="muted"><Link href="/admin/exchanges">Review provider readiness</Link></p>
    </main>
  );
}
