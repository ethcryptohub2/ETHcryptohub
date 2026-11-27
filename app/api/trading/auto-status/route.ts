import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { forwardRequestToBackend, shouldForwardToBackend } from '../../../../lib/backend-proxy';
import { query } from '../../../../lib/db';
import { listExchangeProviders } from '../../../../lib/exchanges/providers';
import { getScannerV2State } from '../../../../lib/scanner-scheduler';
import { getStrategyProfiles } from '../../../../lib/strategy-management';
import { getTradingSettings } from '../../../../lib/trading-settings';
import { getWorkerHealthStatus } from '../../../../lib/worker-lease';
import type { DemoAutoTelemetryEntry } from '../../../../lib/trading-execution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    if (shouldForwardToBackend()) {
      const forwarded = await forwardRequestToBackend(request, '/api/trading/auto-status');
      if (forwarded) return forwarded;
    }

    const safeMode =
      process.env.WORKER_SAFE_MODE === 'true' ||
      process.env.DEMO_ORDER_DISPATCH_ENABLED !== 'true';
    const adminOnlyAutoTrade = process.env.SMARTEXIT_DEMO_AUTO_EXECUTION_ADMIN_ONLY === 'true';
    const customerDemoAutoExecutionEnabled = process.env.SMARTEXIT_CUSTOMER_DEMO_AUTO_EXECUTION_ENABLED === 'true';

    const [
      workerHealth,
      scannerState,
      tradingSettings,
      strategies,
      providers,
      exchangeSwitches,
      exchangeCreds,
      binanceCreds,
      recentExecutions,
      telemetryRes,
    ] = await Promise.all([
      getWorkerHealthStatus().catch(() => null),
      getScannerV2State().catch(() => null),
      getTradingSettings(user.id),
      getStrategyProfiles(user.id).catch(() => []),
      listExchangeProviders().catch(() => []),
      query<{ exchange: string; environment: string; auto_trade_enabled: boolean; execution_mode: string; emergency_stop_enabled: boolean }>(
        `SELECT exchange, environment, auto_trade_enabled, execution_mode, emergency_stop_enabled
           FROM public.user_exchange_trading_settings
          WHERE user_id = $1 AND environment IN ('DEMO', 'TESTNET')`,
        [user.id],
      ).catch(() => ({ rows: [] })),
      query<{ exchange: string; environment: string; environment_confirmed: boolean; last_verified_at: string | null }>(
        `SELECT exchange, environment, environment_confirmed, last_verified_at
           FROM public.exchange_api_credentials
          WHERE user_id = $1 AND environment IN ('DEMO', 'TESTNET')`,
        [user.id],
      ).catch(() => ({ rows: [] })),
      query<{ environment: string; environment_confirmed: boolean }>(
        `SELECT environment, environment_confirmed
           FROM public.binance_api_credentials
          WHERE user_id = $1 AND environment = 'DEMO'`,
        [user.id],
      ).catch(() => ({ rows: [] })),
      query<{
        id: string;
        signal_id: string;
        exchange: string;
        strategy: string;
        symbol: string;
        side: string;
        execution_status: string;
        protection_status: string;
        error_message: string | null;
        binance_order_id: string | null;
        created_at: string;
      }>(
        `SELECT id::TEXT, signal_id::TEXT, exchange, strategy, symbol, side, execution_status,
                protection_status, error_message, binance_order_id, created_at
           FROM public.trade_executions
          WHERE user_id = $1 AND environment = 'DEMO'
          ORDER BY id DESC
          LIMIT 20`,
        [user.id],
      ).catch(() => ({ rows: [] })),
      query<{ value_json: unknown }>(
        `SELECT value_json FROM public.app_settings WHERE key = 'demo_auto_execution_telemetry'`,
      ).catch(() => ({ rows: [] })),
    ]);

    const switchMap = new Map(exchangeSwitches.rows.map((r) => [r.exchange, r]));
    const credMap = new Map<string, { configured: boolean; lastVerifiedAt: string | null }>();
    for (const c of exchangeCreds.rows) {
      if (c.environment_confirmed) {
        credMap.set(c.exchange, { configured: true, lastVerifiedAt: c.last_verified_at });
      }
    }
    if (binanceCreds.rows[0]?.environment_confirmed && !credMap.has('BINANCE')) {
      credMap.set('BINANCE', { configured: true, lastVerifiedAt: null });
    }

    const exchanges = providers.map((p) => {
      const sw = switchMap.get(p.exchange);
      const cred = credMap.get(p.exchange);
      const demoEnv = p.environments.find((e) => e.environment === 'DEMO' || e.environment === 'TESTNET');
      return {
        exchange: p.exchange,
        name: p.name,
        providerDemoEnabled: Boolean(demoEnv?.enabled),
        customerTradingReady: Boolean(demoEnv?.customerTradingReady),
        userAutoTradeEnabled: Boolean(sw?.auto_trade_enabled),
        userExecutionMode: sw?.execution_mode ?? 'CONFIRM',
        userEmergencyStopEnabled: Boolean(sw?.emergency_stop_enabled),
        credentialsConfigured: Boolean(cred?.configured),
        lastVerifiedAt: cred?.lastVerifiedAt ?? null,
      };
    });

    const rawTelemetry = Array.isArray(telemetryRes.rows[0]?.value_json)
      ? (telemetryRes.rows[0].value_json as DemoAutoTelemetryEntry[])
      : [];
    const userTelemetry = rawTelemetry.filter((entry) => entry && entry.userId === user.id).slice(0, 15);

    return NextResponse.json(
      {
        data: {
          workerHealth,
          scanner: scannerState,
          trading: tradingSettings,
          strategies,
          exchanges,
          executions: recentExecutions.rows,
          telemetry: userTelemetry,
          gate: {
            liveLocked: true,
            demoDispatchEnabled: !safeMode,
            safeMode,
            adminOnlyAutoTrade,
            userRole: user.role,
            eligibleForUser: !adminOnlyAutoTrade || user.role === 'admin',
            customerDemoAutoExecutionEnabled,
            safetyGateMessage: customerDemoAutoExecutionEnabled
              ? null
              : 'Automatic Demo execution is paused pending completion of the execution safety audit.',
          },
        },
      },
      { headers: noStore },
    );
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Auto-execution status is unavailable.' },
      { status, headers: noStore },
    );
  }
}
