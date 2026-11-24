import type { MarketScannerResponse } from '../smartexit/apps/api/src/services/market-scanner';

export const scannerCoverageModes = ['saved', 'eligible', 'watchlist'] as const;
export const scannerRanks = ['TOP_VOLUME', 'TOP_GAINER', 'TOP_LOSER'] as const;
export const scannerSymbolPrefix = /^[\p{L}\p{N}]{0,30}$/u;

export type ScannerCoverage = typeof scannerCoverageModes[number];
export type ScannerRank = typeof scannerRanks[number];

export function calculateScannerBatches(totalEligibleSymbols: number, batchSize = 35): {
  totalBatches: number;
  batchSize: number;
  totalEligible: number;
} {
  const safeTotal = Math.max(0, totalEligibleSymbols);
  const safeBatch = Math.max(1, batchSize);
  return {
    totalBatches: Math.max(1, Math.ceil(safeTotal / safeBatch)),
    batchSize: safeBatch,
    totalEligible: safeTotal,
  };
}

export interface ScannerInstrument {
  symbol: string;
  baseAsset: string | null;
  eligible: boolean;
  watchlist: boolean;
  savedScanAt: string | null;
}

export type SavedScannerResponse = Omit<MarketScannerResponse, 'updatedAt' | 'status'> & {
  updatedAt: string | null;
  status: 'RECENT_CACHE' | 'STALE_CACHE' | 'NO_SAVED_RESULTS';
  selection: { coverage: ScannerCoverage; symbol: string; rank: ScannerRank | null; page: number; limit: number };
  matchingCount: number;
  eligibleCount: number;
  universeSyncedAt: string | null;
  savedCount: number;
  recentUntil: number[];
  watchlistCount: number;
  instruments: ScannerInstrument[];
};
