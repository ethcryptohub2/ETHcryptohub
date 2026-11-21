import { AuthError, requireAdmin } from '../../../../lib/auth';
import { isApprovedAdminDemoStagingTarget } from '../../../../lib/admin-demo-staging-policy';
import { query } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: object, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store' },
});

export async function GET() {
  try {
    await requireAdmin();
    const staging = process.env.VERCEL_ENV === 'preview' &&
      process.env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF === 'ghecpkpaxbrvehquhzkr' &&
      isApprovedAdminDemoStagingTarget(process.env);
    if (!staging) return json({ state: 'OUTSIDE_STAGING', runs: [] });
    const readiness = await query<{ installed: boolean }>(
      "SELECT to_regclass('public.scanner_pilot_runs') IS NOT NULL AS installed",
    );
    if (!readiness.rows[0]?.installed) return json({ state: 'SCHEMA_PENDING', runs: [] });
    const result = await query(
      `SELECT slot_at, approved_sha, symbols, state, started_at, finished_at, failure_code,
              report->>'quoteObservedAt' AS quote_observed_at,
              report->>'standardCreated' AS standard_created, report->>'highRiskCreated' AS high_risk_created,
              CASE WHEN jsonb_typeof(report->'rows') = 'array' THEN (
                SELECT jsonb_agg(jsonb_build_object(
                  'symbol', observation->>'symbol', 'candle', observation->>'candleCloseAt',
                  'standard', observation->'standard'->>'status', 'standardReason', observation->'standard'->>'reason',
                  'highRisk', observation->'highRisk'->>'status', 'highRiskReason', observation->'highRisk'->>'reason'
                )) FROM jsonb_array_elements(report->'rows') AS observation
              ) END AS outcomes
         FROM public.scanner_pilot_runs ORDER BY slot_at DESC LIMIT 10`,
    );
    const started = Date.parse(process.env.SMARTEXIT_SCANNER_PILOT_START_UTC ?? '');
    const stopped = Date.parse(process.env.SMARTEXIT_SCANNER_PILOT_STOP_UTC ?? '');
    const now = Date.now();
    const windowConfigured = process.env.SMARTEXIT_SCANNER_PILOT_ENABLED === 'true' &&
      Boolean(process.env.VERCEL_GIT_COMMIT_SHA) &&
      process.env.SMARTEXIT_SCANNER_PILOT_APPROVED_SHA === process.env.VERCEL_GIT_COMMIT_SHA &&
      started <= now && now < stopped && stopped - started <= 60 * 60_000;
    return json({ state: windowConfigured ? 'WINDOW_CONFIGURED' : 'DISABLED', runs: result.rows });
  } catch (error) {
    if (error instanceof AuthError) return json({ error: 'ADMIN_ACCESS_REQUIRED' }, error.status);
    return json({ error: 'PILOT_HISTORY_UNAVAILABLE' }, 503);
  }
}
