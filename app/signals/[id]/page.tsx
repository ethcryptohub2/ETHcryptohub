import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { currentUser } from '../../../lib/auth';
import { query } from '../../../lib/db';
import { SignalCountdown } from '../../countdown';
import { getSubscriptionEntitlement } from '../../../lib/subscriptions';
import { SubscriptionPanel } from '../../subscription-panel';
import { TradeSignalAction } from './trade-signal-action';
import { getTradingSettings } from '../../../lib/trading-settings';

export const dynamic = 'force-dynamic';

type SignalDetail = {
  id: string;
  symbol: string;
  timeframe: string;
  side: 'LONG' | 'SHORT';
  setup_score: number;
  entry_price: string;
  entry_zone_low: string;
  entry_zone_high: string;
  initial_stop: string;
  tp1: string;
  tp2: string;
  tp3: string;
  latest_price: string;
  generated_at: string;
  expires_at: string;
  status: string;
};

function price(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumSignificantDigits: 8 }) : '—';
}

export default async function SignalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  const subscription = await getSubscriptionEntitlement(user.id);
  const tradingSettings = await getTradingSettings(user.id);
  if (!subscription.hasPremiumAccess) {
    return <main className="shell">
      <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/dashboard">Dashboard</Link><Link href="/settings">Account settings</Link></nav></header>
      <SubscriptionPanel paywall />
    </main>;
  }
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const result = await query<SignalDetail>(
    `SELECT id, symbol, timeframe, side, setup_score, entry_price, entry_zone_low, entry_zone_high,
            initial_stop, tp1, tp2, tp3, latest_price, generated_at, expires_at, status
       FROM public.market_signals WHERE id = $1`,
    [id],
  );
  const signal = result.rows[0];
  if (!signal) notFound();
  const serverNow = new Date().toISOString();
  const terminal = ['EXPIRED', 'ENTRY_INVALIDATED', 'STOP_LOSS_HIT', 'TP3_HIT'].includes(signal.status);
  const canShowTradeAction = signal.status === 'ACTIVE';
  return <main className="shell">
    <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/dashboard">Dashboard</Link><Link href="/scanner">Scanner</Link><Link href="/settings">Settings</Link></nav></header>
    <section className="hero signal-detail-hero">
      <p className="mono">PERSISTED SIGNAL · {signal.timeframe} · {tradingSettings.active_environment === 'DEMO' ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'}</p>
      <div className="signal-detail-heading">
        <div><h1>{signal.symbol}</h1><p className="muted">{signal.side} · rule-based setup score {signal.setup_score}/100</p></div>
        <span className={`scanner-signal-badge ${signal.side === 'LONG' ? 'is-long' : 'is-short'}`}>{signal.status.replaceAll('_', ' ')}</span>
      </div>
      <p className="muted">Generated {new Date(signal.generated_at).toLocaleString()} · Latest tracked price {price(signal.latest_price)}</p>
    </section>
    <section className="card stack">
      <div className="signal-detail-countdown">
        <span>Server-set validity · does not reset on refresh</span>
        <SignalCountdown expiresAt={signal.expires_at} serverNow={serverNow} status={signal.status} />
      </div>
      {signal.status === 'ENTRY_INVALIDATED' && <p className="scanner-warning"><strong>ENTRY MISSED / ENTRY ZONE INVALIDATED</strong></p>}
      {signal.status === 'EXPIRED' && <p className="scanner-warning"><strong>EXPIRED · This signal is not a fresh entry.</strong></p>}
      {terminal && signal.status !== 'EXPIRED' && signal.status !== 'ENTRY_INVALIDATED' && <p className="muted">This signal has reached a terminal lifecycle state and is not a fresh entry.</p>}
      <div className="signal-detail-grid">
        <div><span>Reference entry</span><strong>{price(signal.entry_price)}</strong></div>
        <div><span>Valid entry zone</span><strong>{price(signal.entry_zone_low)} – {price(signal.entry_zone_high)}</strong></div>
        <div><span>Stop Loss</span><strong>{price(signal.initial_stop)}</strong></div>
        {[signal.tp1, signal.tp2, signal.tp3].map((target, index) => <div key={index}><span>TP {index + 1}</span><strong>{price(target)}</strong></div>)}
      </div>
      <p className="scanner-disclaimer">Research reference only. The countdown and signal do not execute or authorize a trade. Market data, availability, and signal validity can change.</p>
    </section>
    {canShowTradeAction && <TradeSignalAction signalId={signal.id} />}
  </main>;
}
