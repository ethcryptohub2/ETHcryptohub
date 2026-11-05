import Link from 'next/link';
import { currentUser } from '../lib/auth';
import { isDatabaseConfigured } from '../lib/db';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const databaseConfigured = isDatabaseConfigured();
  const user = databaseConfigured ? await currentUser() : null;
  return (
    <main className="shell">
      <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links">{user ? <><Link href="/dashboard">Dashboard</Link><Link href="/scanner">Scanner</Link></> : <><Link href="/login">Sign in</Link><Link href="/signup">Create account</Link></>}</nav></header>
      {!databaseConfigured && <p className="error" role="status">Database is not configured. Account, settings, and scanner services will remain unavailable until Supabase connection variables are set.</p>}
      <section className="hero">
        <p className="mono">MARKET INTELLIGENCE · ACCOUNT CONTROLS</p>
        <h1>Autonomous intelligence for crypto markets.</h1>
        <p className="muted">Live public perpetual-futures market information, technical indicators, and secure account controls.</p>
        <div className="links" style={{ marginTop: 24 }}><Link className="button" href={user ? '/dashboard' : '/signup'}>{user ? 'Launch dashboard' : 'Create account'}</Link><Link href="/scanner">Market scanner</Link></div>
      </section>
      <section className="grid"><article className="card"><p className="mono">01 · SECURITY</p><h2>Verified access</h2><p className="muted">Email verification, hardened sessions, CSRF protection, and role-based administration.</p></article><article className="card"><p className="mono">02 · MARKET DATA</p><h2>Futures intelligence</h2><p className="muted">Technical indicators use public perpetual-futures data and completed candles.</p></article><article className="card"><p className="mono">03 · ACCOUNT TOOLS</p><h2>Secure data entry</h2><p className="muted">Manage account details and optionally save encrypted, read-only Binance API credentials.</p></article></section>
    </main>
  );
}
