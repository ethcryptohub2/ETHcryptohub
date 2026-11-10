import { AuthError, requireUser } from '../../../../../lib/auth';
import { BinanceFuturesError, getFuturesBalance } from '../../../../../lib/binance-futures';
import { getTradingSettings } from '../../../../../lib/trading-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    const settings = await getTradingSettings(user.id);
    const data = await getFuturesBalance(user.id, settings.active_environment);
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof BinanceFuturesError ? error.status : 503;
    return Response.json(
      { error: error instanceof Error ? error.message : 'Binance Futures balance is unavailable.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
