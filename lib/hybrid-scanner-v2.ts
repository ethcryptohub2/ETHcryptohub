import { binanceRateLimiter, BinanceCooldownError } from './binance-rate-limit';

export type ScannerV2LifecycleState =
  | 'INITIALIZING'
  | 'SCANNING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'WAITING_FOR_NEXT_CYCLE'
  | 'RATE_LIMIT_COOLDOWN'
  | 'STALE_DATA'
  | 'DISCONNECTED'
  | 'ERROR';

export interface HybridBatchResult {
  batchIndex: number; // 1-based
  symbols: string[];
  successfulCount: number;
  failedCount: number;
  skippedCount: number;
  qualifiedCount: number;
  newSignals: number;
  deduplicatedSignals: number;
  cooldownTripped?: boolean;
  error?: string;
}

export interface HybridScannerV2Summary {
  version: 'Hybrid Parallel V2';
  cycleId: string;
  state: ScannerV2LifecycleState;
  concurrency: number;
  totalEligible: number;
  totalBatches: number;
  completedBatches: number;
  activeWorkers: number;
  successfulCount: number;
  failedCount: number;
  skippedCount: number;
  qualifiedCount: number;
  newSignals: number;
  deduplicatedSignals: number;
  coveragePercent: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  usedWeight1m: number;
  weightLimit1m: number;
  cooldownUntil: number | null;
}

export function createBatches(symbols: readonly string[], batchSize: number): string[][] {
  const safeSize = Math.max(1, Math.min(100, Math.floor(batchSize)));
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += safeSize) {
    batches.push(symbols.slice(i, i + safeSize));
  }
  return batches;
}

export async function runHybridParallelWorkPool(options: {
  cycleId: string;
  symbols: readonly string[];
  batchSize?: number;
  concurrency?: number;
  allowFailoverMode?: boolean;
  signal?: AbortSignal;
  processBatch: (
    batchSymbols: string[],
    batchIndex: number,
    totalBatches: number,
    signal?: AbortSignal,
  ) => Promise<Omit<HybridBatchResult, 'batchIndex' | 'symbols'>>;
  onProgress?: (progress: {
    completedBatches: number;
    totalBatches: number;
    activeWorkers: number;
    successfulCount: number;
    failedCount: number;
    skippedCount: number;
    qualifiedCount: number;
    newSignals: number;
  }) => void | Promise<void>;
}): Promise<HybridScannerV2Summary> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const batches = createBatches(options.symbols, options.batchSize ?? 32);
  const totalBatches = batches.length;
  const workerCount = Math.max(1, Math.min(options.concurrency ?? 4, Math.max(1, totalBatches)));

  let nextIdx = 0;
  let completedBatches = 0;
  let activeWorkers = 0;
  let successfulCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let qualifiedCount = 0;
  let newSignals = 0;
  let deduplicatedSignals = 0;
  let cooldownTripped = false;
  let cooldownUntil: number | null = null;
  let cancelled = false;

  const cbInitial = binanceRateLimiter.getStatus(startedMs);
  if (!options.allowFailoverMode && cbInitial.state === 'OPEN') {
    cooldownTripped = true;
    cooldownUntil = cbInitial.cooldownUntil;
    skippedCount = options.symbols.length;
    const completedAt = new Date().toISOString();
    return {
      version: 'Hybrid Parallel V2',
      cycleId: options.cycleId,
      state: 'RATE_LIMIT_COOLDOWN',
      concurrency: workerCount,
      totalEligible: options.symbols.length,
      totalBatches,
      completedBatches: 0,
      activeWorkers: 0,
      successfulCount: 0,
      failedCount: 0,
      skippedCount,
      qualifiedCount: 0,
      newSignals: 0,
      deduplicatedSignals: 0,
      coveragePercent: 0,
      startedAt,
      completedAt,
      durationMs: Date.now() - startedMs,
      usedWeight1m: cbInitial.usedWeight1m,
      weightLimit1m: cbInitial.weightLimit1m,
      cooldownUntil,
    };
  }

  const worker = async () => {
    while (true) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      if (cooldownTripped) break;

      const idx = nextIdx;
      if (idx >= totalBatches) break;
      nextIdx += 1;

      const batchSymbols = batches[idx]!;
      const batchIndex = idx + 1;
      activeWorkers += 1;

      try {
        const res = await options.processBatch(batchSymbols, batchIndex, totalBatches, options.signal);
        successfulCount += res.successfulCount;
        failedCount += res.failedCount;
        skippedCount += res.skippedCount;
        qualifiedCount += res.qualifiedCount;
        newSignals += res.newSignals;
        deduplicatedSignals += res.deduplicatedSignals;
        if (res.cooldownTripped) {
          cooldownTripped = true;
          cooldownUntil = binanceRateLimiter.getStatus().cooldownUntil;
        }
      } catch (err) {
        if (err instanceof BinanceCooldownError) {
          cooldownTripped = true;
          cooldownUntil = err.cooldownUntil;
          skippedCount += batchSymbols.length;
        } else {
          failedCount += batchSymbols.length;
        }
      } finally {
        activeWorkers -= 1;
        completedBatches += 1;
        if (options.onProgress) {
          await options.onProgress({
            completedBatches,
            totalBatches,
            activeWorkers,
            successfulCount,
            failedCount,
            skippedCount,
            qualifiedCount,
            newSignals,
          });
        }
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Any unstarted batches due to cooldown or cancellation are explicitly counted as skipped
  if (nextIdx < totalBatches) {
    for (let i = nextIdx; i < totalBatches; i += 1) {
      skippedCount += batches[i]!.length;
    }
  }

  const completedMs = Date.now();
  const completedAt = new Date(completedMs).toISOString();
  const durationMs = completedMs - startedMs;
  const cbFinal = binanceRateLimiter.getStatus(completedMs);
  const coveragePercent = options.symbols.length > 0
    ? Number(((successfulCount / options.symbols.length) * 100).toFixed(2))
    : 0;

  let finalState: ScannerV2LifecycleState = 'COMPLETED';
  if (cooldownTripped || (!options.allowFailoverMode && cbFinal.state === 'OPEN')) {
    finalState = 'RATE_LIMIT_COOLDOWN';
    cooldownUntil = cbFinal.cooldownUntil ?? cooldownUntil;
  } else if (cancelled || failedCount > 0 || skippedCount > 0) {
    finalState = successfulCount > 0 ? 'PARTIAL' : 'ERROR';
  }

  return {
    version: 'Hybrid Parallel V2',
    cycleId: options.cycleId,
    state: finalState,
    concurrency: workerCount,
    totalEligible: options.symbols.length,
    totalBatches,
    completedBatches,
    activeWorkers: 0,
    successfulCount,
    failedCount,
    skippedCount,
    qualifiedCount,
    newSignals,
    deduplicatedSignals,
    coveragePercent,
    startedAt,
    completedAt,
    durationMs,
    usedWeight1m: cbFinal.usedWeight1m,
    weightLimit1m: cbFinal.weightLimit1m,
    cooldownUntil,
  };
}
