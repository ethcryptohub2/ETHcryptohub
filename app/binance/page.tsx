import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { ExchangeConnections } from './exchange-connections';

export const dynamic = 'force-dynamic';
export default async function BinancePage() {
  if (!(await currentUser())) redirect('/login');
  return <main className="shell"><header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/dashboard">Dashboard</Link><Link href="/settings">Settings</Link></nav></header><section className="hero"><p className="mono">EXCHANGE CONNECTIONS</p><h1>API credentials.</h1><p className="muted">Exchange availability is controlled by the platform administrator. Credentials are encrypted at rest and never shown after saving.</p></section><ExchangeConnections /></main>;
}
