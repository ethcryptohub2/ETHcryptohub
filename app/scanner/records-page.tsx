import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { getSubscriptionEntitlement } from '../../lib/subscriptions';
import { SubscriptionPanel } from '../subscription-panel';
import { SignalHistory } from './signal-history';
import { SignalPerformance } from './signal-performance';

export async function SignalRecordsPage({ mode }: { mode: 'successful' | 'history' | 'performance' }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  const subscription = await getSubscriptionEntitlement(user.id);
  if (!subscription.hasPremiumAccess) {
    return <main className="shell">
      <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/scanner">Scanner</Link><Link href="/dashboard">Dashboard</Link></nav></header>
      <section className="hero"><p className="mono">PERSISTED SIGNAL INTELLIGENCE</p><h1>Premium access required.</h1></section>
      <SubscriptionPanel paywall />
    </main>;
  }
  if (mode === 'performance') return <SignalPerformance />;
  return <SignalHistory successfulOnly={mode === 'successful'} />;
}
