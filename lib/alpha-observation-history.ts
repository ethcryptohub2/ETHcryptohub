import { Pool } from 'pg';
import type { AlphaSnapshot } from './alpha-intelligence';
import { isApprovedAdminDemoStagingTarget, isPreviewMarketRequestApproved, type AdminDemoEnvironment } from './admin-demo-staging-policy';

const project = 'ghecpkpaxbrvehquhzkr';
const role = 'smartexit_alpha_history';

function historyTarget(env: AdminDemoEnvironment, hostname: string) {
  if (env.VERCEL_ENV !== 'preview' || env.VERCEL_GIT_COMMIT_REF !== 'functional-staging' ||
    env.VERCEL_URL !== hostname || env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF !== project ||
    !isApprovedAdminDemoStagingTarget(env)) return null;
  try {
    const url = new URL(env.SMARTEXIT_ALPHA_HISTORY_DB_URL ?? '');
    return url.protocol === 'postgresql:' && url.hostname === `db.${project}.supabase.co` &&
      (!url.port || url.port === '5432') && url.username === role && url.password &&
      url.pathname === '/postgres' && !url.search && !url.hash ? url : null;
  } catch {
    return null;
  }
}

export function alphaHistoryReadEnabled(env: AdminDemoEnvironment, hostname: string) {
  return env.SMARTEXIT_ALPHA_HISTORY_READ_ENABLED === 'true' && Boolean(historyTarget(env, hostname));
}

async function withHistoryConnection<T>(url: URL, operation: (pool: Pool) => Promise<T>) {
  const pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 2000,
    ssl: { rejectUnauthorized: true, servername: url.hostname }, application_name: 'smartexit-alpha-history' });
  try {
    const identity = await pool.query<{ role: string; db: string }>('SELECT current_user AS role, current_database() AS db');
    if (identity.rows[0]?.role !== role || identity.rows[0]?.db !== 'postgres') throw new Error('Alpha history identity mismatch');
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

export async function storeApprovedAlphaObservations(
  env: AdminDemoEnvironment, hostname: string, approvedIds: readonly string[], snapshot: AlphaSnapshot, signal: AbortSignal,
) {
  const approvedForStorage = () => isPreviewMarketRequestApproved(env, hostname, 'ALPHA_INTELLIGENCE') &&
    isPreviewMarketRequestApproved(env, hostname, 'ALPHA_HISTORY_WRITE');
  if (!approvedForStorage()) return 'DISABLED';
  const target = historyTarget(env, hostname);
  if (!target) return 'UNAVAILABLE';
  const collectedAt = Date.parse(snapshot.checkedAt ?? '');
  const now = Date.now();
  if (!Number.isFinite(collectedAt) || collectedAt > now || now - collectedAt > 15_000 || signal.aborted) return 'NO_OBSERVATIONS';
  const approved = new Set(approvedIds);
  const rows = snapshot.rows.filter(row => {
    const observed = Date.parse(row.verifiedAt ?? '');
    return approved.has(row.id) && row.market && row.signalStatus === 'OBSERVATION_ONLY' &&
      row.price !== null && Number.isFinite(row.price) && row.price > 0 &&
      Number.isFinite(observed) && observed <= collectedAt && collectedAt - observed <= 60_000;
  }).slice(0, 2).map(row => ({
    alpha_id: row.id, chain: row.chain, contract: row.contract, market: row.market,
    observed_at: row.verifiedAt, collected_at: snapshot.checkedAt,
    measurements: { symbol: row.symbol, price: row.price, quoteVolume24h: row.quoteVolume24h,
      momentumPercent: row.momentumPercent, volumeChangePercent: row.volumeChangePercent, liquidity: row.liquidity,
      bidDepthQuote: row.bidDepthQuote, askDepthQuote: row.askDepthQuote, signalStatus: 'OBSERVATION_ONLY',
      sourceLinks: row.sourceLinks, sources: snapshot.sources },
  }));
  if (!rows.length) return 'NO_OBSERVATIONS';
  try {
    return await withHistoryConnection(target, async pool => {
      if (signal.aborted || !approvedForStorage()) return 'DISABLED';
      const result = await pool.query(
        `INSERT INTO smartexit_alpha.observations (alpha_id, chain, contract, market, observed_at, collected_at, measurements)
         SELECT alpha_id, chain, contract, market, observed_at, collected_at, measurements
           FROM jsonb_to_recordset($1::jsonb) AS item(alpha_id text, chain text, contract text, market text,
             observed_at timestamptz, collected_at timestamptz, measurements jsonb)
         ON CONFLICT (alpha_id, chain, contract, market, observed_at) DO NOTHING`, [JSON.stringify(rows)]);
      return result.rowCount ? 'STORED' : 'ALREADY_RECORDED';
    });
  } catch {
    return 'UNAVAILABLE';
  }
}

export type ArchivedAlphaObservation = { alpha_id: string; chain: string; contract: string;
  market: string; observed_at: string; collected_at: string; measurements: { symbol: string; price: number | null; momentumPercent: number | null } };

export async function readAlphaObservationHistory(env: AdminDemoEnvironment, hostname: string) {
  if (!alphaHistoryReadEnabled(env, hostname)) return null;
  const target = historyTarget(env, hostname)!;
  return withHistoryConnection(target, async pool => (await pool.query<ArchivedAlphaObservation>(
    `SELECT alpha_id, chain, contract, market, observed_at, collected_at, measurements
       FROM smartexit_alpha.observations ORDER BY collected_at DESC, alpha_id, market LIMIT 25`,
  )).rows);
}
