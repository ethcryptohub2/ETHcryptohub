import 'server-only';
import { query } from '../db';
import { isApprovedAdminDemoStagingTarget } from '../admin-demo-staging-policy';
import { buildIntelligenceStatus, type IntelligenceActor } from './status';

export async function readIntelligenceStatus(actor: IntelligenceActor) {
  // This foundation release never accesses an unidentified or Production target.
  if (!isApprovedAdminDemoStagingTarget(process.env)) return buildIntelligenceStatus(actor, null);
  try {
    const result = await query<{ enabled: string; covered: string; latest: string | null }>(
      `SELECT
         (SELECT count(*)::text FROM public.scanner_coin_configs
           WHERE exchange='BINANCE' AND quote_asset='USDT' AND contract_type='PERPETUAL'
             AND trading_status='TRADING' AND is_enabled=TRUE) AS enabled,
         (SELECT count(DISTINCT s.symbol)::text FROM public.scanner_candidate_snapshots s
           JOIN public.scanner_coin_configs c ON c.symbol=s.symbol AND c.exchange=s.exchange
           WHERE c.is_enabled=TRUE AND c.trading_status='TRADING') AS covered,
         (SELECT max(scanned_at)::text FROM public.scanner_candidate_snapshots) AS latest`,
    );
    const row = result.rows[0];
    return buildIntelligenceStatus(actor, row ? {
      enabledSymbols: Number(row.enabled), snapshotSymbols: Number(row.covered), latestSnapshotAt: row.latest,
    } : null);
  } catch {
    return buildIntelligenceStatus(actor, null);
  }
}
