import type { NextRequest } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { guardedPost } from '../../../../lib/http';
import { isApprovedAdminDemoStagingTarget } from '../../../../lib/admin-demo-staging-policy';
import { query } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: object, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store' },
});

function isStagingPilot() {
  const isStaging = process.env.VERCEL_ENV === 'preview' || process.env.SMARTEXIT_DEPLOYMENT_ENV === 'staging';
  return isStaging &&
    process.env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF === 'ghecpkpaxbrvehquhzkr' &&
    isApprovedAdminDemoStagingTarget(process.env);
}

function windowConfigured() {
  const started = Date.parse(process.env.SMARTEXIT_SCANNER_PILOT_START_UTC ?? '');
  const stopped = Date.parse(process.env.SMARTEXIT_SCANNER_PILOT_STOP_UTC ?? '');
  const now = Date.now();
  const currentSha = process.env.RENDER_GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA;
  return process.env.SMARTEXIT_SCANNER_PILOT_ENABLED === 'true' &&
    Boolean(currentSha) &&
    process.env.SMARTEXIT_SCANNER_PILOT_APPROVED_SHA === currentSha &&
    started <= now && now < stopped && stopped - started <= 60 * 60_000;
}

export async function GET() {
  try {
    await requireAdmin();
    if (!isStagingPilot()) return json({ state: 'OUTSIDE_STAGING', runs: [] });
    const readiness = await query<{ installed: boolean }>(
      "SELECT to_regclass('public.scanner_pilot_runs') IS NOT NULL AND to_regclass('public.scanner_pilot_control') IS NOT NULL AS installed",
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
    if (!windowConfigured()) return json({ state: 'DISABLED', runs: result.rows });
    const control = await query<{ stopped: boolean }>('SELECT stopped FROM public.scanner_pilot_control WHERE singleton');
    return json({ state: control.rows[0]?.stopped === false ? 'WINDOW_CONFIGURED' : 'STOPPED', runs: result.rows });
  } catch (error) {
    if (error instanceof AuthError) return json({ error: 'ADMIN_ACCESS_REQUIRED' }, error.status);
    return json({ error: 'PILOT_HISTORY_UNAVAILABLE' }, 503);
  }
}

export async function POST(request: NextRequest) {
  const rejected = guardedPost(request);
  if (rejected) return rejected;
  try {
    await requireAdmin();
    if (request.body !== null || request.nextUrl.search) return json({ error: 'INVALID_PILOT_STOP' }, 422);
    const currentHost = process.env.RENDER_EXTERNAL_HOSTNAME || process.env.VERCEL_URL || (process.env.APP_URL ? new URL(process.env.APP_URL).hostname : null);
    const hostMatches = request.nextUrl.hostname === currentHost || (currentHost && request.nextUrl.hostname.endsWith('.onrender.com'));
    if (!isStagingPilot() || !windowConfigured() || !hostMatches) {
      return json({ error: 'PILOT_STOP_UNAVAILABLE' }, 503);
    }
    const result = await query(
      'UPDATE public.scanner_pilot_control SET stopped = true, updated_at = statement_timestamp() WHERE singleton RETURNING stopped',
    );
    return result.rowCount === 1 ? json({ state: 'STOPPED' }) : json({ error: 'PILOT_STOP_UNAVAILABLE' }, 503);
  } catch (error) {
    return json({ error: 'PILOT_STOP_UNAVAILABLE' }, error instanceof AuthError ? error.status : 503);
  }
}
