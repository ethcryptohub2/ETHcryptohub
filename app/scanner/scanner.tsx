'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  MarketScannerCandidate as ScannerCandidate,
  MarketScannerResponse,
  ScannerConfiguration,
} from '../../smartexit/apps/api/src/services/market-scanner';
import { BybitLinearFuturesMarketsService } from '../../smartexit/apps/api/src/services/binance-futures-markets';
import {
  BinanceMarketScannerService,
  recommendedMaxAgeSeconds,
} from '../../smartexit/apps/api/src/services/market-scanner';
import { ConfiguredMarketResearchProvider } from '../../smartexit/apps/api/src/services/market-research';

const browserFetch: typeof fetch = (...args) => globalThis.fetch(...args);
const browserResearch = new ConfiguredMarketResearchProvider({
  glassnode: null,
  cryptopanic: null,
  coinglass: null,
}, browserFetch);
const browserScanner = new BinanceMarketScannerService(
  new BybitLinearFuturesMarketsService(browserFetch),
  browserFetch,
  Date.now,
  browserResearch,
);

function formatPrice(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
}

export function Scanner() {
  const [data, setData] = useState<MarketScannerResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [timeframe, setTimeframe] = useState<ScannerCandidate['timeframe']>('15m');
  const [rankFilter, setRankFilter] = useState<'ALL' | ScannerCandidate['marketRank'][number]>('ALL');
  const [browserFallback, setBrowserFallback] = useState(false);
  const load = useCallback(async () => {
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
      const configuration: ScannerConfiguration = {
        timeframe,
        quoteAsset: 'USDT',
        minimumVolume: 10_000_000,
        limit: 30,
        atrPeriod: 10,
        multiplier: 3,
        maxAgeSeconds,
        minimumScore: 60,
      };
      const response = await fetch(`/api/scanner?${params}`, { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 502) {
        setData(await browserScanner.scan(configuration));
        setBrowserFallback(true);
        return;
      }
      const body = await response.json() as { data?: MarketScannerResponse; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? `Scanner request failed (${response.status}).`);
      setData(body.data);
      setBrowserFallback(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Live scanner data is unavailable.');
    } finally {
      setLoading(false);
    }
  }, [timeframe]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);
  const candidates = (data?.candidates ?? []).filter(
    (item) => rankFilter === 'ALL' || item.marketRank.includes(rankFilter),
  );
  const ready = candidates.filter((item) => item.status === 'READY' && item.setup);
  const unavailable = candidates.filter((item) => item.status === 'DATA_UNAVAILABLE').length;
  const stale = candidates.filter((item) => item.status === 'STALE').length;
  const waiting = candidates.filter((item) => item.status === 'WAIT');
  const rejected = candidates.filter((item) => item.status !== 'READY');
  const longSignals = ready.filter((item) => item.side === 'LONG').length;
  const shortSignals = ready.filter((item) => item.side === 'SHORT').length;
  const statusLabel = !data ? 'Connecting' : data.status === 'LIVE' ? 'Live data' : 'Partial data';
  return <main className="shell">
    <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/dashboard">Dashboard</Link><Link href="/settings">Settings</Link><button className="scanner-refresh" onClick={() => void load()} disabled={loading}><span aria-hidden="true">{loading ? '↻' : '⟳'}</span> {loading ? 'Scanning…' : 'Refresh scan'}</button></nav></header>
    <section className="hero scanner-hero">
      <div className="scanner-eyebrow"><span className={`scanner-live-dot ${data?.status === 'DEGRADED' ? 'is-warning' : ''}`} />PUBLIC PERPETUAL FUTURES <span className="scanner-eyebrow-divider">/</span> {data ? `${data.exchange} · ${data.market}` : 'LIVE MARKET DATA'}</div>
      <div className="scanner-heading-row"><div><h1>Market scanner</h1><p className="muted">High-conviction technical setups with transparent market context.</p></div><div className={`scanner-status ${data?.status === 'DEGRADED' ? 'is-warning' : ''}`}>{statusLabel}</div></div>
    </section>
    <section className="scanner-overview" aria-label="Scanner summary">
      <article className="scanner-stat-card scanner-stat-primary"><span className="scanner-stat-label">Actionable setups</span><strong>{data ? ready.length : '—'}</strong><span className="scanner-stat-foot">{loading ? 'Refreshing market data…' : 'Fresh, rule-qualified candidates'}</span></article>
      <article className="scanner-stat-card"><span className="scanner-stat-label">Pairs scanned</span><strong>{data ? candidates.length : '—'}</strong><span className="scanner-stat-foot">{rankFilter === 'ALL' ? 'Across selected market lists' : rankFilter.replace('TOP_', 'Top ').toLowerCase()}</span></article>
      <article className="scanner-stat-card"><span className="scanner-stat-label">Long / Short</span><strong><span className="scanner-stat-long">{longSignals}</span><span className="scanner-stat-slash"> / </span><span className="scanner-stat-short">{shortSignals}</span></strong><span className="scanner-stat-foot">Directional setups</span></article>
      <article className="scanner-stat-card"><span className="scanner-stat-label">Market health</span><strong className={`scanner-health-value ${data?.status === 'DEGRADED' ? 'is-warning' : ''}`}>{data ? data.status : '—'}</strong><span className="scanner-stat-foot">{data ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()}` : 'Waiting for first scan'}</span></article>
    </section>
    <section className="card stack scanner-panel">
      <div className="scanner-panel-header"><div><p className="mono">MARKET OPPORTUNITIES</p><h2>Signal watchlist</h2><p className="muted">Signals are research references only; no orders are placed.</p></div>
        <div className="scanner-controls">
          <label>Timeframe<select value={timeframe} onChange={(event) => setTimeframe(event.target.value as ScannerCandidate['timeframe'])}><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="1h">1 hour</option><option value="4h">4 hours</option></select></label>
          <label>Market universe<select value={rankFilter} onChange={(event) => setRankFilter(event.target.value as typeof rankFilter)}><option value="ALL">All ranked pairs</option><option value="TOP_VOLUME">Top volume</option><option value="TOP_GAINER">Top gainers</option><option value="TOP_LOSER">Top losers</option></select></label>
        </div>
      </div>
      {error && <div role="alert" className="error"><strong>Live scanner data unavailable</strong><br />{error}</div>}
      {browserFallback && <p role="status" className="muted">Using browser-direct public market data because the server could not reach the exchanges. Admin-configured research feeds are intentionally omitted in this fallback.</p>}
      {data?.status === 'DEGRADED' && <p role="status" className="scanner-warning"><strong>Partial market data</strong><span>{stale} stale and {unavailable} unavailable pairs. Treat this scan as incomplete and refresh before relying on its indicators.</span></p>}
      {!error && loading && !data && <p className="muted">Loading public futures market data…</p>}
      {data && candidates.length === 0 && <p className="muted">No candidates are in this market list. Choose another list or refresh.</p>}
      {data && ready.length === 0 && candidates.length > 0 && <p className="scanner-empty"><strong>No actionable setups right now</strong><span>Review each pair&apos;s checks below, or try another timeframe or market list.</span></p>}
      {data && ready.length === 0 && candidates.length > 0 && <details open={data.status === 'DEGRADED'}>
        <summary>Why no signals?</summary>
        <p className="muted">{waiting.length} waiting · {stale} stale · {unavailable} unavailable. A signal requires fresh data and aligned trend, momentum, volume, and minimum-score checks. These are informational setups, not executed trades.</p>
        {rejected.length > 0 && <ul>{rejected.map((item) => <li key={item.symbol}><strong>{item.symbol} · {item.status}:</strong> {item.warnings[0] ?? item.rationale}</li>)}</ul>}
      </details>}
      {candidates.length > 0 && <div className="scanner-signal-list">{candidates.map((item) => <article className={`scanner-signal-card ${item.status === 'READY' ? item.side === 'LONG' ? 'is-long' : 'is-short' : 'is-wait'} `} key={item.symbol}>
        <div className="scanner-signal-header">
          <div className="scanner-market-title">
            <span className="scanner-coin-mark">{item.symbol.replace(/USDT$/, '').slice(0, 1)}</span>
            <div><h3>{item.symbol.replace(/USDT$/, '')}<span> / USDT</span></h3><p>{item.marketRank.map((rank) => rank.replace('TOP_', '').replace('_', ' ')).join(' · ')}</p></div>
          </div>
          <div className="scanner-card-meta">
            <span className={`scanner-signal-badge ${item.status === 'READY' ? item.side === 'LONG' ? 'is-long' : 'is-short' : 'is-wait'}`}><span aria-hidden="true">{item.status === 'READY' ? item.side === 'LONG' ? '↗' : '↘' : '•'}</span>{item.status === 'READY' ? item.side : item.status === 'STALE' || item.status === 'DATA_UNAVAILABLE' ? 'NO DATA' : 'WAIT'}</span>
            <div className="scanner-card-score"><span>SETUP SCORE</span><strong>{item.score.value === null ? '—' : `${item.score.value}`}<small>/100</small></strong></div>
          </div>
        </div>
        <div className="scanner-price-grid">
          <div className="scanner-price-cell"><span>Current price</span><strong>{item.price === null ? '—' : formatPrice(item.price)}</strong><small className={`scanner-change ${item.priceChangePercent24h !== null && item.priceChangePercent24h < 0 ? 'is-negative' : ''}`}>{item.priceChangePercent24h === null ? '24h change unavailable' : `${item.priceChangePercent24h >= 0 ? '+' : ''}${item.priceChangePercent24h.toFixed(2)}% today`}</small></div>
          <div className="scanner-price-cell is-entry"><span>Planned entry</span><strong>{item.setup ? formatPrice(item.setup.entryPrice) : '—'}</strong><small>{item.setup ? 'Reference entry price' : 'No confirmed setup'}</small></div>
          <div className="scanner-price-cell is-stop"><span>Stop loss</span><strong>{item.setup ? formatPrice(item.setup.initialStop) : '—'}</strong><small>{item.setup ? 'Initial reference stop' : 'Available when ready'}</small></div>
        </div>
        <div className="scanner-target-section"><div className="scanner-target-heading"><span>PROFIT TARGETS</span><span>Risk multiples from entry</span></div><div className="scanner-target-grid">
          {[item.setup?.tp1, item.setup?.tp2, item.setup?.tp3].map((target, index) => <div className={`scanner-target-card ${target ? 'is-active' : ''}`} key={index}><span>TP {index + 1}<small>{index + 1}R</small></span><strong>{target ? formatPrice(target) : '—'}</strong></div>)}
        </div></div>
        <details className="scanner-analysis">
          <summary>{item.status === 'READY' ? 'Review signal rationale & market research' : 'See why this pair is waiting'}</summary>
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
        </details>
      </article>)}</div>}
      <p className="scanner-disclaimer">Research feeds provide context, not certainty. Exchange netflow is not verified smart-wallet attribution; news votes are community signals. Setups are informational and do not place orders.</p>
    </section>
  </main>;
}
