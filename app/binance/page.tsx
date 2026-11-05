import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { BinanceForm } from './binance-form';

export const dynamic = 'force-dynamic';
export default async function BinancePage() {
  if (!(await currentUser())) redirect('/login');
  return <main className="shell"><header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/dashboard">Dashboard</Link><Link href="/settings">Settings</Link></nav></header><section className="hero"><p className="mono">BINANCE · USDⓈ-M FUTURES</p><h1>API credentials.</h1><p className="muted">Credentials are encrypted at rest. Test checks account-read access only and never places orders.</p></section><BinanceForm /></main>;
}
