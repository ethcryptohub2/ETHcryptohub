import { redirect } from 'next/navigation';
import { currentUser } from '../../../lib/auth';
import { readIntelligenceStatus } from '../../../lib/intelligence/server-status';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export default async function AdminIntelligencePage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/dashboard');
  const status = await readIntelligenceStatus(user);
  return <main className="shell"><section className="hero"><p className="mono">ADMIN · FEED AND PAPER OPERATIONS</p>
    <h1>Intelligence operations.</h1><p className="muted">Activation readiness is separate from application health. No worker, schedule or execution is started here.</p>
    <Link href="/intelligence">Customer research view</Link></section>
    <section className="grid">
      <article className="card"><h2>Feed health</h2><p>Worker inactive · subscriptions not started</p><p className="muted">Saved coverage {status.market.snapshotSymbols}/{status.market.enabledSymbols}. Last snapshot {status.market.latestSnapshotAt ?? 'unavailable'}.</p><p>No continuous sequence or live-lag verification is claimed.</p></article>
      <article className="card"><h2>Execution lock</h2><p>All remote execution disabled</p><button disabled>System execution locked</button><p className="muted">No kill-switch change is necessary while execution is inactive. Local paper journals support deterministic kill switches.</p></article>
      <article className="card"><h2>Strategy and risk evidence</h2><p className="muted">Local replay journals record classifications, rejection reasons, costs and account-specific risk decisions. Remote audit storage and eligibility require approved schema.</p></article>
      <article className="card"><h2>Release prerequisites</h2><p className="muted">Approve the persistent worker host, storage and monitoring before operation. Review migration recovery and RLS separately. Live and exchange Demo orders remain prohibited.</p></article>
    </section></main>;
}
