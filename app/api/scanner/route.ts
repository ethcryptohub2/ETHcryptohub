import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '../../../lib/auth';
import { marketScannerQuerySchema } from '../../../smartexit/apps/api/src/schemas';
import { recommendedMaxAgeSeconds } from '../../../smartexit/apps/api/src/services/market-scanner';
import type { MarketScannerCandidate } from '../../../smartexit/apps/api/src/services/market-scanner';
import { applyScannerSignalValidity, savedScannerCandidate } from '../../../lib/scanner-snapshot';
import { scannerCoverageModes, scannerRanks, scannerSymbolPrefix, type SavedScannerResponse } from '../../../lib/scanner-universe';
import {
  defaultNotificationSystemSettings,
  getPersistedSignalMetadata,
  getNotificationSystemSettings,
  signalKeyForCandidate,
} from '../../../lib/notifications';
import { getSavedScannerUniverse } from '../../../lib/scanner-coins';
import { requirePremiumUser, SubscriptionError } from '../../../lib/subscriptions';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const querySchema = marketScannerQuerySchema.extend({
  coverage: z.enum(scannerCoverageModes).default('saved'),
  symbol: z.string().trim().transform((symbol) => symbol.toUpperCase()).pipe(z.string().regex(scannerSymbolPrefix)).default(''),
  rank: z.enum(scannerRanks).optional(),
  page: z.coerce.number().int().min(1).max(1_000).default(1),
}).strict();
const noStore = { 'Cache-Control': 'no-store' };

function hasValidSetup(candidate: MarketScannerCandidate) {
  if (!candidate.setup || candidate.side === 'WAIT') return false;
  const { initialStop, entryPrice, tp1, tp2, tp3 } = candidate.setup;
  const levels = [initialStop, entryPrice, tp1, tp2, tp3];
  if (!levels.every((level) => Number.isFinite(level) && level > 0)) return false;
  const direction = candidate.side === 'LONG' ? 1 : -1;
  return levels.slice(1).every((level, index) => direction * (level - levels[index]!) > 0);
}

