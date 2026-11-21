'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { HighRiskScalping } from './high-risk-scalping';
import { ScannerTabs } from './scanner-tabs';
import type { MarketScannerCandidate as ScannerCandidate } from '../../smartexit/apps/api/src/services/market-scanner';
import { recommendedMaxAgeSeconds } from '../../smartexit/apps/api/src/services/market-scanner';
import { applyScannerSignalValidity, savedScannerCacheStatus, savedScannerCandidate } from '../../lib/scanner-snapshot';
import { SignalCountdown } from '../countdown';
import { scannerSymbolPrefix, type SavedScannerResponse, type ScannerCoverage, type ScannerRank } from '../../lib/scanner-universe';

type SignalMetadata = {
  signals: Record<string, {
    id: string; generatedAt: string; expiresAt: string; status: string;
    entryZone: { low: number; high: number } | null;
  } | null>;
  serverNow: string;
};
type SignalClock = { serverNow: string; receivedAt: number };

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
  const [savedData, setData] = useState<SavedScannerResponse | null>(null);
  const [signalMetadata, setSignalMetadata] = useState<SignalMetadata | null>(null);
  const [signalClock, setSignalClock] = useState<SignalClock | null>(null);
  const [notificationWarning, setNotificationWarning] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [freshnessNow, setFreshnessNow] = useState(0);
  const requestInFlight = useRef<AbortController | null>(null);
  const [timeframe, setTimeframe] = useState<ScannerCandidate['timeframe']>('15m');
  const [selection, setSelection] = useState<{ coverage: ScannerCoverage; symbol: string; rank: ScannerRank | null; page: number }>({
    coverage: 'saved', symbol: '', rank: null, page: 1,
  });
  const [symbolInput, setSymbolInput] = useState('');
  const [filterError, setFilterError] = useState('');
  const { coverage, symbol, rank, page } = selection;
  const data = savedData?.timeframe === timeframe && savedData.selection.coverage === coverage &&
    savedData.selection.symbol === symbol && savedData.selection.rank === rank && savedData.selection.page === page ? savedData : null;
  const load = useCallback(async () => {
    setFreshnessNow(performance.now());
    if (requestInFlight.current) return;
    const controller = new AbortController();
    requestInFlight.current = controller;
    const timeout = window.setTimeout(() => controller.abort(new DOMException('Scanner request timed out.', 'TimeoutError')), 12_000);
    const requestedAt = performance.now();
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
        coverage,
        symbol,
        page: String(page),
      });
      if (rank) params.set('rank', rank);
      const response = await fetch(`/api/scanner?${params}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const body = await response.json() as {
        data?: SavedScannerResponse;
        error?: string;
        signalMetadata?: SignalMetadata;
        notificationWarning?: string;
      };
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok || !body.data) throw new Error(body.error ?? `Scanner request failed (${response.status}).`);
      const receivedAt = performance.now();
      const serverNow = new Date(
        body.signalMetadata ? Date.parse(body.signalMetadata.serverNow) + receivedAt - requestedAt : Date.now(),
      ).toISOString();
      setData(body.data);
      setSignalMetadata(body.signalMetadata ? { ...body.signalMetadata, serverNow } : null);
      setSignalClock({ serverNow, receivedAt });
      setNotificationWarning(body.notificationWarning ?? '');
      setLastCheckedAt(Date.now());
      setFreshnessNow(receivedAt);
    } catch (reason) {
      const timedOut = controller.signal.aborted && controller.signal.reason?.name === 'TimeoutError';
      if (controller.signal.aborted && !timedOut) return;
      // A failed refresh must not leave previously actionable results on screen.
      setData(null);
      setSignalMetadata(null);
      setSignalClock(null);
      setNotificationWarning('');
      setError(timedOut ? 'Reading saved scanner results timed out. Try refreshing results.' :
        reason instanceof Error ? reason.message : 'Saved scanner data is unavailable. Try refreshing results.');
    } finally {
      window.clearTimeout(timeout);
      if (requestInFlight.current === controller) {
        requestInFlight.current = null;
        setLoading(false);
      }
    }
  }, [coverage, page, rank, symbol, timeframe]);
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const initial = window.setTimeout(refreshWhenVisible, 0);
    const timer = window.setInterval(refreshWhenVisible, AUTO_REFRESH_INTERVAL_MS);
    // Age the displayed cache even while a request is slow or never completes.
    const freshnessTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setFreshnessNow(performance.now());
    }, 1000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
    return () => {
      requestInFlight.current?.abort();
      requestInFlight.current = null;
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.clearInterval(freshnessTimer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenVisible);
    };
  }, [load]);
  const signalNow = signalClock
    ? Date.parse(signalClock.serverNow) + Math.max(0, freshnessNow - signalClock.receivedAt)
    : 0;
  const candidates = (data?.candidates ?? []).map((candidate) => applyScannerSignalValidity(
    savedScannerCandidate(candidate, candidate.scannedAt ?? '', data?.configuration.maxAgeSeconds ?? recommendedMaxAgeSeconds(timeframe), signalNow),
    signalMetadata?.signals[candidate.symbol],
    signalNow,
  ));
  const ready = candidates.filter((item) => item.status === 'READY' && item.setup);
  const unavailable = candidates.filter((item) => item.status === 'DATA_UNAVAILABLE').length;
  const stale = candidates.filter((item) => item.status === 'STALE').length;
  const longSignals = ready.filter((item) => item.side === 'LONG').length;
  const shortSignals = ready.filter((item) => item.side === 'SHORT').length;
  const persistedSetups = ready.filter((item) => signalMetadata?.signals[item.symbol]).length;
  const pageCount = data ? Math.max(1, Math.ceil(data.matchingCount / data.selection.limit)) : 1;
  const cacheStatus = data && savedScannerCacheStatus(data.savedCount, data.updatedAt, data.configuration.maxAgeSeconds, signalNow);
  const degraded = cacheStatus === 'STALE_CACHE' || stale > 0 || unavailable > 0;
  const statusLabel = !data ? (error ? 'Results unavailable' : 'Loading saved results') :
    cacheStatus === 'NO_SAVED_RESULTS' ? 'Awaiting first saved scan' : degraded ? 'Stale or partial cache' : 'Recent cached results';
  const healthLabel = cacheStatus === 'NO_SAVED_RESULTS' ? 'WAITING' : degraded ? 'STALE / PARTIAL' : data ? 'RECENT CACHE' : '—';
  return <main className="shell">
    <ScannerTabs active={activeTab} onChange={onTabChange} />
    <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/scanner/successful">Successful Signals</Link><Link href="/scanner/history">Signal History</Link><Link href="/scanner/performance">Performance</Link><Link href="/dashboard">Dashboard</Link><Link href="/settings">Settings</Link>{isAdmin && <Link href="/admin">Admin</Link>}<button className="scanner-refresh" onClick={() => void load()} disabled={loading}><span aria-hidden="true">{loading ? '↻' : '⟳'}</span> {loading ? 'Loading…' : 'Refresh results'}</button></nav></header>
    <section className="hero scanner-hero">
      <div className="scanner-eyebrow"><span className={`scanner-live-dot ${degraded ? 'is-warning' : ''}`} />PUBLIC PERPETUAL FUTURES <span className="scanner-eyebrow-divider">/</span> {data ? `${data.exchange} · ${data.market}` : 'SAVED SCANNER RESULTS'}</div>
      <div className="scanner-heading-row"><div><h1>Market scanner</h1><p className="muted">High-conviction technical setups with transparent market context.</p></div><div className={`scanner-status ${degraded ? 'is-warning' : ''}`}>{statusLabel}</div></div>
    </section>
    <section className="scanner-overview" aria-label="Scanner summary">
      <article className="scanner-stat-card scanner-stat-primary"><span className="scanner-stat-label">Qualified setups on this page</span><strong>{data && coverage !== 'eligible' ? ready.length : '—'}</strong><span className="scanner-stat-foot">{coverage === 'eligible' ? 'Instrument directory' : `${longSignals} long · ${shortSignals} short · ${persistedSetups} stored signals`}</span></article>
      <article className="scanner-stat-card"><span className="scanner-stat-label">Eligible instruments at last sync</span><strong>{data?.eligibleCount ?? '—'}</strong><span className="scanner-stat-foot">{data?.universeSyncedAt ? `Last universe sync ${new Date(data.universeSyncedAt).toLocaleString()}` : 'No verified universe sync time'}</span></article>
      <article className="scanner-stat-card"><span className="scanner-stat-label">Pairs with saved scans</span><strong>{data?.savedCount ?? '—'}</strong><span className="scanner-stat-foot">{timeframe} timeframe · {data?.watchlistCount ?? '—'} fixed research symbols</span></article>
      <article className="scanner-stat-card"><span className="scanner-stat-label">Saved market data</span><strong className={`scanner-health-value ${degraded ? 'is-warning' : ''}`}>{healthLabel}</strong><span className="scanner-stat-foot">{data?.updatedAt ? `Last saved scan ${new Date(data.updatedAt).toLocaleString()}` : 'No saved scan'}</span></article>
    </section>
    <section className="card stack scanner-panel">
      <div className="scanner-panel-header"><div><h2>Scanner coverage</h2><p className="muted">Browse configured pairs, the fixed research list or saved scans. Changing the view does not start a scan.</p><p className="scanner-research-target" role="note">Standard research target: 95% win rate · unverified objective, not an achieved result.</p><p className="muted" role="status">{lastCheckedAt ? `Saved results checked ${new Date(lastCheckedAt).toLocaleTimeString()}` : 'Checking saved results…'}</p></div>
        <div className="scanner-controls">
          <label>Timeframe<select value={timeframe} onChange={(event) => { setTimeframe(event.target.value as ScannerCandidate['timeframe']); setSelection({ ...selection, page: 1 }); }}><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="1h">1 hour</option><option value="4h">4 hours</option></select></label>
          <label>Coverage<select value={coverage} onChange={(event) => setSelection({ ...selection, coverage: event.target.value as ScannerCoverage, rank: null, page: 1 })}><option value="saved">Saved scans</option><option value="eligible">All eligible instruments</option><option value="watchlist">Fixed research watchlist</option></select></label>
          {coverage === 'saved' && <label>Rank at saved scan<select value={rank ?? ''} onChange={(event) => setSelection({ ...selection, rank: (event.target.value || null) as ScannerRank | null, page: 1 })}><option value="">All saved ranks</option><option value="TOP_VOLUME">Top volume</option><option value="TOP_GAINER">Top gainers</option><option value="TOP_LOSER">Top losers</option></select></label>}
        </div>
      </div>
      <form className="links" onSubmit={(event) => {
        event.preventDefault();
        const normalized = symbolInput.trim().toUpperCase();
        if (!scannerSymbolPrefix.test(normalized)) { setFilterError('Enter up to 30 letters or digits.'); return; }
        setFilterError('');
        setSelection({ ...selection, symbol: normalized, page: 1 });
      }}>
        <label>Symbol prefix<input value={symbolInput} maxLength={30} placeholder="e.g. BTC" onChange={(event) => setSymbolInput(event.target.value)} /></label>
        <button type="submit">Filter symbols</button>
        {symbol && <button type="button" className="button-secondary" onClick={() => { setSymbolInput(''); setFilterError(''); setSelection({ ...selection, symbol: '', page: 1 }); }}>Clear filter</button>}
      </form>
      {filterError && <p className="error" role="alert">{filterError}</p>}
      {error && <div role="alert" className="error"><strong>Saved scanner results unavailable</strong><br />{error}</div>}
      {notificationWarning && <p role="status" className="scanner-warning">{notificationWarning}</p>}
      {degraded && <p role="status" className="scanner-warning"><strong>Stale or partial saved data</strong><span>Stale prices and entry levels are withheld. Refreshing reads the same saved source. New market data requires a separately authorized scan.</span></p>}
      {!error && loading && !data && <p className="muted">Loading saved Binance scan results…</p>}
      {data && data.matchingCount === 0 && <p className="scanner-empty"><strong>{data.status === 'NO_SAVED_RESULTS' && coverage === 'saved' ? 'No saved scans for this timeframe' : 'No pairs match this selection'}</strong><span>Change the timeframe, coverage or symbol filter.</span>{isAdmin && <Link href="/admin#scanner-management">Open coin management</Link>}</p>}
      {data && coverage !== 'saved' && data.instruments.length > 0 && <div className="scanner-table-wrap"><table className="scan-table">
        <thead><tr><th scope="col">Symbol</th><th scope="col">Saved eligibility</th><th scope="col">Research list</th><th scope="col">Last saved scan</th></tr></thead>
        <tbody>{data.instruments.map((instrument) => <tr key={instrument.symbol}><th scope="row">{instrument.symbol}</th><td>{instrument.eligible ? 'Eligible' : 'No eligible saved configuration'}</td><td>{instrument.watchlist ? 'Included' : '—'}</td><td>{instrument.savedScanAt ? new Date(instrument.savedScanAt).toLocaleString() : 'No saved scan'}</td></tr>)}</tbody>
      </table></div>}
      {data && coverage !== 'eligible' && ready.length === 0 && candidates.length > 0 && <p className="scanner-empty"><strong>{degraded ? 'Saved evidence does not support an actionable setup' : 'No qualified setups on this page'}</strong></p>}
      {data && (page > 1 || data.matchingCount > data.selection.limit) && <nav className="links" aria-label="Scanner pages">
        <button type="button" disabled={page === 1 || loading} onClick={() => setSelection({ ...selection, page: page - 1 })}>Previous page</button>
        <span role="status">Page {page} of {pageCount} · {data.matchingCount} matches</span>
        <button type="button" disabled={page >= pageCount || loading} onClick={() => setSelection({ ...selection, page: page + 1 })}>Next page</button>
      </nav>}
      {candidates.length > 0 && <div className="scanner-signal-list">{candidates.map((item) => {
        const signal = signalMetadata?.signals[item.symbol];
        const entryZone = item.setup && signal?.entryZone;
        const candleCloseTime = Date.parse(item.lastCandleCloseAt ?? '');
        const lifecycleLabel = signal && Date.parse(signal.expiresAt) <= signalNow &&
          ['ACTIVE', 'TP1_HIT', 'TP2_HIT'].includes(signal.status) ? 'EXPIRED' : signal?.status;
        return <article className={`scanner-signal-card ${item.status === 'READY' ? item.side === 'LONG' ? 'is-long' : 'is-short' : 'is-wait'} `} key={item.symbol}>
        <div className="scanner-signal-header">
          <div className="scanner-market-title">
            <span className="scanner-coin-mark">{item.symbol.replace(/USDT$/, '').slice(0, 1)}</span>
            <div><h3>{item.symbol.replace(/USDT$/, '')}<span> / USDT</span></h3><p>{item.marketRank.map((rank) => rank.replace('TOP_', '').replace('_', ' ')).join(' · ')}</p></div>
          </div>
          <div className="scanner-card-meta">
            <span className={`scanner-signal-badge ${item.status === 'READY' ? item.side === 'LONG' ? 'is-long' : 'is-short' : 'is-wait'}`}><span aria-hidden="true">{item.status === 'READY' ? item.side === 'LONG' ? '↗' : '↘' : '•'}</span>{item.status === 'READY' ? item.side : item.status === 'STALE' || item.status === 'DATA_UNAVAILABLE' ? (item.status === 'STALE' ? 'STALE CACHE' : 'NO DATA') : 'WAIT'}</span>
            <div className="scanner-card-score"><span>SETUP SCORE</span><strong>{item.score.value === null ? '—' : `${item.score.value}`}<small>/100</small></strong><small>{item.scannedAt ? `Scanned ${new Date(item.scannedAt).toLocaleString()}` : 'Scan pending'}</small>{Number.isFinite(candleCloseTime) && candleCloseTime <= signalNow && <small>Candle closed {new Date(candleCloseTime).toLocaleString()}</small>}</div>
          </div>
        </div>
        {item.status === 'READY' && signal && signalMetadata && <div className="scanner-expiry-row">
          <span>Signal validity · generated {new Date(signal.generatedAt).toLocaleTimeString()}</span>
          <SignalCountdown expiresAt={signal.expiresAt} serverNow={signalMetadata.serverNow} status={signal.status} />
        </div>}
        {item.status !== 'READY' && lifecycleLabel && <p className="muted">Stored signal status · {lifecycleLabel.replaceAll('_', ' ')}</p>}
        {item.status === 'WAIT' && item.rationale && <p className="muted">{item.rationale}</p>}
        <div className="scanner-price-grid">
          <div className="scanner-price-cell"><span>Price at scan</span><strong>{item.price === null ? '—' : formatPrice(item.price)}</strong><small className={`scanner-change ${item.priceChangePercent24h !== null && item.priceChangePercent24h < 0 ? 'is-negative' : ''}`}>{item.priceChangePercent24h === null ? '24h change unavailable' : `${item.priceChangePercent24h >= 0 ? '+' : ''}${item.priceChangePercent24h.toFixed(2)}% at scan`}</small></div>
          <div className="scanner-price-cell is-entry"><span>{entryZone ? 'Entry zone' : 'Planned entry'}</span><strong>{entryZone ? `${formatPrice(entryZone.low)} – ${formatPrice(entryZone.high)}` : item.setup ? formatPrice(item.setup.entryPrice) : '—'}</strong><small>{entryZone ? 'Stored signal entry range' : item.setup ? 'Reference entry price' : 'No confirmed setup'}</small></div>
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
      </article>;
      })}</div>}
      <p className="scanner-disclaimer">Research feeds provide context, not certainty. Exchange netflow is not verified smart-wallet attribution; news votes are community signals. Setups are informational and do not place orders.</p>
    </section>
  </main>;
}
