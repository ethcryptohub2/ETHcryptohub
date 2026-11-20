import { NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { isDatabaseConfigured, query } from '../../../../lib/db';
import { getScannerSyncState } from '../../../../lib/scanner-coins';
import { scannerSyncIsRecent } from '../../../../lib/scanner-snapshot';
import { createAdminReadLimiter } from '../../../../lib/admin-read-rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const allowRead = createAdminReadLimiter();

type DiagnosticStatus = 'ok' | 'warning' | 'error';
type DiagnosticCheck = {
  id: string;
  label: string;
  status: DiagnosticStatus;
  detail: string;
  recommendation?: string;
};

async function checkDatabase(): Promise<DiagnosticCheck> {
  if (!isDatabaseConfigured()) {
    return {
      id: 'database',
      label: 'Database',
      status: 'error',
      detail: 'Database connection settings are missing.',
      recommendation: 'Configure SUPABASE_DB_URL or SUPABASE_DB_HOST, SUPABASE_DB_USER, and SUPABASE_DB_PASSWORD.',
    };
  }
  try {
    await query('SELECT 1');
    return { id: 'database', label: 'Database', status: 'ok', detail: 'Database connection is responding.' };
  } catch {
    return {
      id: 'database',
      label: 'Database',
      status: 'error',
      detail: 'The application could not query the configured database.',
      recommendation: 'Check the database URL, network access, and Supabase availability.',
    };
  }
}

function checkAuthSecret(): DiagnosticCheck {
  const configured = (process.env.AUTH_SECRET?.length ?? 0) >= 32;
  return {
    id: 'auth',
    label: 'Authentication secret',
    status: configured ? 'ok' : 'error',
    detail: configured ? 'Authentication secret is configured.' : 'Authentication secret is missing or too short.',
    ...(!configured && { recommendation: 'Set AUTH_SECRET to a private value of at least 32 characters, then restart or redeploy.' }),
  };
}

function checkEmail(): DiagnosticCheck {
  const gmailUser = Boolean(process.env.GMAIL_USER?.trim());
  const gmailPassword = Boolean(process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, ''));
  const resendKey = Boolean(process.env.RESEND_API_KEY);
  const mailFrom = Boolean(process.env.MAIL_FROM);
  const configured = (gmailUser && gmailPassword) || (resendKey && mailFrom);
  const partiallyConfigured = gmailUser || gmailPassword || resendKey || mailFrom;
  return {
    id: 'email',
    label: 'Email delivery configuration',
    status: configured ? 'ok' : partiallyConfigured ? 'warning' : 'error',
    detail: configured
      ? 'A supported email provider is configured.'
      : 'No complete email provider configuration was found.',
    ...(!configured && {
      recommendation: 'Set both GMAIL_USER and GMAIL_APP_PASSWORD, or both RESEND_API_KEY and MAIL_FROM.',
    }),
  };
}

function marketConnectivityStatus(): DiagnosticCheck {
  return {
    id: 'binance',
    label: 'Binance market-data API',
    status: 'warning',
    detail: 'Connectivity has not been checked by these diagnostics.',
    recommendation: 'A finite public market check requires separate approval.',
  };
}

async function checkScanner(): Promise<DiagnosticCheck> {
  try {
    const state = await getScannerSyncState();
    if (!state?.last_success_at) {
      return {
        id: 'scanner',
        label: 'Scanner sync',
        status: 'warning',
        detail: 'The scanner has no recorded successful universe sync.',
        recommendation: 'A scanner refresh requires separate approval.',
      };
    }
    if (state.exchange_status === 'ERROR') {
      return {
        id: 'scanner',
        label: 'Scanner sync',
        status: 'error',
        detail: 'The most recent scanner sync failed.',
        recommendation: 'Review the scanner sync evidence before approving another refresh.',
      };
    }
    return {
      id: 'scanner',
      label: 'Scanner sync',
      status: scannerSyncIsRecent(state.last_success_at) ? 'ok' : 'warning',
      detail: `Last successful sync: ${new Date(state.last_success_at).toLocaleString('en-US', { timeZone: 'UTC' })} UTC.`,
      recommendation: 'Pair discovery status does not establish fresh scan results. Review snapshot timestamps; no automatic recovery is performed.',
    };
  } catch {
    return {
      id: 'scanner',
      label: 'Scanner sync',
      status: 'error',
      detail: 'Scanner sync status could not be read.',
      recommendation: 'Check database connectivity and scanner migration availability.',
    };
  }
}

export async function GET() {
  try {
    const admin = await requireAdmin();
    if (!allowRead(admin.id)) {
      return NextResponse.json({ error: 'Too many diagnostics requests. Wait a minute and retry.' }, {
        status: 429, headers: { 'Cache-Control': 'no-store' },
      });
    }
    const checks = await Promise.all([checkDatabase(), checkAuthSecret(), checkEmail(), marketConnectivityStatus(), checkScanner()]);
    return NextResponse.json({ data: { checks, checkedAt: new Date().toISOString() } }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof AuthError ? error.message : 'Diagnostics could not be completed.';
    const status = error instanceof AuthError ? error.status : 503;
    return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
