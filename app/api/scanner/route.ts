import { NextRequest, NextResponse } from 'next/server';
import { requireUser, AuthError } from '../../../lib/auth';
import { pool } from '../../../lib/db';
import { marketScannerQuerySchema } from '../../../smartexit/apps/api/src/schemas';
import { BinanceFuturesMarketsService } from '../../../smartexit/apps/api/src/services/binance-futures-markets';
import { BinanceMarketScannerService } from '../../../smartexit/apps/api/src/services/market-scanner';

export const runtime = 'nodejs';
export const maxDuration = 60;

const markets = new BinanceFuturesMarketsService();
const scanner = new BinanceMarketScannerService(markets);

export async function GET(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Sign in is required.' },
      { status: error instanceof AuthError ? error.status : 401 },
    );
  }

  const parsed = marketScannerQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid scanner configuration.' }, { status: 422 });

  try {
    const userId = `ethcryptohub-${user.id}`;
    const { rows } = await pool().query<{ paper_equity: string; max_risk_per_trade_percent: string; max_open_positions: number; kill_switch_enabled: boolean }>(
      'SELECT paper_equity, max_risk_per_trade_percent, max_open_positions, kill_switch_enabled FROM risk_settings WHERE user_id = $1',
      [userId],
    );
    const riskSettings = rows[0];
    if (!riskSettings) {
      return NextResponse.json(
        { error: 'Risk settings are unavailable. Open SmartExit to initialize your paper account before scanning.' },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const paperEquity = Number(riskSettings.paper_equity);
    const configuredRiskPercent = Number(riskSettings.max_risk_per_trade_percent);
    if (!Number.isFinite(paperEquity) || paperEquity <= 0 || !Number.isFinite(configuredRiskPercent) || configuredRiskPercent <= 0) {
      return NextResponse.json(
        { error: 'Your paper-account risk settings are invalid. Update them before scanning.' },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const riskBudget = paperEquity * Math.min(configuredRiskPercent, 1) / 100;
    const result = await scanner.scan(
      { ...parsed.data, quoteAsset: 'USDT' },
      {
        riskBudget,
        blockedReason: riskSettings?.kill_switch_enabled
          ? 'Risk Guardian kill switch is enabled; proposed setups are blocked.'
          : null,
      },
    );
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Binance scanner request failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Live Binance market data is temporarily unavailable.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
