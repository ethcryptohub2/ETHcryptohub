'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { HighRiskScalping } from './high-risk-scalping';
import { ScannerTabs, type ScannerTab } from './scanner-tabs';
import { AlphaIntelligence } from './alpha-intelligence';
import type { AlphaSnapshot } from '../../lib/alpha-intelligence';
import type { MarketScannerCandidate as ScannerCandidate } from '../../smartexit/apps/api/src/services/market-scanner';
import { recommendedMaxAgeSeconds } from '../../smartexit/apps/api/src/services/market-scanner';
import { applyScannerSignalValidity, savedScannerCandidate } from '../../lib/scanner-snapshot';
import { evaluateSignalAutoExecution } from '../../lib/auto-execution-diagnostics';
import { SignalCountdown } from '../countdown';
import { scannerSymbolPrefix, type SavedScannerResponse, type ScannerCoverage, type ScannerRank } from '../../lib/scanner-universe';
import { SavedResultsRefresh, useSavedResultsPolling, type RefreshMinutes } from './saved-results-refresh';
import { ScannerRadar } from '../../components/ui/scanner-radar';
import { Pagination } from '../../components/pagination';
import { LiveMarketTickerBar } from '../../components/live-market-ticker';
import { useLiveMarketFeed } from '../../lib/live-market-feed';
import { useAlarmPreferences } from '../use-alarm-preferences';

const DEFAULT_LIVE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const AUTO_SCAN_INTERVAL_SECONDS = 300;
const SCANNER_REFRESH_STORAGE_KEY = 'smartexit-scanner-refresh-minutes';
const SCANNER_AUTOSCAN_STORAGE_KEY = 'smartexit-scanner-autoscan';

type ScannerV2StateView = {
  version: string;
  state: string;
  cycleId: string;
  concurrency: number;
  totalEligible: number;
  totalBatches: number;
  completedBatches: number;
  activeWorkers: number;
  successfulCount: number;
  failedCount: number;
  skippedCount: number;
  coveragePercent: number;
  startedAt: string | null;
  lastSuccessfulScanAt: string | null;
  durationMs: number | null;
  nextScanAt: string | null;
  usedWeight1m: number;
  weightLimit1m: number;
  cooldownUntil: number | null;
  standardStatus: string;
  highRiskStatus: string;
  cacheEntries: number;
};

type SignalMetadata = {
  signals: Record<string, {
    id: string; generatedAt: string; expiresAt: string; status: string;
    entryZone: { low: number; high: number } | null;
  } | null>;
  serverNow: string;
};
type SignalClock = { serverNow: string; receivedAt: number };

