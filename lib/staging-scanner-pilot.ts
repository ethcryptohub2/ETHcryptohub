import { timingSafeEqual } from 'node:crypto';
import { Pool, type QueryResultRow } from 'pg';
import { getHighRiskScalpingSettings, insertHighRiskSignal } from './high-risk-scalping';
import { getNotificationSystemSettings, insertSignal } from './notifications';
import { getEnabledScannerSymbols, upsertScannerCandidates } from './scanner-coins';
import { evaluateStagingScanner, ScannerEvaluationFailure } from './staging-scanner-evaluation';
import type { MarketScannerCandidate } from '../smartexit/apps/api/src/services/market-scanner';

const stagingRef = 'ghecpkpaxbrvehquhzkr';
const dedicatedRole = 'smartexit_scanner_pilot';
const slotMs = 15 * 60_000;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
const denialCodes = ['PROVIDER_REGION_RESTRICTION', 'PROVIDER_DENIED', 'PROVIDER_RATE_LIMIT', 'PROVIDER_WEIGHT_GUARD'];

type Env = Record<string, string | undefined>;
type Credentials = { token?: string | null; expectedSha?: string | null; hostname: string };

export function getApprovedScannerPilot(env: Env, credentials: Credentials, now = Date.now()) {
  const token = env.SMARTEXIT_SCANNER_PILOT_TOKEN ?? '';
  const sha = env.SMARTEXIT_SCANNER_PILOT_APPROVED_SHA ?? '';
  const starts = env.SMARTEXIT_SCANNER_PILOT_START_UTC ?? '';
  const ends = env.SMARTEXIT_SCANNER_PILOT_STOP_UTC ?? '';
  const start = Date.parse(starts);
  const end = Date.parse(ends);
  const slot = Math.floor(now / slotMs) * slotMs;
  const symbols = (env.SMARTEXIT_SCANNER_PILOT_SYMBOLS ?? '').split(',');
  if (env.SMARTEXIT_SCANNER_PILOT_ENABLED !== 'true' ||
      env.VERCEL_ENV !== 'preview' || env.VERCEL_GIT_COMMIT_REF !== 'functional-staging' ||
      env.VERCEL_URL !== credentials.hostname || !/^[a-f0-9]{40}$/.test(sha) ||
      env.VERCEL_GIT_COMMIT_SHA !== sha || credentials.expectedSha !== sha ||
      env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF !== stagingRef ||
      ![`https://${stagingRef}.supabase.co`, `https://${stagingRef}.supabase.co/`].includes(env.NEXT_PUBLIC_SUPABASE_URL ?? '') ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(token) || !credentials.token ||
      Buffer.byteLength(credentials.token) !== token.length ||
      !timingSafeEqual(Buffer.from(credentials.token), Buffer.from(token)) ||
      !utc.test(starts) || !utc.test(ends) || !Number.isFinite(start) || !Number.isFinite(end) ||
      new Date(start).toISOString().replace('.000Z', 'Z') !== starts ||
      new Date(end).toISOString().replace('.000Z', 'Z') !== ends ||
      start % slotMs !== 0 || end % slotMs !== 0 || end <= start || end - start > 4 * slotMs ||
      now < start || now >= end || now - slot < 120_000 || now - slot >= 300_000 ||
      symbols.length !== 3 || new Set(symbols).size !== 3 || symbols.some(symbol => !/^[A-Z0-9]{1,20}USDT$/.test(symbol))) {
    return null;
  }
  try {
    const url = new URL(env.SMARTEXIT_SCANNER_PILOT_DB_URL ?? '');
    if (url.protocol !== 'postgresql:' || url.hostname !== `db.${stagingRef}.supabase.co` ||
        (url.port && url.port !== '5432') || url.username !== dedicatedRole || !url.password ||
        url.pathname !== '/postgres' || url.search || url.hash) return null;
    return { url, sha, symbols, slotAt: new Date(slot).toISOString(), startsAt: new Date(start).toISOString() };
  } catch {
    return null;
  }
}

type Approval = NonNullable<ReturnType<typeof getApprovedScannerPilot>>;

