import { NextRequest } from 'next/server';
import { z } from 'zod';
import { AuthError, requireUser } from '../../../../lib/auth';
import { forwardRequestToBackend, shouldForwardToBackend } from '../../../../lib/backend-proxy';
import { BinanceFuturesError, createBinanceEnvironmentAdapter } from '../../../../lib/binance-futures';
import { getTradingSettings } from '../../../../lib/trading-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const positionSchema = z.array(z.object({
  symbol: z.string(),
  positionAmt: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  entryPrice: z.string().regex(/^\d+(?:\.\d+)?$/),
  markPrice: z.string().regex(/^\d+(?:\.\d+)?$/),
  unRealizedProfit: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  leverage: z.string().regex(/^\d+$/),
  positionSide: z.string(),
}));

export async function GET(request?: NextRequest) {
  try {
    const user = await requireUser();
    if (request && 'headers' in request && shouldForwardToBackend()) {
      const forwarded = await forwardRequestToBackend(request, '/api/trading/positions');
      if (forwarded) return forwarded;
    }
    const settings = await getTradingSettings(user.id);
    const adapter = await createBinanceEnvironmentAdapter(user.id, settings.active_environment);
    const raw: unknown = await adapter.request('GET', '/fapi/v3/positionRisk');
    const parsed = positionSchema.safeParse(raw);
    if (!parsed.success) throw new BinanceFuturesError('Binance returned an invalid position response.');
    const positions = parsed.data
      .filter((position) => Number(position.positionAmt) !== 0)
      .map((position) => ({ ...position, environment: settings.active_environment }));
    return Response.json({
      data: { environment: settings.active_environment, virtualFunds: settings.active_environment === 'DEMO', positions },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof BinanceFuturesError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Futures positions are unavailable.' }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