export async function GET(request: NextRequest) {
  try {
    await requirePremiumUser({ reconcile: false });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof AuthError || error instanceof SubscriptionError ? error.message : 'Scanner access could not be verified. Try again.',
        ...(error instanceof SubscriptionError ? { code: error.code } : {}),
      },
      { status: error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503, headers: noStore },
    );
  }

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success || (parsed.data.coverage !== 'saved' && parsed.data.rank)) {
    return NextResponse.json({ error: 'Choose a supported timeframe, coverage and symbol prefix.' }, { status: 422, headers: noStore });
  }
  const { coverage, symbol, rank = null, page, ...configuration } = parsed.data;
  configuration.maxAgeSeconds = Math.min(configuration.maxAgeSeconds, recommendedMaxAgeSeconds(configuration.timeframe));

  try {
    const universe = await getSavedScannerUniverse({
      timeframe: configuration.timeframe, coverage, symbol, rank, page, limit: configuration.limit,
      maxAgeSeconds: configuration.maxAgeSeconds,
    });
    const now = Date.now();
    const scanDurationMs: number | null = null;

    let cbStatus: { state: string; cooldownUntil: number | null; reason: string | null; usedWeight1m?: number; weightLimit1m?: number } = { state: 'CLOSED', cooldownUntil: null, reason: null };
    let v2State: Record<string, unknown> | null = null;
    try {
      const { ensureBinanceCooldownHydrated } = await import('../../../lib/binance-rate-limit-db');
      cbStatus = await ensureBinanceCooldownHydrated(now);
      const { getScannerV2State, startFiveMinuteScheduler } = await import('../../../lib/scanner-scheduler');
      startFiveMinuteScheduler();
      v2State = (await getScannerV2State()) as unknown as Record<string, unknown>;
    } catch {
      // Fallback when running under isolated unit-test stubs
    }

    let rotationState: Record<string, unknown> | null = null;
    try {
      const { query } = await import('../../../lib/db');
      const rotRes = await query<{ value_json: Record<string, unknown> }>(
        `SELECT value_json FROM public.app_settings WHERE key = 'scanner_rotation_state'`,
      );
      rotationState = rotRes.rows[0]?.value_json ?? null;
    } catch {
      // non-blocking
    }

    let settings = defaultNotificationSystemSettings();
    let notificationWarning = '';
    const candidates: MarketScannerCandidate[] = coverage === 'eligible' ? [] : universe.rows.flatMap(({ candidate, savedScanAt }) =>
      candidate && savedScanAt ? [savedScannerCandidate(candidate, savedScanAt, configuration.maxAgeSeconds, now)] : []);
    let signalMap: Record<string, Awaited<ReturnType<typeof getPersistedSignalMetadata>>[string] | null> = {};
    let lifecycleUnavailable = false;
    let qualificationUnavailable = false;
    const ready = candidates.filter((candidate) => candidate.status === 'READY' && candidate.side !== 'WAIT' && candidate.lastCandleCloseAt);
    if (ready.length) {
      const [configurationResult, metadataResult] = await Promise.allSettled([
        getNotificationSystemSettings(),
        getPersistedSignalMetadata(ready),
      ]);
      if (configurationResult.status === 'fulfilled') settings = configurationResult.value;
      else qualificationUnavailable = true;
      lifecycleUnavailable = metadataResult.status === 'rejected';
      if (metadataResult.status === 'fulfilled') {
        signalMap = Object.fromEntries(ready.map((candidate) =>
          [candidate.symbol, metadataResult.value[signalKeyForCandidate(candidate)] ?? null],
        ));
      }
      if (lifecycleUnavailable) notificationWarning = 'Signal validity could not be verified. Saved prices may be shown while setup levels are withheld.';
      else if (qualificationUnavailable) notificationWarning = 'Signal qualification settings could not be checked. Saved prices may be shown while setup levels are withheld.';
    }
    const serverNow = Date.now();
    const minimumScore = Math.max(configuration.minimumScore, settings.minimumSetupScore);
    const displayedCandidates = candidates.map((candidate) => {
      const aged = savedScannerCandidate(candidate, candidate.scannedAt ?? '', configuration.maxAgeSeconds, serverNow);
      if (aged.status !== 'READY') return aged;
      if (!hasValidSetup(aged)) {
        return { ...aged, status: 'WAIT' as const, side: 'WAIT' as const, setup: null,
          rationale: 'The saved setup has invalid reference levels.' };
      }
      if (lifecycleUnavailable || qualificationUnavailable || !Number.isFinite(aged.score.value) || (aged.score.value ?? -1) < minimumScore) {
        return { ...aged, status: 'WAIT' as const, side: 'WAIT' as const, setup: null,
          rationale: notificationWarning || 'Saved setup score is below the selected minimum.' };
      }
      return applyScannerSignalValidity(aged, signalMap[candidate.symbol], serverNow);
    });
    const lastSavedAt = Date.parse(universe.latest_saved_at ?? '');
    const updatedAt = Number.isFinite(lastSavedAt) && lastSavedAt <= serverNow ? new Date(lastSavedAt).toISOString() : null;
    const lastUniverseSync = Date.parse(universe.universe_synced_at ?? '');
    const universeStatus = !universe.saved_count ? 'NO_SAVED_RESULTS' :
      universe.recent_until.some(expiry => expiry >= serverNow) ? 'RECENT_CACHE' : 'STALE_CACHE';
    const result: SavedScannerResponse = {
      exchange: 'BINANCE',
      market: 'USDⓈ-M FUTURES',
      source: 'Saved Binance USDⓈ-M USDT perpetual scanner data',
      updatedAt,
      timeframe: configuration.timeframe,
      configuration: { ...configuration, minimumScore },
      status: universeStatus,
      selection: { coverage, symbol, rank, page, limit: configuration.limit },
      eligibleCount: universe.eligible_count,
      universeSyncedAt: Number.isFinite(lastUniverseSync) && lastUniverseSync <= serverNow ? new Date(lastUniverseSync).toISOString() : null,
      savedCount: universe.saved_count,
      recentUntil: universe.recent_until,
      watchlistCount: universe.watchlist_count,
      matchingCount: universe.matching_count,
      instruments: universe.rows.map(({ symbol, baseAsset, eligible, watchlist, savedScanAt }) =>
        ({ symbol, baseAsset, eligible, watchlist, savedScanAt })),
      candidates: displayedCandidates,
    };
    return NextResponse.json({
      data: result,
      diagnostics: {
        discoveredCount: universe.eligible_count,
        eligibleCount: universe.eligible_count,
        scannedCount: Number(rotationState?.lastScannedCount ?? displayedCandidates.length),
        successfulCount: Number(rotationState?.lastSuccessfulCount ?? displayedCandidates.length),
        failedCount: Number(rotationState?.lastFailedCount ?? 0),
        skippedCount: Number(rotationState?.lastSkippedCount ?? 0),
        rejectedCount: Math.max(0, universe.matching_count - ready.length),
        qualifiedCount: ready.length,
        scanDurationMs: scanDurationMs ?? (typeof rotationState?.lastDurationMs === 'number' ? rotationState.lastDurationMs : null),
        lastScanTimestamp: universe.latest_saved_at,
        batchIndex: typeof rotationState?.lastBatchIndex === 'number' ? rotationState.lastBatchIndex : 1,
        totalBatches: typeof rotationState?.lastTotalBatches === 'number'
          ? rotationState.lastTotalBatches
          : Math.max(1, Math.ceil(universe.eligible_count / 35)),
        cycleId: typeof rotationState?.cycleId === 'string' ? rotationState.cycleId : 'CYCLE-1',
      },
      circuitBreaker: cbStatus,
      v2State,
      signalMetadata: { signals: signalMap, serverNow: new Date(serverNow).toISOString() },
      ...(notificationWarning ? { notificationWarning } : {}),
    }, { headers: noStore });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
    if (code) console.error('Saved scanner database read failed', { code });
    return NextResponse.json(
      { error: 'Saved scanner data could not be read. Retry the saved results or contact an administrator if it persists.' },
      { status: 503, headers: noStore },
    );
  }
}
