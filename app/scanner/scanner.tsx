'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { HighRiskScalping } from './high-risk-scalping';
import { ScannerTabs } from './scanner-tabs';
import type {
  MarketScannerCandidate as ScannerCandidate,
  MarketScannerResponse,
} from '../../smartexit/apps/api/src/services/market-scanner';
import { recommendedMaxAgeSeconds } from '../../smartexit/apps/api/src/services/market-scanner';
import { SignalCountdown } from '../countdown';

type SignalMetadata = {
  signals: Record<string, { id: string; generatedAt: string; expiresAt: string; status: string } | null>;
  serverNow: string;
};

const AUTO_REFRESH_INTERVAL_MS = 30_000;

function formatPrice(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
}

export function Scanner({ isAdmin, initialTab }: { isAdmin: boolean; initialTab: 'standard' | 'scalping' }) {
  const [tab, setTab] = useState<'standard' | 'scalping'>(initialTab);
  const changeTab = useCallback((nextTab: 'standard' | 'scalping') => {
    setTab(nextTab);
    window.history.replaceState(null, '', nextTab === 'scalping' ? '/scanner?tab=scalping' : '/scanner');
  }, []);
  return tab === 'standard'
    ? <StandardSignals isAdmin={isAdmin} activeTab={tab} onTabChange={changeTab} />
    : <HighRiskScalping activeTab={tab} onTabChange={changeTab} isAdmin={isAdmin} />;
}

