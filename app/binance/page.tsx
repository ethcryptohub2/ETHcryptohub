import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { ExchangeConnections } from './exchange-connections';

export const dynamic = 'force-dynamic';

export default async function BinancePage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  return (
    <main className="shell">
      <section className="hero">
        <p className="mono">EXCHANGE CONNECTIONS &amp; API GATEWAY</p>
        <h1>Exchange Credentials &amp; Sandboxes</h1>
        <p className="muted">
          Configure API credentials for Binance Futures Demo and partner exchange sandboxes. Credentials are encrypted at rest with AES-256-GCM.
        </p>
        <div className="links">
          <Link className="button-secondary" href="/dashboard">
            ← Back to Dashboard
          </Link>
          <Link className="button-secondary" href="/positions">
            View Exchange Positions
          </Link>
          <Link className="button-secondary" href="/scanner">
            Smart Scanner
          </Link>
        </div>
      </section>
      <ExchangeConnections />
    </main>
  );
}
