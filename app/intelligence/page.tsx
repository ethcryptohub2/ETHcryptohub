import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { readIntelligenceStatus } from '../../lib/intelligence/server-status';
import { TemporaryWatchlist } from './watchlist';
import { defaultPaperRiskPolicy } from '../../lib/intelligence/risk-governor';

export const dynamic = 'force-dynamic';
export default async function IntelligencePage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const status = await readIntelligenceStatus(user);
  const risk = defaultPaperRiskPolicy();
  return <main className="shell">
    <section className="hero"><p className="mono">MARKET RESEARCH · PAPER FOUNDATION</p><h1>Research workspace.</h1>
      <p className="muted">Shared market intelligence, with separate account risk decisions. Exchange trading remains disabled.</p>
      <div className="links"><Link href="/scanner">Standard and High-Risk signals</Link><Link href="/positions">Recorded positions</Link><Link href="/scanner/performance">Signal performance</Link></div>
    </section>
    <section className="grid">
      <TemporaryWatchlist key={user.id} />
      <article className="card"><h2>Market freshness</h2><p role="status">Continuous worker inactive</p>
        <p className="muted">{status.market.databaseAvailable ? `${status.market.snapshotSymbols} symbols have saved snapshots out of ${status.market.enabledSymbols} enabled symbols.` : 'Saved feed health is unavailable.'}</p>
        <p className="muted">Last saved scan: {status.market.latestSnapshotAt ? new Date(status.market.latestSnapshotAt).toISOString() : 'Unavailable'}. Saved data is not a live stream.</p></article>
      <article className="card"><h2>Early momentum watchlist</h2><p>No active feed candidates.</p>
        <p className="muted">Volume acceleration, aggressive order flow and book imbalance need fresh, sequence-verified data. Unidentified exchange activity is not a confirmed whale.</p></article>
      <article className="card"><h2>Paper Autopilot</h2><p>Current mode: Observe</p>
        <p className="muted">Observe, Confirm and Paper Autopilot are supported by the local engine. Remote activation awaits durable account storage and an approved market worker.</p>
        <button disabled>Paper activation unavailable</button></article>
      <article className="card"><h2>Independent risk limits</h2><p className="muted">Risk budget, exposure, drawdown, daily loss, position count, leverage, exclusions and the kill switch override signal scores.</p>
        <dl><dt>Default per-trade risk ceiling</dt><dd>{risk.riskPerTradePct}%</dd><dt>Daily loss ceiling</dt><dd>{risk.maxDailyLossPct}%</dd><dt>Maximum paper positions</dt><dd>{risk.maxPositions}</dd><dt>Leverage ceiling</dt><dd>{risk.leverageCeiling}×</dd></dl>
        <p>No remote risk settings are saved or applied here.</p></article>
      <article className="card"><h2>Paper history and performance</h2><p>No remote paper executions.</p>
        <p className="muted">Replay reports include costs, fills, equity and drawdown separately for Standard and High-Risk. Simulated results are not exchange performance.</p></article>
      <article className="card"><h2>Alerts and evidence</h2><p className="muted">Research decisions carry explanations, timestamps and expiry. No new alerts or notifications are activated by this page.</p></article>
    </section>
  </main>;
}