function StandardSignals({
  isAdmin,
  activeTab,
  onTabChange,
}: {
  isAdmin: boolean;
  activeTab: 'standard' | 'scalping';
  onTabChange: (tab: 'standard' | 'scalping') => void;
}) {
  const [data, setData] = useState<MarketScannerResponse | null>(null);
  const [signalMetadata, setSignalMetadata] = useState<SignalMetadata | null>(null);
  const [notificationWarning, setNotificationWarning] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const requestInFlight = useRef(false);
  const [timeframe, setTimeframe] = useState<ScannerCandidate['timeframe']>('15m');
  const [rankFilter, setRankFilter] = useState<'ALL' | ScannerCandidate['marketRank'][number]>('ALL');
  const load = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    setError('');
    try {
      const maxAgeSeconds = recommendedMaxAgeSeconds(timeframe);
      const params = new URLSearchParams({
        timeframe,
        minimumVolume: '10000000',
        limit: '30',
        atrPeriod: '10',
        multiplier: '3',
        maxAgeSeconds: String(maxAgeSeconds),
        minimumScore: '60',
        quoteAsset: 'USDT',
      });
      const response = await fetch(`/api/scanner?${params}`, { credentials: 'same-origin', cache: 'no-store' });
      const body = await response.json() as {
        data?: MarketScannerResponse;
        error?: string;
        signalMetadata?: SignalMetadata;
        notificationWarning?: string;
      };
      if (!response.ok || !body.data) throw new Error(body.error ?? `Scanner request failed (${response.status}).`);
      setData(body.data);
      setSignalMetadata(body.signalMetadata ?? null);
      setNotificationWarning(body.notificationWarning ?? '');
      setLastCheckedAt(Date.now());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Live scanner data is unavailable.');
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  }, [timeframe]);
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const initial = window.setTimeout(refreshWhenVisible, 0);
    const timer = window.setInterval(refreshWhenVisible, AUTO_REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenVisible);
    };
  }, [load]);
  const candidates = (data?.candidates ?? []).filter(
    (item) => rankFilter === 'ALL' || item.marketRank.includes(rankFilter),
  );
  const ready = candidates.filter((item) => item.status === 'READY' && item.setup);
  const unavailable = candidates.filter((item) => item.status === 'DATA_UNAVAILABLE').length;
  const stale = candidates.filter((item) => item.status === 'STALE').length;
  const longSignals = ready.filter((item) => item.side === 'LONG').length;
  const shortSignals = ready.filter((item) => item.side === 'SHORT').length;
  const hasCandidates = (data?.candidates.length ?? 0) > 0;
  const degraded = data?.status === 'DEGRADED' && hasCandidates;
  const statusLabel = !data ? 'Connecting' : data.status === 'LIVE' ? 'Live data' : hasCandidates ? 'Partial data' : 'Awaiting scan';
  const healthLabel = data ? hasCandidates ? data.status : 'WAITING' : '—';
  return <main className="shell">
    <ScannerTabs active={activeTab} onChange={onTabChange} />
    <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/scanner/successful">Successful Signals</Link><Link href="/scanner/history">Signal History</Link><Link href="/scanner/performance">Performance</Link><Link href="/dashboard">Dashboard</Link><Link href="/settings">Settings</Link>{isAdmin && <Link href="/admin">Admin</Link>}<button className="scanner-refresh" onClick={() => void load()} disabled={loading}><span aria-hidden="true">{loading ? '↻' : '⟳'}</span> {loading ? 'Loading…' : 'Refresh results'}</button></nav></header>
    <section className="hero scanner-hero">
      <div className="scanner-eyebrow"><span className={`scanner-live-dot ${degraded ? 'is-warning' : ''}`} />PUBLIC PERPETUAL FUTURES <span className="scanner-eyebrow-divider">/</span> {data ? `${data.exchange} · ${data.market}` : 'LIVE MARKET DATA'}</div>
      <div className="scanner-heading-row"><div><h1>Market scanner</h1><p className="muted">High-conviction technical setups with transparent market context.</p></div><div className={`scanner-status ${degraded ? 'is-warning' : ''}`}>{statusLabel}</div></div>
    </section>
    <section className="scanner-overview" aria-label="Scanner summary">
      <article className="scanner-stat-card scanner-stat-primary"><span className="scanner-stat-label">Actionable setups</span><strong>{data ? ready.length : '—'}</strong><span className="scanner-stat-foot">{loading ? 'Refreshing saved results…' : 'Fresh, rule-qualified candidates'}</span></article>
      <article className="scanner-stat-card"><span className="scanner-stat-label">Pairs with results</span><strong>{data ? candidates.length : '—'}</strong><span className="scanner-stat-foot">{rankFilter === 'ALL' ? 'Enabled pairs with scheduled scan results' : rankFilter.replace('TOP_', 'Top ').toLowerCase()}</span></article>
      <article className="scanner-stat-card"><span className="scanner-stat-label">Long / Short</span><strong><span className="scanner-stat-long">{longSignals}</span><span className="scanner-stat-slash"> / </span><span className="scanner-stat-short">{shortSignals}</span></strong><span className="scanner-stat-foot">Directional setups</span></article>
      <article className="scanner-stat-card"><span className="scanner-stat-label">Market health</span><strong className={`scanner-health-value ${degraded ? 'is-warning' : ''}`}>{healthLabel}</strong><span className="scanner-stat-foot">{data ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()}` : 'Waiting for first scan'}</span></article>
    </section>
    <section className="card stack scanner-panel">
      <div className="scanner-panel-header"><div><p className="mono">MARKET OPPORTUNITIES</p><h2>Signal watchlist</h2><p className="muted">Signals are research references only; no orders are placed.</p><p className="muted" role="status">Auto-refresh every 30 seconds · {lastCheckedAt ? `Last checked ${new Date(lastCheckedAt).toLocaleTimeString()}` : 'Checking for updates…'}</p></div>
        <div className="scanner-controls">
          <label>Timeframe<select value={timeframe} onChange={(event) => setTimeframe(event.target.value as ScannerCandidate['timeframe'])}><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="1h">1 hour</option><option value="4h">4 hours</option></select></label>
          <label>Market universe<select value={rankFilter} onChange={(event) => setRankFilter(event.target.value as typeof rankFilter)}><option value="ALL">All enabled pairs</option><option value="TOP_VOLUME">Top volume</option><option value="TOP_GAINER">Top gainers</option><option value="TOP_LOSER">Top losers</option></select></label>
        </div>
      </div>
      {error && <div role="alert" className="error"><strong>Live scanner data unavailable</strong><br />{error}</div>}
      {notificationWarning && <p role="status" className="scanner-warning">{notificationWarning}</p>}
      {degraded && <p role="status" className="scanner-warning"><strong>Partial market data</strong><span>{stale} stale and {unavailable} unavailable pairs. Treat this scan as incomplete and refresh before relying on its indicators.</span></p>}
      {!error && loading && !data && <p className="muted">Loading the latest scheduled Binance scan results…</p>}
      {data && candidates.length === 0 && <p className="scanner-empty"><strong>No scan results yet</strong><span>Background scans refresh a bounded batch of Binance pairs on a rotating timeframe. After syncing the coin universe, an administrator can run an immediate 15-minute scan from Scanner Management.</span>{isAdmin && <Link href="/admin#scanner-management">Open coin management</Link>}</p>}
      {data && ready.length === 0 && candidates.length > 0 && <p className="scanner-empty"><strong>No actionable setups right now</strong><span>Try another timeframe or market list. These indicators are informational and do not execute trades.</span></p>}
      {candidates.length > 0 && <div className="scanner-signal-list">{candidates.map((item) => <article className={`scanner-signal-card ${item.status === 'READY' ? item.side === 'LONG' ? 'is-long' : 'is-short' : 'is-wait'} `} key={item.symbol}>
        <div className="scanner-signal-header">
          <div className="scanner-market-title">
            <span className="scanner-coin-mark">{item.symbol.replace(/USDT$/, '').slice(0, 1)}</span>
            <div><h3>{item.symbol.replace(/USDT$/, '')}<span> / USDT</span></h3><p>{item.marketRank.map((rank) => rank.replace('TOP_', '').replace('_', ' ')).join(' · ')}</p></div>
          </div>
          <div className="scanner-card-meta">
            <span className={`scanner-signal-badge ${item.status === 'READY' ? item.side === 'LONG' ? 'is-long' : 'is-short' : 'is-wait'}`}><span aria-hidden="true">{item.status === 'READY' ? item.side === 'LONG' ? '↗' : '↘' : '•'}</span>{item.status === 'READY' ? item.side : item.status === 'STALE' || item.status === 'DATA_UNAVAILABLE' ? 'NO DATA' : 'WAIT'}</span>
            <div className="scanner-card-score"><span>SETUP SCORE</span><strong>{item.score.value === null ? '—' : `${item.score.value}`}<small>/100</small></strong><small>{item.scannedAt ? `Scanned ${new Date(item.scannedAt).toLocaleTimeString()}` : 'Scan pending'}</small></div>
          </div>
        </div>
        {signalMetadata?.signals[item.symbol] && <div className="scanner-expiry-row">
          <span>Signal validity · generated {new Date(signalMetadata.signals[item.symbol]!.generatedAt).toLocaleTimeString()}</span>
          <SignalCountdown expiresAt={signalMetadata.signals[item.symbol]!.expiresAt} serverNow={signalMetadata.serverNow} status={signalMetadata.signals[item.symbol]!.status} />
        </div>}
        <div className="scanner-price-grid">
          <div className="scanner-price-cell"><span>Current price</span><strong>{item.price === null ? '—' : formatPrice(item.price)}</strong><small className={`scanner-change ${item.priceChangePercent24h !== null && item.priceChangePercent24h < 0 ? 'is-negative' : ''}`}>{item.priceChangePercent24h === null ? '24h change unavailable' : `${item.priceChangePercent24h >= 0 ? '+' : ''}${item.priceChangePercent24h.toFixed(2)}% today`}</small></div>
          <div className="scanner-price-cell is-entry"><span>Planned entry</span><strong>{item.setup ? formatPrice(item.setup.entryPrice) : '—'}</strong><small>{item.setup ? 'Reference entry price' : 'No confirmed setup'}</small></div>
          <div className="scanner-price-cell is-stop"><span>Stop loss</span><strong>{item.setup ? formatPrice(item.setup.initialStop) : '—'}</strong><small>{item.setup ? 'Initial reference stop' : 'Available when ready'}</small></div>
        </div>
        <div className="scanner-target-section"><div className="scanner-target-heading"><span>PROFIT TARGETS</span><span>Risk multiples from entry</span></div><div className="scanner-target-grid">
          {[item.setup?.tp1, item.setup?.tp2, item.setup?.tp3].map((target, index) => <div className={`scanner-target-card ${target ? 'is-active' : ''}`} key={index}><span>TP {index + 1}<small>{index + 1}R</small></span><strong>{target ? formatPrice(target) : '—'}</strong></div>)}
        </div></div>
        {item.status === 'READY' && <details className="scanner-analysis">
          <summary>Review signal rationale & market research</summary>
          <div className="scanner-analysis-content"><p>{item.rationale}</p>
            {item.warnings.length > 0 && <ul>{item.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            <div className="scanner-research-grid">
              <div><span>Funding / open interest</span><strong>{item.research.derivatives.status === 'LIVE' && item.research.derivatives.data
                ? `${item.research.derivatives.data.fundingRatePercent.toFixed(4)}% · ${item.research.derivatives.data.openInterestChangePercent === null ? 'OI n/a' : `${item.research.derivatives.data.openInterestChangePercent.toFixed(2)}% OI`}`
                : item.research.derivatives.reason}</strong></div>
              <div><span>Liquidation heatmap</span><strong>{item.research.liquidationHeatmap.status === 'LIVE' && item.research.liquidationHeatmap.data
                ? `Above ${item.research.liquidationHeatmap.data.nearestAbove?.price ? formatPrice(item.research.liquidationHeatmap.data.nearestAbove.price) : '—'} · Below ${item.research.liquidationHeatmap.data.nearestBelow?.price ? formatPrice(item.research.liquidationHeatmap.data.nearestBelow.price) : '—'}`
                : item.research.liquidationHeatmap.reason}</strong></div>
              <div><span>Exchange flow</span><strong>{item.research.onChainFlow.status === 'LIVE' && item.research.onChainFlow.data
                ? `${item.research.onChainFlow.data.exchangeNetflow.toPrecision(5)} ${item.research.onChainFlow.data.asset} · not wallet-attributed`
                : item.research.onChainFlow.reason}</strong></div>
              <div><span>News context</span><strong>{item.research.news.status === 'LIVE' && item.research.news.data
                ? `${item.research.news.data.itemCount} items · ${item.research.news.data.positiveVotes} positive / ${item.research.news.data.negativeVotes} negative votes`
                : item.research.news.reason}</strong></div>
            </div>
            {item.research.news.data?.stories.map((story) => <a className="scanner-news-link" key={story.url} href={story.url} target="_blank" rel="noreferrer">{story.title} ↗</a>)}
          </div>
        </details>}
      </article>)}</div>}
      <p className="scanner-disclaimer">Research feeds provide context, not certainty. Exchange netflow is not verified smart-wallet attribution; news votes are community signals. Setups are informational and do not place orders.</p>
    </section>
  </main>;
}
