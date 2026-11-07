import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { getSubscriptionEntitlement } from '../../lib/subscriptions';
import { SubscriptionPanel } from '../subscription-panel';
import { PositionsPanel } from './positions-panel';

export const dynamic = 'force-dynamic';

export default async function PositionsPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const subscription = await getSubscriptionEntitlement(user.id);
  if (!subscription.hasPremiumAccess) {
    return <main className="shell">
      <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/dashboard">Dashboard</Link><Link href="/scanner">Scanner</Link></nav></header>
      <section className="hero"><p className="mono">USER-RECORDED SIGNAL ENTRIES</p><h1>Position records.</h1></section>
      <SubscriptionPanel paywall />
    </main>;
  }
  return <PositionsPanel />;
}
