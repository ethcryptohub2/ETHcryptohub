import { NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { isDatabaseConfigured, query } from '../../../../lib/db';
import { getScannerSyncState, consumeScannerAdminRateLimit } from '../../../../lib/scanner-coins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  } catch (error) {
    console.error('Admin diagnostic database check failed:', error instanceof Error ? error.message : 'Unknown error');
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

async function checkBinance(): Promise<DiagnosticCheck> {
  try {
    const response = await fetch('https://fapi.binance.com/fapi/v1/ping', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        id: 'binance',
        label: 'Binance market-data API',
        status: 'error',
        detail: `Binance returned HTTP ${response.status}.`,
        recommendation: 'Check Binance API availability and outbound network access from this server.',
      };
    }
    return { id: 'binance', label: 'Binance market-data API', status: 'ok', detail: 'Public market-data endpoint is responding.' };
  } catch (error) {
    console.error('Admin diagnostic Binance check failed:', error instanceof Error ? error.message : 'Unknown error');
    return {
      id: 'binance',
      label: 'Binance market-data API',
      status: 'error',
      detail: 'The public market-data endpoint could not be reached.',
      recommendation: 'Check Binance availability and outbound network access from this server.',
    };
  }
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
        recommendation: 'Use “Attempt safe scanner recovery” to sync the pair list and run one scan.',
      };
    }
    if (state.exchange_status === 'ERROR') {
      return {
        id: 'scanner',
        label: 'Scanner sync',
        status: 'error',
        detail: state.last_error ?? 'The most recent scanner sync failed.',
        recommendation: 'Try a safe scanner recovery. If it fails again, check the database and Binance checks above.',
      };
    }
    return {
      id: 'scanner',
      label: 'Scanner sync',
      status: 'ok',
      detail: `Last successful sync: ${new Date(state.last_success_at).toLocaleString('en-US', { timeZone: 'UTC' })} UTC.`,
    };
  } catch (error) {
    console.error('Admin diagnostic scanner check failed:', error instanceof Error ? error.message : 'Unknown error');
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
    await consumeScannerAdminRateLimit(admin.id, 'read');
    const checks = await Promise.all([checkDatabase(), checkAuthSecret(), checkEmail(), checkBinance(), checkScanner()]);
    return NextResponse.json({ data: { checks, checkedAt: new Date().toISOString() } }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Diagnostics could not be completed.';
    if (!(error instanceof AuthError) && !message.startsWith('Too many')) {
      console.error('Admin diagnostics failed:', message);
    }
    const status = error instanceof AuthError ? error.status : message.startsWith('Too many') ? 429 : 503;
    return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
