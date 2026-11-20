import 'server-only';
import { query } from '../db';
import { isApprovedAdminDemoStagingTarget } from '../admin-demo-staging-policy';
import { buildIntelligenceStatus, type IntelligenceActor } from './status';

export async function readIntelligenceStatus(actor: IntelligenceActor) {
  // This foundation release never accesses an unidentified or Production target.
  if (!isApprovedAdminDemoStagingTarget(process.env)) return buildIntelligenceStatus(actor, null);
  try {
    const result = await query<{ enabled: string; covered: string; latest: string | null }>(
      `WITH enabled AS (
         SELECT exchange, symbol FROM public.scanner_coin_configs
          WHERE exchange='BINANCE' AND quote_asset='USDT' AND contract_type='PERPETUAL'
            AND trading_status='TRADING' AND is_enabled=TRUE
       )
       SELECT (SELECT count(*)::text FROM enabled) AS enabled,
              count(DISTINCT s.symbol)::text AS covered, max(s.scanned_at)::text AS latest
         FROM public.scanner_candidate_snapshots s
         JOIN enabled e ON e.symbol=s.symbol AND e.exchange=s.exchange`,
    );
    const row = result.rows[0];
    return buildIntelligenceStatus(actor, row ? {
      enabledSymbols: Number(row.enabled), snapshotSymbols: Number(row.covered), latestSnapshotAt: row.latest,
    } : null);
  } catch {
    return buildIntelligenceStatus(actor, null);
  }
}