export async function runStagingScannerPilot(approval: Approval, signal: AbortSignal, stillApproved: () => boolean) {
  const pool = new Pool({
    connectionString: approval.url.href,
    ssl: { rejectUnauthorized: true, servername: approval.url.hostname },
    max: 1,
    connectionTimeoutMillis: 4000,
    application_name: 'smartexit-staging-scanner-pilot',
  });
  try {
    const client = await pool.connect();
    const queryDb = <Row extends QueryResultRow>(sql: string, values: readonly unknown[] = []) =>
      client.query<Row>(sql, [...values]);
    const stopReason = async () => {
      if (signal.aborted) return 'PILOT_DEADLINE';
      if (!stillApproved()) return 'APPROVAL_ENDED';
      const control = await queryDb<{ stopped: boolean }>('SELECT stopped FROM public.scanner_pilot_control WHERE singleton');
      return control.rows[0]?.stopped === false ? null : 'PILOT_STOP_SWITCH';
    };
    const requireActivePilot = async () => {
      const reason = await stopReason();
      if (reason) throw new ScannerEvaluationFailure(reason);
    };
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '1s'; SET LOCAL idle_in_transaction_session_timeout = '20s'");
      const identity = await client.query<{ role: string; database: string }>('SELECT current_user AS role, current_database() AS database');
      if (identity.rows[0]?.role !== dedicatedRole || identity.rows[0].database !== 'postgres') {
        throw new Error('SCANNER_PILOT_DB_IDENTITY');
      }
      const lock = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock(783121, 501) AS acquired');
      if (!lock.rows[0]?.acquired) return { state: 'BUSY' as const };
      const stopped = await stopReason();
      if (stopped) return { state: 'STOPPED' as const, failureCode: stopped };
      const denial = await queryDb('SELECT 1 FROM public.scanner_pilot_runs WHERE slot_at >= $1 AND failure_code = ANY($2) LIMIT 1',
        [approval.startsAt, denialCodes]);
      if (denial.rowCount) return { state: 'PROVIDER_STOP_LATCHED' as const };
      const inserted = await queryDb(
        `INSERT INTO public.scanner_pilot_runs (slot_at, approved_sha, symbols)
         VALUES ($1, $2, $3) ON CONFLICT (slot_at) DO NOTHING`,
        [approval.slotAt, approval.sha, approval.symbols],
      );
      if (!inserted.rowCount) return { state: 'DUPLICATE' as const };
      await client.query('SAVEPOINT scanner_batch');
      try {
        const standard = await getNotificationSystemSettings(queryDb);
        const highRisk = await getHighRiskScalpingSettings(queryDb);
        const eligible = new Set(await getEnabledScannerSymbols(queryDb));
        if (approval.symbols.some(symbol => !eligible.has(symbol))) throw new ScannerEvaluationFailure('SYMBOL_NOT_ENABLED');
        await requireActivePilot();
        let candidates: MarketScannerCandidate[] = [];
        const evaluation = await evaluateStagingScanner({
          symbols: approval.symbols, minimumScore: standard.minimumSetupScore, highRisk,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          onStandardCandidates: rows => { candidates = rows; },
          beforeProviderRequest: requireActivePilot,
        });
        await requireActivePilot();
        if (candidates.length !== approval.symbols.length ||
            candidates.some(row => row.status !== 'READY' && row.status !== 'WAIT')) {
          throw new ScannerEvaluationFailure('STANDARD_EVIDENCE_INCOMPLETE');
        }
        await upsertScannerCandidates(client, candidates);
        let standardCreated = 0;
        let highRiskCreated = 0;
        for (const row of candidates) {
          if (await insertSignal(client, row, standard)) standardCreated++;
        }
        for (const row of evaluation.rows) {
          if (row.highRisk.setup && await insertHighRiskSignal(client, row.highRisk.setup, highRisk)) highRiskCreated++;
        }
        await requireActivePilot();
        await queryDb(
          "UPDATE public.scanner_pilot_runs SET state = 'COMPLETED', finished_at = statement_timestamp(), report = $2::jsonb WHERE slot_at = $1",
          [approval.slotAt, JSON.stringify({ ...evaluation, standardCreated, highRiskCreated,
            sources: ['BINANCE_USDM_TICKER_24HR', 'BINANCE_USDM_KLINES'] })],
        );
        await client.query('COMMIT');
        return { state: 'COMPLETED' as const, slotAt: approval.slotAt, standardCreated, highRiskCreated };
      } catch (error) {
        const failureCode = error instanceof ScannerEvaluationFailure ? error.code : 'PILOT_STORAGE_OR_RUNTIME_ERROR';
        await client.query('ROLLBACK TO SAVEPOINT scanner_batch');
        await queryDb(
          "UPDATE public.scanner_pilot_runs SET state = 'FAILED', finished_at = statement_timestamp(), failure_code = $2 WHERE slot_at = $1",
          [approval.slotAt, failureCode],
        );
        await client.query('COMMIT');
        return { state: 'FAILED' as const, slotAt: approval.slotAt, failureCode };
      }
    } finally {
      // Closing discards a connection if rollback itself fails.
      let broken: Error | undefined;
      try { await client.query('ROLLBACK'); } catch { broken = new Error('PILOT_ROLLBACK_FAILED'); }
      client.release(broken);
    }
  } finally {
    await pool.end();
  }
}
