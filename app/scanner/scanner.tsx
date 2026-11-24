'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { HighRiskScalping } from './high-risk-scalping';
import { ScannerTabs, type ScannerTab } from './scanner-tabs';
import { AlphaIntelligence } from './alpha-intelligence';
import type { AlphaSnapshot } from '../../lib/alpha-intelligence';
import type { MarketScannerCandidate as ScannerCandidate } from '../../smartexit/apps/api/src/services/market-scanner';
import { recommendedMaxAgeSeconds } from '../../smartexit/apps/api/src/services/market-scanner';
import { applyScannerSignalValidity, savedScannerCandidate } from '../../lib/scanner-snapshot';
import { SignalCountdown } from '../countdown';
import { scannerSymbolPrefix, type SavedScannerResponse, type ScannerCoverage, type ScannerRank } from '../../lib/scanner-universe';
import { SavedResultsRefresh, useSavedResultsPolling, type RefreshMinutes } from './saved-results-refresh';

type SignalMetadata = {
  signals: Record<string, {
    id: string; generatedAt: string; expiresAt: string; status: string;
    entryZone: { low: number; high: number } | null;
  } | null>;
  serverNow: string;
};
type SignalClock = { serverNow: string; receivedAt: number };

function formatPrice(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
}

export function Scanner({ isAdmin, initialTab, alphaSnapshot }: { isAdmin: boolean; initialTab: ScannerTab; alphaSnapshot: AlphaSnapshot }) {
  const [tab, setTab] = useState<ScannerTab>(initialTab);
  const [refreshMinutes, setRefreshMinutes] = useState<RefreshMinutes>(2);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [savedAlpha, setSavedAlpha] = useState(alphaSnapshot);
  const changeTab = useCallback((nextTab: ScannerTab) => {
    setTab(nextTab);
    window.history.replaceState(null, '', nextTab === 'standard' ? '/scanner' : `/scanner?tab=${nextTab}`);
  }, []);
  const toggleWatchlist = useCallback((id: string) => {
    setWatchlist(previous => previous.includes(id) ? previous.filter(entry => entry !== id) : [...previous, id]);
  }, []);

  if (tab === 'alpha') {
    return (
      <main className="shell">
        <ScannerTabs active={tab} onChange={changeTab} />
        <AlphaIntelligence
          snapshot={savedAlpha}
          watchlist={watchlist}
          isAdmin={isAdmin}
          onSnapshot={setSavedAlpha}
          onToggleWatchlist={toggleWatchlist}
        />
      </main>
    );
  }

  return tab === 'standard' ? (
    <StandardSignals
      isAdmin={isAdmin}
      activeTab={tab}
      onTabChange={changeTab}
      refreshMinutes={refreshMinutes}
      onRefreshChange={setRefreshMinutes}
    />
  ) : (
    <HighRiskScalping
      activeTab={tab}
      onTabChange={changeTab}
      isAdmin={isAdmin}
      refreshMinutes={refreshMinutes}
      onRefreshChange={setRefreshMinutes}
    />
  );
}

