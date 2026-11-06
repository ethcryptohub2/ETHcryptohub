import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '../../../lib/auth';
import { marketScannerQuerySchema } from '../../../smartexit/apps/api/src/schemas';
import type { MarketScannerCandidate } from '../../../smartexit/apps/api/src/services/market-scanner';
import {
  defaultNotificationSystemSettings,
  getPersistedSignalMetadata,
  getNotificationSystemSettings,
  signalKeyForCandidate,
} from '../../../lib/notifications';
import {
  getEnabledScannerSymbols,
  getScannerCandidateSnapshots,
} from '../../../lib/scanner-coins';
import { requirePremiumUser, SubscriptionError } from '../../../lib/subscriptions';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    await requirePremiumUser();
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof AuthError || error instanceof SubscriptionError ? error.message : 'Sign in is required.',
        ...(error instanceof SubscriptionError ? { code: error.code } : {}),
      },
      { status: error instanceof AuthError || error instanceof SubscriptionError ? error.status : 401 },
    );
  }

  const parsed = marketScannerQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid scanner configuration.' }, { status: 422 });

  try {
    const enabledSymbols = await getEnabledScannerSymbols();
    let settings = defaultNotificationSystemSettings();
    let notificationWarning = '';
    try {
      settings = await getNotificationSystemSettings();
    } catch (error) {
      console.error('Notification migration is not available to the scanner:', error instanceof Error ? error.message : 'Unknown error');
      notificationWarning = 'Signal notifications are unavailable because their database migration is not configured.';
    }
    const snapshotRows = await getScannerCandidateSnapshots(parsed.data.timeframe, enabledSymbols);
    const now = Date.now();
    const candidates: MarketScannerCandidate[] = snapshotRows.map(({ candidate_json: saved, scanned_at }) => {
      const ageMs = now - Date.parse(scanned_at);
      const candidate = {
        ...saved,
        scannedAt: new Date(scanned_at).toISOString(),
      };
      if (ageMs > parsed.data.maxAgeSeconds * 1000 && candidate.status !== 'DATA_UNAVAILABLE') {
        return {
          ...candidate,
          status: 'STALE' as const,
          side: 'WAIT' as const,
          setup: null,
          rationale: 'WAIT: the background scan is stale or no live Binance ticker is available.',
          warnings: [...candidate.warnings, 'Fresh background scan and live Binance ticker data are required.'],
        };
      }
      return candidate;
    });
    const staleStatuses = new Set(['EXPIRED', 'ENTRY_INVALIDATED', 'STOP_LOSS_HIT', 'TP3_HIT']);
    let signalMap: Record<string, Awaited<ReturnType<typeof getPersistedSignalMetadata>>[string] | null> = {};
    if (candidates.length && !notificationWarning) {
      try {
        const metadata = await getPersistedSignalMetadata(candidates);
        signalMap = Object.fromEntries(
          candidates
            .filter((candidate) => candidate.status === 'READY' && candidate.side !== 'WAIT' && candidate.lastCandleCloseAt)
            .map((candidate) => [candidate.symbol, metadata[signalKeyForCandidate(candidate)] ?? null]),
        );
      } catch (error) {
        console.error('Persisted signal metadata could not be loaded:', error instanceof Error ? error.message : 'Unknown error');
        notificationWarning = 'Signal notifications are unavailable because their database migration is not configured.';
      }
    }
    const displayedCandidates = candidates.map((candidate) => {
      const signal = signalMap[candidate.symbol];
      if (candidate.status !== 'READY' || !signal || !staleStatuses.has(signal.status)) return candidate;
      return {
        ...candidate,
        status: 'WAIT' as const,
        side: 'WAIT' as const,
        setup: null,
        rationale: `WAIT: this persisted signal is ${signal.status.replaceAll('_', ' ').toLowerCase()} and is not a fresh entry.`,
        warnings: [...candidate.warnings, 'The previous signal is no longer actionable.'],
      };
    });
    const scanTimes = snapshotRows.map((row) => Date.parse(row.scanned_at)).filter(Number.isFinite);
    const result = {
      exchange: 'BINANCE' as const,
      market: 'USDⓈ-M FUTURES' as const,
      source: 'Persisted Binance USDⓈ-M exchange, ticker, and candle scan results',
      updatedAt: scanTimes.length ? new Date(Math.max(...scanTimes)).toISOString() : new Date(now).toISOString(),
      timeframe: parsed.data.timeframe,
      configuration: {
        ...parsed.data,
        quoteAsset: 'USDT' as const,
        minimumScore: Math.max(parsed.data.minimumScore, settings.minimumSetupScore),
      },
      status: displayedCandidates.some((candidate) => candidate.status === 'STALE' || candidate.status === 'DATA_UNAVAILABLE')
        || displayedCandidates.length === 0
        ? 'DEGRADED' as const
        : 'LIVE' as const,
      candidates: displayedCandidates,
    };
    return NextResponse.json({
      data: result,
      signalMetadata: { signals: signalMap, serverNow: new Date().toISOString() },
      ...(notificationWarning ? { notificationWarning } : {}),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Public futures scanner request failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Binance scanner data is temporarily unavailable.' },
      { status: error instanceof Error && error.message.includes('Binance public') ? 502 : 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