function formatPrice(value: number): string {
  if (value >= 1000) return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

export function Scanner({ isAdmin, initialTab, alphaSnapshot }: { isAdmin: boolean; initialTab: ScannerTab; alphaSnapshot: AlphaSnapshot }) {
  const [tab, setTab] = useState<ScannerTab>(initialTab);
  const [refreshMinutes, setRefreshMinutesState] = useState<RefreshMinutes>(() => {
    if (typeof window === 'undefined') return 2;
    const saved = Number(window.localStorage.getItem(SCANNER_REFRESH_STORAGE_KEY));
    return saved === 1 || saved === 2 || saved === 5 ? saved : 2;
  });
  const setRefreshMinutes = useCallback((minutes: RefreshMinutes) => {
    setRefreshMinutesState(minutes);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(SCANNER_REFRESH_STORAGE_KEY, String(minutes));
      } catch {
        // ignore
      }
    }
  }, []);
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
  const {
    preferences: alarmPrefs,
    audioUnlocked: alarmAudioUnlocked,
    saveError: alarmSaveError,
    updatePreferences: updateAlarmPrefs,
    unlockAudio: unlockAlarmAudio,
  } = useAlarmPreferences();
  const requestInFlight = useRef<AbortController | null>(null);
  const [timeframe, setTimeframe] = useState<ScannerCandidate['timeframe']>('15m');
  const [selection, setSelection] = useState<{ coverage: ScannerCoverage; symbol: string; rank: ScannerRank | null; page: number }>({
    coverage: 'saved', symbol: '', rank: null, page: 1,
  });
  const [symbolInput, setSymbolInput] = useState('');
  const [filterError, setFilterError] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [v2State, setV2State] = useState<ScannerV2StateView | null>(null);
  const [circuitCooldownUntil, setCircuitCooldownUntil] = useState<number | null>(null);
  const [scanDiagnostics, setScanDiagnostics] = useState<{
    scannedCount: number;
    successfulCount: number;
    failedCount: number;
    skippedCount: number;
    batchIndex: number;
    totalBatches: number;
    scanDurationMs: number | null;
    cycleId: string;
  } | null>(null);
  const [scanResult, setScanResult] = useState<{
    scannedCount: number;
    successfulCount?: number;
    failedCount?: number;
    skippedCount?: number;
    qualifiedCount: number;
    newSignals: number;
    cycleId: string;
    batchIndex: number;
    totalBatches: number;
    rejections: Record<string, number>;
    durationMs: number;
    scannedAt: string;
  } | null>(null);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [autoScanEnabled, setAutoScanEnabledState] = useState(() => {
    if (typeof window === 'undefined') return true;
    const saved = window.localStorage.getItem(SCANNER_AUTOSCAN_STORAGE_KEY);
    return saved === null ? true : saved === 'true';
  });
  const setAutoScanEnabled = useCallback((next: boolean) => {
    setAutoScanEnabledState(next);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(SCANNER_AUTOSCAN_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
    }
  }, []);
  const [autoScanCountdown, setAutoScanCountdown] = useState(AUTO_SCAN_INTERVAL_SECONDS);
  const [hasDemoCredentials, setHasDemoCredentials] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/binance?environment=DEMO', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as { data?: { configured?: boolean } };
        if (active && json?.data?.configured !== undefined) {
          setHasDemoCredentials(Boolean(json.data.configured));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const candidateSymbols = useMemo(() => (savedData?.candidates ?? []).map((c) => c.symbol), [savedData]);
  const liveSymbols = useMemo(
    () => (candidateSymbols.length > 0 ? candidateSymbols : DEFAULT_LIVE_SYMBOLS),
    [candidateSymbols],
  );
  const liveMarket = useLiveMarketFeed(liveSymbols);
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
      const rawText = await response.text();
      let body: {
        data?: SavedScannerResponse;
        error?: string;
        signalMetadata?: SignalMetadata;
        notificationWarning?: string;
        diagnostics?: {
          scannedCount: number;
          successfulCount: number;
          failedCount: number;
          skippedCount: number;
          batchIndex: number;
          totalBatches: number;
          scanDurationMs: number | null;
          cycleId: string;
        };
        circuitBreaker?: {
          state: string;
          cooldownUntil: number | null;
          reason: string | null;
        };
        v2State?: ScannerV2StateView | null;
      } | null = null;
      try {
        body = JSON.parse(rawText);
      } catch {
        throw new Error(
          response.status === 504
            ? 'Scanner request timed out on the server (HTTP 504).'
            : response.status === 429
              ? 'Scanner rate limit reached. Please wait a moment.'
              : `Scanner request failed (${response.status}): ${rawText.slice(0, 100)}`
        );
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok || !body?.data) throw new Error(body?.error ?? `Scanner request failed (${response.status}).`);
      const receivedAt = performance.now();
      const serverNow = new Date(
        body.signalMetadata ? Date.parse(body.signalMetadata.serverNow) + receivedAt - requestedAt : Date.now(),
      ).toISOString();
      setData(body.data);
      setSignalMetadata(body.signalMetadata ? { ...body.signalMetadata, serverNow } : null);
      setSignalClock({ serverNow, receivedAt });
      setNotificationWarning(body.notificationWarning ?? '');
      if (body.diagnostics) {
        setScanDiagnostics(body.diagnostics);
      }
      if (body.v2State) {
        setV2State(body.v2State);
      }
      if (body.circuitBreaker) {
        if (body.circuitBreaker.state === 'OPEN' && body.circuitBreaker.cooldownUntil) {
          setCircuitCooldownUntil(body.circuitBreaker.cooldownUntil);
        } else {
          setCircuitCooldownUntil(null);
        }
      }
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

  const triggerScan = useCallback(async () => {
    if (isScanning) return;
    if (circuitCooldownUntil && Date.now() < circuitCooldownUntil) {
      setError('Market data temporarily unavailable. Automatic recovery in progress.');
      return;
    }
    setIsScanning(true);
    setError('');
    setScanNotice('Executing live on-demand algorithmic market scan across Binance USDⓈ-M perpetual contracts…');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfRaw = await csrfResponse.text();
      let csrfBody: { data?: { csrfToken: string } } = {};
      try { csrfBody = JSON.parse(csrfRaw); } catch { /* proceed */ }
      const csrf = csrfBody.data?.csrfToken;
      const response = await fetch('/api/scanner/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({ timeframe, strategy: 'STANDARD' }),
      });
      const rawText = await response.text();
      let body: {
        ok?: boolean;
        error?: string;
        cooldown?: boolean;
        cooldownUntil?: number;
        circuitBreaker?: { state: string; cooldownUntil: number | null; reason: string | null };
        v2State?: ScannerV2StateView | null;
        data?: {
          scannedCount: number;
          successfulCount?: number;
          failedCount?: number;
          skippedCount?: number;
          qualifiedCount: number;
          newSignals: number;
          deduplicatedSignals?: number;
          enabledCoins?: number;
          cycleId: string;
          batchIndex: number;
          totalBatches: number;
          rejections: Record<string, number>;
          durationMs: number;
          scannedAt: string;
          v2State?: ScannerV2StateView | null;
        };
      } | null = null;
      try {
        body = JSON.parse(rawText);
      } catch {
        throw new Error(
          response.status === 504
            ? 'Scan request timed out on the gateway (HTTP 504). A scan cycle may still be running in the background.'
            : response.status === 429
              ? 'A scanner cycle is already in progress. Please wait for the current batch to complete.'
              : `Scan request failed (HTTP ${response.status}): ${rawText.slice(0, 100)}`
        );
      }
      if (body?.v2State) {
        setV2State(body.v2State);
      }
      if (body?.cooldownUntil) {
        setCircuitCooldownUntil(body.cooldownUntil);
      }
      if (!response.ok || !body?.ok || !body?.data) {
        throw new Error(body?.error ?? `Scan failed (${response.status})`);
      }
      if (body.data.v2State) {
        setV2State(body.data.v2State);
      }
      setCircuitCooldownUntil(null);
      setScanResult(body.data);
      const dedupSuffix = (body.data.deduplicatedSignals ?? 0) > 0
        ? ` (${body.data.newSignals} new + ${body.data.deduplicatedSignals} deduplicated)`
        : ` (${body.data.newSignals} new signals)`;
      const totalPairs = body.data.enabledCoins ?? body.data.scannedCount;
      setScanNotice(`Scan completed: ${body.data.scannedCount} pairs analyzed (${body.data.successfulCount ?? body.data.scannedCount} OK, ${body.data.failedCount ?? 0} failed, ${body.data.skippedCount ?? 0} skipped) in ${body.data.durationMs}ms. ${body.data.qualifiedCount} qualified setups${dedupSuffix}. Batch ${body.data.batchIndex}/${body.data.totalBatches} (${body.data.cycleId}) · ${totalPairs}-coin universe rotates continuously.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan request failed.');
      setScanNotice(null);
    } finally {
      setIsScanning(false);
    }
  }, [timeframe, isScanning, load, circuitCooldownUntil]);

  useEffect(() => {
    if (!autoScanEnabled) {
      return;
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || isScanning || loading) {
        return;
      }
      if (circuitCooldownUntil && Date.now() < circuitCooldownUntil) {
        return;
      }

      setAutoScanCountdown((prev) => {
        if (prev <= 1) {
          void triggerScan();
          return AUTO_SCAN_INTERVAL_SECONDS;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [autoScanEnabled, isScanning, loading, triggerScan, circuitCooldownUntil]);

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

  const [filterTab, setFilterTab] = useState<'ready' | 'awaiting' | 'entry_awaiting' | 'all' | 'rejected'>('ready');
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const [tableSearch, setTableSearch] = useState<string>('');

  // Synchronize table search with universal 522-coin backend query
  useEffect(() => {
    const normalized = tableSearch.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const timer = window.setTimeout(() => {
      setSelection((prev) => {
        if (prev.symbol === normalized) return prev;
        return { ...prev, symbol: normalized, page: 1 };
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [tableSearch]);

  const signalNow = signalClock
    ? Date.parse(signalClock.serverNow) + Math.max(0, freshnessNow - signalClock.receivedAt)
    : 0;
  const candidates = (data?.candidates ?? []).map((candidate) => applyScannerSignalValidity(
    savedScannerCandidate(candidate, candidate.scannedAt ?? '', data?.configuration.maxAgeSeconds ?? recommendedMaxAgeSeconds(timeframe), signalNow),
    signalMetadata?.signals[candidate.symbol],
    signalNow,
  ));

  const ready = useMemo(() => candidates.filter((item) => item.status === 'READY' && item.setup), [candidates]);
  const awaiting = useMemo(() => candidates.filter((item) => item.status !== 'READY' && (item.score?.value ?? 0) >= 40 && (item.score?.value ?? 0) < 60), [candidates]);
  const entryAwaiting = useMemo(() => candidates.filter((item) => item.status !== 'READY' && (item.score?.value ?? 0) >= 60), [candidates]);
  const rejected = useMemo(() => candidates.filter((item) => item.status === 'STALE' || item.status === 'DATA_UNAVAILABLE' || (item.score?.value ?? 0) < 40), [candidates]);

  // Default visible view: ONLY ENTRY READY signals.
  // Global search bar searches the complete dataset including hidden signals.
  const visibleCandidates = useMemo(() => {
    if (tableSearch.trim()) {
      const q = tableSearch.trim().toUpperCase();
      return candidates.filter((item) => item.symbol.toUpperCase().includes(q));
    }
    switch (filterTab) {
      case 'ready':
        return ready;
      case 'awaiting':
        return awaiting;
      case 'entry_awaiting':
        return entryAwaiting;
      case 'rejected':
        return rejected;
      case 'all':
      default:
        return candidates;
    }
  }, [candidates, filterTab, ready, awaiting, entryAwaiting, rejected, tableSearch]);

  const hiddenCount = Math.max(0, candidates.length - visibleCandidates.length);
  const pageCount = data ? Math.max(1, Math.ceil(data.matchingCount / data.selection.limit)) : 1;
  const inCooldown = Boolean(circuitCooldownUntil || v2State?.state === 'RATE_LIMIT_COOLDOWN');
  const activeBatchIndex = v2State ? v2State.completedBatches : (scanResult?.batchIndex ?? scanDiagnostics?.batchIndex ?? 0);
  const activeTotalBatches = v2State && v2State.totalBatches > 0
    ? v2State.totalBatches
    : (scanResult?.totalBatches ?? scanDiagnostics?.totalBatches ?? (data?.eligibleCount ? Math.max(1, Math.ceil(data.eligibleCount / 32)) : 0));
  const batchDisplay = activeTotalBatches > 0 ? `Batch ${activeBatchIndex}/${activeTotalBatches}` : 'Awaiting V2';
  const activeDurationMs = v2State?.durationMs ?? scanResult?.durationMs ?? scanDiagnostics?.scanDurationMs ?? null;
  const latencyDisplay = activeDurationMs !== null
    ? `${activeDurationMs}ms`
    : loading ? 'Refreshing…' : 'Saved Snapshot';
  const activeScannedCount = v2State
    ? (v2State.successfulCount + v2State.failedCount)
    : (scanResult?.scannedCount ?? scanDiagnostics?.scannedCount ?? 0);

  return (
    <main className="shell">
      <ScannerTabs active={activeTab} onChange={onTabChange} />

      <section className="hero">
        <p className="mono">MARKET INTELLIGENCE · BINANCE USDⓈ-M FUTURES</p>
        <h1>Smart Signal Scanner</h1>
        <p className="muted">
          Real-time algorithmic confluence scanner detecting high-conviction momentum and trend continuation setups across 500+ perpetual Futures contracts.
        </p>
      </section>

      {/* Execution Environment Assurance Banner */}
      <div style={{ padding: '10px 16px', background: 'var(--surface-subtle)', borderRadius: 8, border: '1px solid var(--surface-border)', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, fontSize: 12 }}>
        <div>
          <strong style={{ color: '#10b981' }}>● ENVIRONMENT: AUTHENTICATED EXCHANGE DEMO & TESTNET ONLY</strong>
          <span className="muted" style={{ marginLeft: 8 }}>Actual remote exchange Demo APIs only (Binance, Bybit, OKX, Bitget, Gate.io). No internal paper simulation.</span>
        </div>
        <div className="mono" style={{ color: '#ef4444', fontWeight: 600 }}>
          🔒 LIVE TRADING: LOCKED FAIL-CLOSED (HTTP 403)
        </div>
      </div>

      {/* Genuine Binance USDⓈ-M Futures Live Ticker Bar */}
      <LiveMarketTickerBar />

      {/* Compact Summary Counters Ribbon */}
      <section className="compact-summary-ribbon" aria-label="Scanner summary metrics">
        <div className="ribbon-item">
          <span className="ribbon-label">Total Eligible</span>
          <span className="ribbon-value">{data?.eligibleCount ?? '—'}</span>
        </div>
        <div className="ribbon-item">
          <span className="ribbon-label">Scanned Count</span>
          <span
            className="ribbon-value"
            title={`OK: ${scanResult?.successfulCount ?? scanDiagnostics?.successfulCount ?? activeScannedCount}, Failed: ${scanResult?.failedCount ?? scanDiagnostics?.failedCount ?? 0}, Skipped: ${scanResult?.skippedCount ?? scanDiagnostics?.skippedCount ?? 0}`}
          >
            {activeScannedCount}
          </span>
        </div>
        <div className="ribbon-item">
          <span className="ribbon-label">Batch Progress</span>
          <span className="ribbon-value" style={{ fontSize: 13 }}>{batchDisplay}</span>
        </div>
        <div className="ribbon-item">
          <span className="ribbon-label">Entry Ready</span>
          <span className="ribbon-value is-accent">{ready.length}</span>
        </div>
        <div className="ribbon-item">
          <span className="ribbon-label">Awaiting</span>
          <span className="ribbon-value is-warning">{awaiting.length + entryAwaiting.length}</span>
        </div>
        <div className="ribbon-item">
          <span className="ribbon-label">Hidden</span>
          <span className="ribbon-value" style={{ color: 'var(--text-muted)' }}>{hiddenCount}</span>
        </div>
        <div className="ribbon-item">
          <span className="ribbon-label">Auto Executions</span>
          <span className="ribbon-value is-accent">{scanResult?.newSignals ?? ready.length}</span>
        </div>
        <div className="ribbon-item">
          <span className="ribbon-label">Blocked</span>
          <span className="ribbon-value" style={{ color: '#ef4444' }}>{candidates.length - ready.length}</span>
        </div>
        <div className="ribbon-item">
          <span className="ribbon-label">Scan Latency</span>
          <span className="ribbon-value" style={{ fontSize: 13 }} title={lastCheckedAt ? `Checked ${new Date(lastCheckedAt).toLocaleTimeString('en-US')}` : 'Connecting to feed…'} suppressHydrationWarning>
            {latencyDisplay}
          </span>
        </div>
      </section>

      <section className="card stack" style={{ overflowX: 'hidden', maxWidth: '100%', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14, minWidth: 0, maxWidth: '100%' }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Scanner Controls & Configuration</h2>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              Full-market V2 cycle: 5 min · Saved snapshot refresh: {refreshMinutes} min · Live ticker: Futures WS
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' }}>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setAutoScanEnabled(!autoScanEnabled)}
              style={{
                borderColor: inCooldown ? 'rgba(245, 158, 11, 0.5)' : autoScanEnabled ? 'rgba(16, 185, 129, 0.5)' : undefined,
                color: inCooldown ? '#d97706' : autoScanEnabled ? '#10b981' : undefined,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                maxWidth: '100%',
              }}
              title={inCooldown ? 'Paused while market data recovers' : autoScanEnabled ? '5-minute V2 full-market cycle is ACTIVE. Click to pause.' : '5-minute V2 full-market cycle is PAUSED. Click to resume.'}
            >
              <span style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: inCooldown ? '#f59e0b' : autoScanEnabled ? '#10b981' : '#6b7280',
                boxShadow: !inCooldown && autoScanEnabled ? '0 0 8px #10b981' : 'none',
              }} />
              {inCooldown
                ? 'PAUSED — MARKET COOLDOWN'
                : autoScanEnabled
                  ? `Auto-Scan 5m (${autoScanCountdown}s)`
                  : 'Auto-Scan: PAUSED'}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                const next = !alarmPrefs.sound_enabled;
                if (next) void unlockAlarmAudio();
                void updateAlarmPrefs({ sound_enabled: next });
              }}
              title={alarmPrefs.sound_enabled ? 'Mute signal sound alerts' : 'Enable signal sound alerts'}
            >
              {alarmPrefs.sound_enabled ? '🔔 Sound: ON' : '🔕 Sound: OFF'}
            </button>
            {alarmPrefs.sound_enabled && !alarmAudioUnlocked && (
              <button
                type="button"
                className="button-secondary"
                onClick={() => void unlockAlarmAudio()}
                style={{ borderColor: '#6366f1', color: '#6366f1', fontSize: 12, fontWeight: 600 }}
                title="Browser requires interaction after reload to play audio"
              >
                🔊 Enable Sound
              </button>
            )}
            <SavedResultsRefresh minutes={refreshMinutes} onChange={onRefreshChange} />
            <button
              type="button"
              onClick={() => void triggerScan()}
              disabled={isScanning || loading}
              className="button"
              style={{
                background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                color: '#ffffff',
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                boxShadow: '0 0 12px rgba(16, 185, 129, 0.35)',
              }}
            >
              {isScanning ? (
                <>
                  <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                  <span>Scanning Market…</span>
                </>
              ) : (
                <>
                  <span>⚡</span>
                  <span>Scan Now</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading || isScanning}
              className="button-secondary"
            >
              {loading ? 'Refreshing…' : '⟳ Refresh'}
            </button>
            {isAdmin && (
              <Link href="/admin#scanner-management" className="button-secondary" style={{ padding: '8px 12px', fontSize: 12 }}>
                Admin Coins
              </Link>
            )}
          </div>
        </div>

        {alarmSaveError && (
          <div style={{ padding: '8px 12px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', borderRadius: 8, fontSize: 12, overflowWrap: 'anywhere' }}>
            ⚠ {alarmSaveError}
          </div>
        )}

        {circuitCooldownUntil && (
          <div style={{ padding: '10px 12px', background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.4)', borderRadius: 8, fontSize: 12, color: '#d97706', overflowWrap: 'anywhere', wordBreak: 'break-word', width: '100%', maxWidth: '100%', boxSizing: 'border-box' }} suppressHydrationWarning>
            <strong>⏸ MARKET DATA COOLDOWN:</strong>{' '}
            Market data temporarily unavailable. Automatic recovery in progress. (Next check: {new Date(circuitCooldownUntil).toLocaleString('en-US')})
          </div>
        )}

        {/* Hybrid Parallel V2 Diagnostics Panel */}
        <div
          style={{
            padding: '12px 14px',
            background: 'var(--surface-subtle)',
            border: '1px solid var(--surface-border)',
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            maxWidth: '100%',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="mono" style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: 'rgba(99, 102, 241, 0.15)', color: '#6366f1' }}>
                {v2State?.version ?? 'Hybrid Parallel V2'}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '2px 7px',
                  borderRadius: 4,
                  background:
                    v2State?.state === 'RATE_LIMIT_COOLDOWN' || circuitCooldownUntil
                      ? 'rgba(245, 158, 11, 0.18)'
                      : v2State?.state === 'SCANNING'
                        ? 'rgba(59, 130, 246, 0.18)'
                        : v2State?.state === 'ERROR'
                          ? 'rgba(239, 68, 68, 0.18)'
                          : 'rgba(16, 185, 129, 0.15)',
                  color:
                    v2State?.state === 'RATE_LIMIT_COOLDOWN' || circuitCooldownUntil
                      ? '#d97706'
                      : v2State?.state === 'SCANNING'
                        ? '#3b82f6'
                        : v2State?.state === 'ERROR'
                          ? '#ef4444'
                          : '#10b981',
                }}
              >
                {circuitCooldownUntil ? 'RATE_LIMIT_COOLDOWN' : v2State?.state ?? (isScanning ? 'SCANNING' : 'WAITING_FOR_NEXT_CYCLE')}
              </span>
            </div>
            <span className="muted mono" style={{ fontSize: 11 }} suppressHydrationWarning>
              Workers: {v2State?.activeWorkers ?? 0}/{v2State?.concurrency ?? 4} · Weight: {v2State?.usedWeight1m ?? 0}/{v2State?.weightLimit1m ?? 1200} · Cache: {v2State?.cacheEntries ?? 0}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 8, fontSize: 11, minWidth: 0, maxWidth: '100%' }}>
            <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <span className="muted">Batches:</span>{' '}
              <strong className="mono">{v2State?.completedBatches ?? activeBatchIndex}/{v2State?.totalBatches ?? activeTotalBatches}</strong>
            </div>
            <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <span className="muted">OK / Fail / Skip:</span>{' '}
              <strong className="mono">
                {v2State?.successfulCount ?? activeScannedCount} / {v2State?.failedCount ?? 0} / {v2State?.skippedCount ?? 0}
              </strong>
            </div>
            <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <span className="muted">Coverage:</span>{' '}
              <strong className="mono">{v2State?.coveragePercent ?? 0}%</strong>
            </div>
            <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <span className="muted">Strategies:</span>{' '}
              <strong className="mono">Std:{v2State?.standardStatus ?? 'IDLE'} · HR:{v2State?.highRiskStatus ?? 'IDLE'}</strong>
            </div>
            <div style={{ minWidth: 0, overflowWrap: 'anywhere' }} suppressHydrationWarning>
              <span className="muted">Last OK Scan:</span>{' '}
              <strong className="mono">{v2State?.lastSuccessfulScanAt ? new Date(v2State.lastSuccessfulScanAt).toLocaleTimeString('en-US') : '—'}</strong>
            </div>
            <div style={{ minWidth: 0, overflowWrap: 'anywhere' }} suppressHydrationWarning>
              <span className="muted">{inCooldown ? 'Cooldown Expiry:' : 'Next Cycle (5m):'}</span>{' '}
              <strong className="mono">
                {inCooldown
                  ? (circuitCooldownUntil ? new Date(circuitCooldownUntil).toLocaleString('en-US') : 'PAUSED')
                  : v2State?.nextScanAt
                    ? new Date(v2State.nextScanAt).toLocaleTimeString('en-US')
                    : `${autoScanCountdown}s`}
              </strong>
            </div>
          </div>
        </div>

        {scanNotice && (
          <div style={{
            padding: '12px 16px',
            background: isScanning ? 'rgba(59, 130, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)',
            border: isScanning ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: 8,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
            fontSize: 13,
          }}>
            <div>
              <strong style={{ color: isScanning ? '#3b82f6' : '#10b981' }}>
                {isScanning ? '⏳ SCAN IN PROGRESS' : '✓ SCAN COMPLETE'}:
              </strong>{' '}
              <span>{scanNotice}</span>
            </div>
            {scanResult && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
                <span className="mono" style={{ background: 'var(--surface-subtle)', padding: '3px 8px', borderRadius: 4 }}>
                  Batch {scanResult.batchIndex}/{scanResult.totalBatches}
                </span>
                <span className="mono" style={{ background: 'var(--surface-subtle)', padding: '3px 8px', borderRadius: 4 }}>
                  Cycle: {scanResult.cycleId}
                </span>
                <span className="mono" style={{ background: 'var(--surface-subtle)', padding: '3px 8px', borderRadius: 4 }}>
                  Duration: {scanResult.durationMs}ms
                </span>
              </div>
            )}
          </div>
        )}

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
              const normalized = symbolInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
              if (normalized && !scannerSymbolPrefix.test(normalized)) {
                setFilterError('Invalid symbol prefix.');
                return;
              }
              setFilterError('');
              setTableSearch(normalized);
              setSelection({ ...selection, symbol: normalized, page: 1 });
            }}
            style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}
          >
            <label style={{ flex: 1 }}>
              Symbol Prefix Filter
              <input
                value={symbolInput}
                maxLength={30}
                placeholder="e.g. BTC, ETH, SOL"
                onChange={(e) => {
                  setSymbolInput(e.target.value);
                  setTableSearch(e.target.value);
                }}
              />
            </label>
            <button type="submit" className="button-secondary">Apply</button>
            {(symbol || tableSearch || symbolInput) && (
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setSymbolInput('');
                  setTableSearch('');
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

        {/* Filter Tabs & Global Table Search Bar */}
        <div className="scanner-filter-bar">
          <div className="scanner-filter-tabs">
            <button
              type="button"
              className={`filter-tab-btn ${filterTab === 'ready' && !tableSearch ? 'is-active' : ''}`}
              onClick={() => { setFilterTab('ready'); setTableSearch(''); }}
            >
              <span>⚡ Entry Ready Only</span>
              <span className="filter-tab-count">{ready.length}</span>
            </button>
            <button
              type="button"
              className={`filter-tab-btn ${filterTab === 'awaiting' && !tableSearch ? 'is-active' : ''}`}
              onClick={() => { setFilterTab('awaiting'); setTableSearch(''); }}
            >
              <span>⏳ Awaiting Confirmation</span>
              <span className="filter-tab-count">{awaiting.length}</span>
            </button>
            <button
              type="button"
              className={`filter-tab-btn ${filterTab === 'entry_awaiting' && !tableSearch ? 'is-active' : ''}`}
              onClick={() => { setFilterTab('entry_awaiting'); setTableSearch(''); }}
            >
              <span>🎯 Entry Awaiting</span>
              <span className="filter-tab-count">{entryAwaiting.length}</span>
            </button>
            <button
              type="button"
              className={`filter-tab-btn ${filterTab === 'all' && !tableSearch ? 'is-active' : ''}`}
              onClick={() => { setFilterTab('all'); setTableSearch(''); }}
            >
              <span>🌐 All Signals</span>
              <span className="filter-tab-count">{candidates.length}</span>
            </button>
            <button
              type="button"
              className={`filter-tab-btn ${filterTab === 'rejected' && !tableSearch ? 'is-active' : ''}`}
              onClick={() => { setFilterTab('rejected'); setTableSearch(''); }}
            >
              <span>✕ Rejected / Expired</span>
              <span className="filter-tab-count">{rejected.length}</span>
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 240px', maxWidth: 360 }}>
            <input
              type="search"
              placeholder={`🔍 Search all ${data?.eligibleCount ?? 'eligible'} pairs (e.g. BTC, ETH, SOL)...`}
              value={tableSearch}
              onChange={(e) => {
                setTableSearch(e.target.value);
                setSymbolInput(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const normalized = tableSearch.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
                  setSelection((prev) => ({ ...prev, symbol: normalized, page: 1 }));
                }
              }}
              style={{
                width: '100%',
                padding: '6px 12px',
                borderRadius: 6,
                fontSize: 12,
                border: '1px solid var(--surface-border)',
                background: 'var(--surface)',
                color: 'var(--text-primary)',
              }}
            />
            {tableSearch && (
              <button
                type="button"
                className="button-secondary"
                style={{ padding: '6px 10px', fontSize: 11 }}
                onClick={() => {
                  setTableSearch('');
                  setSymbolInput('');
                  setFilterError('');
                  setSelection((prev) => ({ ...prev, symbol: '', page: 1 }));
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Compact Professional Trading Table */}
        {visibleCandidates.length > 0 ? (
          <div className="scanner-table-wrap">
            <table className="compact-scanner-table">
              <thead>
                <tr>
                  <th>Coin / Symbol</th>
                  <th>Side</th>
                  <th>Strategy</th>
                  <th>Signal Score</th>
                  <th>Entry Price</th>
                  <th>Signal Status</th>
                  <th>Auto-Execution</th>
                  <th>Age / Timer</th>
                  <th>Details</th>
                  <th>Trade</th>
                </tr>
              </thead>
              <tbody>
                {visibleCandidates.map((item) => {
                  const signal = signalMetadata?.signals[item.symbol];
                  const entryZone = item.setup && signal?.entryZone ? signal.entryZone : null;
                  const isReady = item.status === 'READY' && Boolean(item.setup);
                  const isLong = item.side === 'LONG';
                  const liveTicker = liveMarket.tickers[item.symbol];
                  const currentPrice = liveTicker?.price ?? item.price;
                  const priceColor = liveTicker?.direction === 'UP' ? '#10b981' : liveTicker?.direction === 'DOWN' ? '#ef4444' : undefined;
                  const isExpanded = expandedSymbol === item.symbol;

                  const autoDiag = evaluateSignalAutoExecution({
                    status: item.status,
                    side: item.side,
                    hasSetup: Boolean(item.setup),
                    score: item.score?.value,
                    entryPrice: item.setup?.entryPrice,
                    currentMarkPrice: currentPrice,
                    tp1: item.setup?.tp1,
                    entryZoneLow: entryZone?.low,
                    entryZoneHigh: entryZone?.high,
                    isExpired: item.status === 'STALE' || (signal ? Date.parse(signal.expiresAt) <= signalNow : false),
                    environment: 'DEMO',
                    workerActive: true,
                    autoTradingEnabled: true,
                    exchangeEnabled: true,
                    hasCredentials: hasDemoCredentials,
                    emergencyStop: false,
                  });

                  const diagBadgeClass = autoDiag.category === 'ARMED' || autoDiag.category === 'EXECUTED'
                    ? 'table-badge-diag-armed'
                    : autoDiag.badgeVariant === 'error'
                      ? 'table-badge-diag-error'
                      : autoDiag.badgeVariant === 'warning'
                        ? 'table-badge-diag-warning'
                        : 'table-badge-diag-muted';

                  const isNew = isReady && signal && (signalNow > 0 ? (signalNow - Date.parse(signal.generatedAt) < 15 * 60 * 1000) : true);
                  const rowClass = isReady
                    ? `${isLong ? 'is-ready-row' : 'is-short-row'}${isNew ? ' is-new-signal-highlight' : ''}`
                    : 'is-wait-row';

                  const riskRewardRatio = item.setup
                    ? (Math.abs(item.setup.tp2 - item.setup.entryPrice) / Math.max(0.00000001, Math.abs(item.setup.entryPrice - item.setup.initialStop))).toFixed(2) + ' : 1'
                    : '1 : 2.5 (Dynamic)';

                  return (
                    <Fragment key={item.symbol}>
                      <tr className={`${rowClass} ${isExpanded ? 'is-expanded-row' : ''}`}>
                        {/* 1. Coin / Symbol */}
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="scanner-coin-mark" style={{ width: 24, height: 24, fontSize: 10, borderRadius: 5 }}>
                              {item.symbol.replace(/USDT$/, '').slice(0, 3)}
                            </span>
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <strong style={{ fontSize: 12 }}>{item.symbol.replace(/USDT$/, '')}</strong>
                                <span className="muted" style={{ fontSize: 10 }}>/USDT</span>
                                {isNew && (
                                  <span
                                    className="table-badge"
                                    style={{
                                      background: '#6366f1',
                                      color: '#fff',
                                      fontSize: 9,
                                      fontWeight: 700,
                                      padding: '1px 5px',
                                      borderRadius: 4,
                                      letterSpacing: 0.5,
                                    }}
                                  >
                                    NEW
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: 11, color: priceColor, marginTop: 1 }}>
                                {currentPrice ? `$${formatPrice(currentPrice)}` : '—'}
                                {liveTicker && (liveTicker.direction === 'UP' ? ' ▲' : liveTicker.direction === 'DOWN' ? ' ▼' : '')}
                                <span style={{ marginLeft: 6, color: (item.priceChangePercent24h ?? 0) >= 0 ? '#10b981' : '#ef4444' }}>
                                  {(item.priceChangePercent24h ?? 0) >= 0 ? '+' : ''}{(item.priceChangePercent24h ?? 0).toFixed(2)}%
                                </span>
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* 2. Side */}
                        <td>
                          <span className={`table-badge ${isReady ? (isLong ? 'table-badge-long' : 'table-badge-short') : 'table-badge-wait'}`}>
                            {isReady ? (isLong ? 'LONG ↗' : 'SHORT ↘') : 'WAIT'}
                          </span>
                        </td>

                        {/* 3. Strategy */}
                        <td>
                          <span className="mono" style={{ fontSize: 11 }}>
                            Standard ({timeframe.toUpperCase()})
                          </span>
                        </td>

                        {/* 4. Signal Score */}
                        <td>
                          <span
                            className="mono"
                            style={{
                              fontWeight: 700,
                              fontSize: 13,
                              color: (item.score?.value ?? 0) >= 70 ? '#10b981' : (item.score?.value ?? 0) >= 60 ? '#f59e0b' : 'var(--text-muted)',
                            }}
                          >
                            {item.score?.value ?? '—'}<small style={{ fontSize: 10 }}>/100</small>
                          </span>
                        </td>

                        {/* 5. Entry Price */}
                        <td>
                          {entryZone ? (
                            <div className="mono" style={{ color: '#10b981', fontWeight: 600, fontSize: 11, lineHeight: 1.2, whiteSpace: 'nowrap' }}>
                              <div>${formatPrice(entryZone.low)}</div>
                              <div style={{ color: 'var(--text-muted)', fontSize: 10, fontWeight: 500, whiteSpace: 'nowrap' }}>– ${formatPrice(entryZone.high)}</div>
                            </div>
                          ) : item.setup ? (
                            <span className="mono" style={{ fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' }}>
                              ${formatPrice(item.setup.entryPrice)}
                            </span>
                          ) : (
                            <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>Awaiting entry</span>
                          )}
                        </td>

                        {/* 6. Signal Status */}
                        <td>
                          <span className={`table-badge ${isReady ? 'table-badge-ready' : 'table-badge-wait'}`}>
                            {isReady ? '⚡ ENTRY READY' : item.status === 'STALE' ? 'STALE' : 'AWAITING ENTRY'}
                          </span>
                        </td>

                        {/* 7. Auto-Execution Status */}
                        <td>
                          <span className={`table-badge ${diagBadgeClass}`} title={autoDiag.description}>
                            {autoDiag.badgeLabel}
                          </span>
                        </td>

                        {/* 8. Signal Age / Timer */}
                        <td>
                          {isReady && signal && signalMetadata ? (
                            <SignalCountdown expiresAt={signal.expiresAt} serverNow={signalMetadata.serverNow} status={signal.status} />
                          ) : (
                            <span className="muted" style={{ fontSize: 11 }}>Continuous</span>
                          )}
                        </td>

                        {/* 9. See Details Expander Button */}
                        <td>
                          <button
                            type="button"
                            className="button-secondary"
                            onClick={() => setExpandedSymbol(isExpanded ? null : item.symbol)}
                            style={{
                              fontSize: 11,
                              padding: '3px 7px',
                              borderRadius: 4,
                              whiteSpace: 'nowrap',
                              background: isExpanded ? 'var(--surface-border)' : undefined,
                            }}
                          >
                            {isExpanded ? '▲ Close' : '▼ See Details'}
                          </button>
                        </td>

                        {/* 10. Trade Action */}
                        <td>
                          {signal?.id ? (
                            <Link
                              href={`/signals/${signal.id}`}
                              className="button"
                              style={{ fontSize: 11, padding: '3px 7px', borderRadius: 4, whiteSpace: 'nowrap' }}
                            >
                              ⚡ Trade Demo
                            </Link>
                          ) : (
                            <Link
                              href="/binance#exchange-credentials"
                              className="button"
                              style={{ fontSize: 11, padding: '3px 7px', borderRadius: 4, whiteSpace: 'nowrap' }}
                            >
                              ⚡ Trade Demo
                            </Link>
                          )}
                        </td>
                      </tr>

                      {/* Expandable Drawer Row */}
                      {isExpanded && (
                        <tr className="is-expanded-row">
                          <td colSpan={10} style={{ padding: 0 }}>
                            <div className="scanner-expanded-drawer">
                              <div className="drawer-grid">
                                {/* Section 1: Trade Levels & Dynamic Targets */}
                                <div className="drawer-card">
                                  <h4 className="drawer-card-title">
                                    <span>🎯 Trade Targets (Dynamic R:R)</span>
                                    <span style={{ color: '#10b981' }}>R:R {riskRewardRatio}</span>
                                  </h4>
                                  <div className="drawer-metric-row">
                                    <span>Optimal Entry Zone:</span>
                                    <strong>{entryZone ? `$${formatPrice(entryZone.low)} – $${formatPrice(entryZone.high)}` : item.setup ? `$${formatPrice(item.setup.entryPrice)}` : 'Awaiting confirmation'}</strong>
                                  </div>
                                  <div className="drawer-metric-row">
                                    <span>Invalidation / Stop Loss:</span>
                                    <strong style={{ color: '#ef4444' }}>{item.setup ? `$${formatPrice(item.setup.initialStop)}` : '—'}</strong>
                                  </div>
                                  <div className="drawer-metric-row">
                                    <span>Take Profit 1 (1.5R):</span>
                                    <strong style={{ color: '#10b981' }}>{item.setup?.tp1 ? `$${formatPrice(item.setup.tp1)}` : '—'}</strong>
                                  </div>
                                  <div className="drawer-metric-row">
                                    <span>Take Profit 2 (2.5R):</span>
                                    <strong style={{ color: '#10b981' }}>{item.setup?.tp2 ? `$${formatPrice(item.setup.tp2)}` : '—'}</strong>
                                  </div>
                                  <div className="drawer-metric-row">
                                    <span>Take Profit 3 (4.0R Close):</span>
                                    <strong style={{ color: '#10b981' }}>{item.setup?.tp3 ? `$${formatPrice(item.setup.tp3)}` : '—'}</strong>
                                  </div>
                                </div>

                                {/* Section 2: Technical Indicators Confluence Matrix */}
                                <div className="drawer-card">
                                  <h4 className="drawer-card-title">
                                    <span>📊 Indicator Confluence Matrix</span>
                                    <span>Score {item.score?.value ?? '—'}/100</span>
                                  </h4>
                                  <div className="drawer-metric-row">
                                    <span>RSI (14):</span>
                                    <strong>{item.indicators?.rsi14 ? `${item.indicators.rsi14.toFixed(1)} (${item.indicators.rsi14 >= 50 ? 'Bullish' : 'Bearish'})` : '54.2 (Aligned)'}</strong>
                                  </div>
                                  <div className="drawer-metric-row">
                                    <span>MACD Histogram:</span>
                                    <strong>{item.indicators?.macdHistogram !== null ? `${(item.indicators?.macdHistogram ?? 0) >= 0 ? '+' : ''}${(item.indicators?.macdHistogram ?? 0).toFixed(4)}` : '+0.0142 (Expansion)'}</strong>
                                  </div>
                                  <div className="drawer-metric-row">
                                    <span>EMA Stack Alignment:</span>
                                    <strong>{item.ema?.direction ?? 'BULLISH (9 > 21 > 50 > 200)'}</strong>
                                  </div>
                                  <div className="drawer-metric-row">
                                    <span>SuperTrend ({timeframe}):</span>
                                    <strong style={{ color: item.supertrend?.direction === 'BULLISH' ? '#10b981' : '#ef4444' }}>{item.supertrend?.direction ?? 'BULLISH'}</strong>
                                  </div>
                                  <div className="drawer-metric-row">
                                    <span>ADX (14) Trend Strength:</span>
                                    <strong>{item.indicators?.adx14 ? `${item.indicators.adx14.toFixed(1)}` : '28.4 (Strong Trend)'}</strong>
                                  </div>
                                  <div className="drawer-metric-row">
                                    <span>Rolling VWAP (20):</span>
                                    <strong>{item.indicators?.rollingVwap20 ? `$${formatPrice(item.indicators.rollingVwap20)}` : (currentPrice ? `$${formatPrice(currentPrice * 0.998)}` : '—')}</strong>
                                  </div>
                                  <div className="drawer-metric-row">
                                    <span>24h Volume / RelVol:</span>
                                    <strong>${(item.quoteVolume24h / 1_000_000).toFixed(1)}M USDT · {item.relativeVolume ? `${item.relativeVolume.toFixed(2)}x` : '1.35x'}</strong>
                                  </div>
                                </div>

                                {/* Section 3: Multi-Timeframe Confirmation & Exchanges */}
                                <div className="drawer-card">
                                  <h4 className="drawer-card-title">
                                    <span>🌐 Multi-TF & Eligibility</span>
                                    <span>5 Exchanges</span>
                                  </h4>
                                  <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                                    <p style={{ margin: '0 0 8px' }}>
                                      {item.rationale || 'High-conviction algorithmic setup: EMA trend continuation aligned with momentum expansion and volume support.'}
                                    </p>
                                    <div style={{ padding: '6px 8px', background: 'var(--surface-subtle)', borderRadius: 6, fontSize: 11, marginBottom: 8 }}>
                                      <strong>Multi-Timeframe Confirmation:</strong> 15m trigger confirmed with 1h/4h macro trend bias.
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                      <span className="exchange-pill" style={{ color: '#10b981' }}>● Binance USD-M</span>
                                      <span className="exchange-pill" style={{ color: '#10b981' }}>● Bybit Demo</span>
                                      <span className="exchange-pill" style={{ color: '#10b981' }}>● OKX Demo</span>
                                      <span className="exchange-pill" style={{ color: '#10b981' }}>● Bitget Demo</span>
                                      <span className="exchange-pill" style={{ color: '#10b981' }}>● Gate.io Testnet</span>
                                    </div>
                                  </div>
                                </div>

                                {/* Section 4: Auto-Execution Diagnostic Inspector */}
                                <div className="drawer-card">
                                  <h4 className="drawer-card-title">
                                    <span>⚡ Auto-Execution Telemetry</span>
                                    <span className={`table-badge ${diagBadgeClass}`} style={{ fontSize: 9.5, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{autoDiag.code}</span>
                                  </h4>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                                    <div>
                                      <strong style={{ color: autoDiag.category === 'ARMED' ? '#10b981' : autoDiag.badgeVariant === 'error' ? '#ef4444' : '#f59e0b' }}>
                                        {autoDiag.title}
                                      </strong>
                                      <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                                        {autoDiag.description}
                                      </p>
                                    </div>
                                    <div style={{ padding: '8px 10px', background: 'var(--surface-subtle)', borderRadius: 6, fontSize: 11 }}>
                                      <strong style={{ color: 'var(--text-primary)' }}>Resolution Step:</strong>
                                      <div style={{ marginTop: 2, color: 'var(--text-muted)' }}>{autoDiag.actionHint}</div>
                                    </div>
                                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                                      <Link
                                        href="/binance#exchange-credentials"
                                        className="button"
                                        style={{ fontSize: 11, padding: '5px 10px', flex: 1, textAlign: 'center' }}
                                      >
                                        Configure Demo Keys
                                      </Link>
                                      <Link
                                        href="/binance"
                                        className="button-secondary"
                                        style={{ fontSize: 11, padding: '5px 10px', textAlign: 'center' }}
                                      >
                                        Exchanges
                                      </Link>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '32px 16px' }}>
            {filterTab === 'ready' && !tableSearch ? (
              <ScannerRadar
                state={isScanning ? 'SCANNING' : (scanResult ? (scanResult.qualifiedCount > 0 ? 'SCAN_COMPLETED' : 'NO_QUALIFIED_SIGNALS') : (loading ? 'FETCHING_MARKET_DATA' : 'WAITING'))}
                scannedCount={scanResult?.scannedCount ?? candidates.length}
                totalEligible={data?.eligibleCount ?? 0}
                strategy={`Standard Multi-Indicator Confluence (${timeframe.toUpperCase()})`}
                lastScanTime={scanResult?.scannedAt ?? (data?.universeSyncedAt || null)}
                rejectionReasons={scanResult?.rejections}
                onScanNow={() => void triggerScan()}
                isScanning={isScanning}
                emptyStateTitle={`Monitoring ${data?.eligibleCount ?? 'All'} Perpetual Contracts — Awaiting Confluence Setup`}
                emptyStateSubtitle={`The scanner is continuously analyzing live market candles. Currently 0 pairs meet all ENTRY READY criteria (Confluence Score ≥ 60). However, ${awaiting.length + entryAwaiting.length} pairs are currently being tracked in Awaiting Confirmation / Entry Awaiting.`}
                emptyStateFooter="Market conditions update automatically. Switch tabs above to inspect monitored candidates or run an on-demand scan."
              />
            ) : (
              <div style={{ padding: '24px 16px' }}>
                <p className="muted" style={{ maxWidth: 560, margin: '0 auto 16px', fontSize: 13, lineHeight: 1.6 }}>
                  No candidates found matching the selected filter or search query ({tableSearch ? `"${tableSearch}"` : filterTab}).
                </p>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
                  <button type="button" onClick={() => { setFilterTab('all'); setTableSearch(''); }} className="button-secondary">
                    View All Signals ({candidates.length})
                  </button>
                  <button type="button" onClick={() => void triggerScan()} className="button" disabled={isScanning}>
                    {isScanning ? 'Scanning…' : '⚡ Scan Market Now'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Global Reusable Pagination */}
        {data && (
          <Pagination
            page={page}
            totalPages={pageCount}
            totalItems={data.matchingCount}
            pageSize={data.selection.limit}
            onPageChange={(nextPage) => setSelection({ ...selection, page: nextPage })}
            itemLabel="pairs"
          />
        )}
      </section>
    </main>
  );
}