function StandardSignals({
  isAdmin,
  activeTab,
  onTabChange,
  refreshMinutes,
  onRefreshChange,
}: {
  isAdmin: boolean;
  activeTab: ScannerTab;
  onTabChange: (tab: ScannerTab) => void;
  refreshMinutes: RefreshMinutes;
  onRefreshChange: (minutes: RefreshMinutes) => void;
}) {
  const [savedData, setData] = useState<SavedScannerResponse | null>(null);
  const [signalMetadata, setSignalMetadata] = useState<SignalMetadata | null>(null);
  const [signalClock, setSignalClock] = useState<SignalClock | null>(null);
  const [notificationWarning, setNotificationWarning] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [freshnessNow, setFreshnessNow] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [demoOrderNotice, setDemoOrderNotice] = useState<string | null>(null);
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
    const timeout = window.setTimeout(() => controller.abort(new DOMException('Scanner request timed out.', 'TimeoutError')), 15_000);
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
      setError(timedOut ? 'Reading scanner results timed out. Try refreshing.' :
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
    const freshnessTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setFreshnessNow(performance.now());
    }, 1000);
    return () => {
      requestInFlight.current?.abort();
      requestInFlight.current = null;
      window.clearTimeout(initial);
      window.clearInterval(freshnessTimer);
    };
  }, [load]);

  useSavedResultsPolling(load, refreshMinutes);

  const signalNow = signalClock
    ? Date.parse(signalClock.serverNow) + Math.max(0, freshnessNow - signalClock.receivedAt)
    : 0;
  const candidates = (data?.candidates ?? []).map((candidate) => applyScannerSignalValidity(
    savedScannerCandidate(candidate, candidate.scannedAt ?? '', data?.configuration.maxAgeSeconds ?? recommendedMaxAgeSeconds(timeframe), signalNow),
    signalMetadata?.signals[candidate.symbol],
    signalNow,
  ));
  const ready = candidates.filter((item) => item.status === 'READY' && item.setup);
  const longSignals = ready.filter((item) => item.side === 'LONG').length;
  const shortSignals = ready.filter((item) => item.side === 'SHORT').length;
  const persistedSetups = ready.filter((item) => signalMetadata?.signals[item.symbol]).length;
  const pageCount = data ? Math.max(1, Math.ceil(data.matchingCount / data.selection.limit)) : 1;
  const recentCount = data?.recentUntil?.filter(expiry => Number.isFinite(expiry) && expiry >= signalNow).length ?? 0;
  const degraded = Boolean(data && recentCount < data.eligibleCount);

  function executeDemoOrder(item: (typeof candidates)[number]) {
    setDemoOrderNotice(`Demo trade simulated: ${item.side} ${item.symbol} at ${item.setup?.entryPrice ?? 'market'} (Virtual funds). No real money involved.`);
    window.setTimeout(() => setDemoOrderNotice(null), 5000);
  }

  return (
    <main className="shell">
      <ScannerTabs active={activeTab} onChange={onTabChange} />

      <section className="hero">
        <p className="mono">MARKET INTELLIGENCE · BINANCE USDⓈ-M FUTURES</p>
        <h1>Smart Signal Scanner</h1>
        <p className="muted">
          Real-time algorithmic confluence scanner detecting high-conviction momentum and trend continuation setups across 300+ liquid cryptocurrency pairs.
        </p>
      </section>

      {demoOrderNotice && (
        <div className="success" role="alert" style={{ marginBottom: 18 }}>
          ✓ {demoOrderNotice}
        </div>
      )}

      <section className="scanner-overview" aria-label="Scanner summary">
        <article className="scanner-stat-card scanner-stat-primary">
          <span className="scanner-stat-label">Qualified Setups (Score ≥ 60)</span>
          <strong>{data && coverage !== 'eligible' ? ready.length : '—'}</strong>
          <span className="scanner-stat-foot">
            {coverage === 'eligible' ? 'Directory mode' : `${longSignals} Long · ${shortSignals} Short · ${persistedSetups} Persisted`}
          </span>
        </article>

        <article className="scanner-stat-card">
          <span className="scanner-stat-label">Monitored Exchange Pairs</span>
          <strong>{data?.eligibleCount ?? '—'}</strong>
          <span className="scanner-stat-foot">
            {data?.universeSyncedAt ? `Universe synced ${new Date(data.universeSyncedAt).toLocaleTimeString()}` : 'Live Binance USDⓈ-M'}
          </span>
        </article>

        <article className="scanner-stat-card">
          <span className="scanner-stat-label">Active Timeframe</span>
          <strong>{timeframe.toUpperCase()}</strong>
          <span className="scanner-stat-foot">
            {data?.watchlistCount ?? 30} Core Research Pairs
          </span>
        </article>

        <article className="scanner-stat-card">
          <span className="scanner-stat-label">Scanner Health</span>
          <strong style={{ color: degraded ? '#f59e0b' : '#10b981' }}>
            {loading ? 'Refreshing…' : degraded ? 'Syncing Feeds' : 'Optimal · 100%'}
          </strong>
          <span className="scanner-stat-foot">
            {lastCheckedAt ? `Checked ${new Date(lastCheckedAt).toLocaleTimeString()}` : 'Connecting to feed…'}
          </span>
        </article>
      </section>

      <section className="card stack">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>Scanner Controls & Filters</h2>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              Filter by timeframe, rank, or specific cryptocurrency asset.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setSoundEnabled(!soundEnabled)}
              title={soundEnabled ? 'Mute signal sound alerts' : 'Enable signal sound alerts'}
            >
              {soundEnabled ? '🔔 Sound: ON' : '🔕 Sound: OFF'}
            </button>
            <SavedResultsRefresh minutes={refreshMinutes} onChange={onRefreshChange} />
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="button"
            >
              {loading ? 'Scanning…' : '⟳ Refresh'}
            </button>
            {isAdmin && (
              <Link href="/admin#scanner-management" className="button-secondary" style={{ padding: '8px 12px', fontSize: 12 }}>
                Admin Coins
              </Link>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <label>
            Timeframe
            <select
              value={timeframe}
              onChange={(e) => {
                setTimeframe(e.target.value as ScannerCandidate['timeframe']);
                setSelection({ ...selection, page: 1 });
              }}
            >
              <option value="5m">5 Minutes (Scalp)</option>
              <option value="15m">15 Minutes (Intraday)</option>
              <option value="1h">1 Hour (Swing)</option>
              <option value="4h">4 Hours (Macro)</option>
            </select>
          </label>

          <label>
            Coverage
            <select
              value={coverage}
              onChange={(e) => setSelection({ ...selection, coverage: e.target.value as ScannerCoverage, rank: null, page: 1 })}
            >
              <option value="saved">Active Signal Candidates</option>
              <option value="watchlist">Fixed High-Liquidity Watchlist</option>
              <option value="eligible">All Monitored Perpetual Contracts</option>
            </select>
          </label>

          {coverage === 'saved' && (
            <label>
              Liquidity Rank
              <select
                value={rank ?? ''}
                onChange={(e) => setSelection({ ...selection, rank: (e.target.value || null) as ScannerRank | null, page: 1 })}
              >
                <option value="">All Ranks</option>
                <option value="TOP_VOLUME">Top 24h Volume</option>
                <option value="TOP_GAINER">Top Gainers</option>
                <option value="TOP_LOSER">Top Losers</option>
              </select>
            </label>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const normalized = symbolInput.trim().toUpperCase();
              if (normalized && !scannerSymbolPrefix.test(normalized)) {
                setFilterError('Invalid symbol prefix.');
                return;
              }
              setFilterError('');
              setSelection({ ...selection, symbol: normalized, page: 1 });
            }}
            style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}
          >
            <label style={{ flex: 1 }}>
              Symbol Search
              <input
                value={symbolInput}
                maxLength={30}
                placeholder="e.g. BTC, ETH, SOL"
                onChange={(e) => setSymbolInput(e.target.value)}
              />
            </label>
            <button type="submit" className="button-secondary">Find</button>
            {symbol && (
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setSymbolInput('');
                  setFilterError('');
                  setSelection({ ...selection, symbol: '', page: 1 });
                }}
              >
                Clear
              </button>
            )}
          </form>
        </div>

        {filterError && <p className="error" role="alert">{filterError}</p>}
        {error && <div className="error" role="alert">{error}</div>}
        {notificationWarning && <div className="error" role="status">{notificationWarning}</div>}

        {/* Signals List */}
        {candidates.length > 0 ? (
          <div className="scanner-signal-list">
            {candidates.map((item) => {
              const signal = signalMetadata?.signals[item.symbol];
              const entryZone = item.setup && signal?.entryZone;
              const isReady = item.status === 'READY';
              const isLong = item.side === 'LONG';

              return (
                <article
                  key={item.symbol}
                  className={`scanner-signal-card ${isReady ? (isLong ? 'is-long' : 'is-short') : 'is-wait'}`}
                >
                  <div className="scanner-signal-header">
                    <div className="scanner-market-title">
                      <span className="scanner-coin-mark">{item.symbol.replace(/USDT$/, '').slice(0, 3)}</span>
                      <div>
                        <h3>
                          {item.symbol.replace(/USDT$/, '')}
                          <span> / USDT Perpetual</span>
                        </h3>
                        <p>{item.marketRank?.join(' · ').replaceAll('_', ' ') || 'Binance USDⓈ-M'}</p>
                      </div>
                    </div>

                    <div className="scanner-card-meta">
                      <span className={`scanner-signal-badge ${isReady ? (isLong ? 'is-long' : 'is-short') : 'is-wait'}`}>
                        {isReady ? (isLong ? 'LONG ↗' : 'SHORT ↘') : 'WAITING'}
                      </span>
                      <div className="scanner-card-score">
                        <span>CONFLUENCE SCORE</span>
                        <strong>{item.score.value ?? '—'}<small>/100</small></strong>
                      </div>
                    </div>
                  </div>

                  {isReady && signal && signalMetadata && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--surface-border)', fontSize: 12 }}>
                      <span className="muted">Signal Validity Window</span>
                      <SignalCountdown expiresAt={signal.expiresAt} serverNow={signalMetadata.serverNow} status={signal.status} />
                    </div>
                  )}

                  <div className="scanner-price-grid">
                    <div className="scanner-price-cell">
                      <span>Market Price</span>
                      <strong>{item.price ? formatPrice(item.price) : '—'}</strong>
                      <small style={{ color: (item.priceChangePercent24h ?? 0) >= 0 ? '#16a34a' : '#dc2626' }}>
                        {(item.priceChangePercent24h ?? 0) >= 0 ? '+' : ''}{(item.priceChangePercent24h ?? 0).toFixed(2)}% (24h)
                      </small>
                    </div>

                    <div className="scanner-price-cell is-entry">
                      <span>{entryZone ? 'Optimal Entry Zone' : 'Reference Entry'}</span>
                      <strong>
                        {entryZone ? `${formatPrice(entryZone.low)} – ${formatPrice(entryZone.high)}` : item.setup ? formatPrice(item.setup.entryPrice) : 'Awaiting confirmation'}
                      </strong>
                      <small>Technical trigger level</small>
                    </div>

                    <div className="scanner-price-cell is-stop">
                      <span>Invalidation / Stop Loss</span>
                      <strong>{item.setup ? formatPrice(item.setup.initialStop) : '—'}</strong>
                      <small>Risk controlled</small>
                    </div>
                  </div>

                  <div className="scanner-target-section">
                    <div className="scanner-target-heading">
                      <span>PROFIT TARGETS (DYNAMIC R:R)</span>
                      <span>Target Multiples</span>
                    </div>
                    <div className="scanner-target-grid">
                      <div className={`scanner-target-card ${item.setup?.tp1 ? 'is-active' : ''}`}>
                        <span>TP1 (1.5R)</span>
                        <strong>{item.setup?.tp1 ? formatPrice(item.setup.tp1) : '—'}</strong>
                      </div>
                      <div className={`scanner-target-card ${item.setup?.tp2 ? 'is-active' : ''}`}>
                        <span>TP2 (2.5R)</span>
                        <strong>{item.setup?.tp2 ? formatPrice(item.setup.tp2) : '—'}</strong>
                      </div>
                      <div className={`scanner-target-card ${item.setup?.tp3 ? 'is-active' : ''}`}>
                        <span>TP3 (4.0R)</span>
                        <strong>{item.setup?.tp3 ? formatPrice(item.setup.tp3) : '—'}</strong>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--surface-border)' }}>
                    <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                      {item.rationale || 'Multi-indicator confluence: EMA stack alignment, Supertrend direction, ADX momentum, and RSI trigger.'}
                    </p>
                    <button
                      type="button"
                      className="button"
                      onClick={() => executeDemoOrder(item)}
                      style={{ fontSize: 12, padding: '8px 14px' }}
                    >
                      Execute Demo Trade
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="card" style={{ textAlign: 'center', padding: '40px 20px' }}>
            <span style={{ fontSize: 36, display: 'block', marginBottom: 12 }}>📊</span>
            <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>Scanner Operational — Monitoring Market Feeds</h3>
            <p className="muted" style={{ maxWidth: 600, margin: '0 auto 18px', fontSize: 13, lineHeight: 1.6 }}>
              The SmartExit quantitative engine is scanning all Binance USDⓈ-M perpetual contracts. When a coin meets strict multi-indicator confluence (EMA 9/21/50/200 stack, Supertrend, ADX &gt; 20, RSI bounds) with score ≥ 60, actionable setup cards appear here automatically.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
              <button type="button" onClick={() => void load()} className="button">
                Scan Again Now
              </button>
              <Link href="/scanner/history" className="button-secondary" style={{ padding: '10px 16px', borderRadius: 8 }}>
                View Signal History
              </Link>
            </div>
          </div>
        )}

        {/* Pagination */}
        {data && (page > 1 || data.matchingCount > data.selection.limit) && (
          <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
            <button
              type="button"
              className="button-secondary"
              disabled={page === 1 || loading}
              onClick={() => setSelection({ ...selection, page: page - 1 })}
            >
              Previous
            </button>
            <span className="mono">
              Page {page} of {pageCount} ({data.matchingCount} pairs)
            </span>
            <button
              type="button"
              className="button-secondary"
              disabled={page >= pageCount || loading}
              onClick={() => setSelection({ ...selection, page: page + 1 })}
            >
              Next
            </button>
          </nav>
        )}
      </section>
    </main>
  );
}
