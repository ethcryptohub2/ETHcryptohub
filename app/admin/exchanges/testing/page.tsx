import Link from 'next/link';
import { forbidden, redirect } from 'next/navigation';
import { currentUser } from '../../../../lib/auth';
import { BybitDemoTestingLab } from './bybit-demo-testing-lab';
import { BinanceDemoConsole } from './binance-demo-console';

export const dynamic = 'force-dynamic';

export default async function ExchangeTestingPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') forbidden();
  return <main className="shell">
    <header className="topbar">
      <Link className="brand" href="/">ETHCRYPTOHUB · CONTROL</Link>
      <nav className="links"><Link href="/admin/exchanges">Exchange Control</Link><Link href="/admin">Admin</Link></nav>
    </header>
    <section className="hero">
      <p className="mono">ADMIN ONLY · DEMO / TESTNET</p>
      <h1>Exchange testing lab.</h1>
      <p className="muted">Bybit Demo account and market reads are available to the signed-in Admin. Every order action requires explicit confirmation, uses the fixed Demo API, and is recorded separately from customer executions. Live trading is unavailable.</p>
    </section>
    <BinanceDemoConsole />
    <BybitDemoTestingLab />
    <p className="muted"><Link href="/admin/exchanges">Review provider readiness</Link></p>
  </main>;
}
