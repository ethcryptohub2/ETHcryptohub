import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { getSubscriptionEntitlement } from '../../lib/subscriptions';
import { Scanner } from './scanner';
import { SubscriptionPanel } from '../subscription-panel';

export const dynamic = 'force-dynamic';
export default async function ScannerPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const subscription = await getSubscriptionEntitlement(user.id);
  if (!subscription.hasPremiumAccess) {
    return <main className="shell">
      <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/dashboard">Dashboard</Link><Link href="/settings">Account settings</Link></nav></header>
      <section className="hero"><p className="mono">SMART SIGNAL SCANNER</p><h1>Premium intelligence.</h1></section>
      <SubscriptionPanel paywall />
    </main>;
  }
  return <Scanner />;
}
