import { NextRequest } from 'next/server';
import { z } from 'zod';
import { AuthError, requireUser } from '../../../../lib/auth';
import { forwardRequestToBackend, shouldForwardToBackend } from '../../../../lib/backend-proxy';
import { BinanceFuturesError, createBinanceEnvironmentAdapter } from '../../../../lib/binance-futures';
import { getTradingSettings } from '../../../../lib/trading-settings';
import { query } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const positionSchema = z.array(z.object({
  symbol: z.string(),
  positionAmt: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  entryPrice: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  markPrice: z.string().regex(/^\d+(?:\.\d+)?$/),
  unRealizedProfit: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  leverage: z.string().regex(/^\d+$/).nullish(),
  positionSide: z.enum(['BOTH', 'LONG', 'SHORT']),
}));

async function fetchDbActiveExecutions(userId: number, environment: string) {
  try {
    const res = await query<{
      symbol: string;
      leverage: number;
      actual_fill_price: string | null;
      stop_loss: string | null;
      take_profit: string | null;
      tp1_price: string | null;
      tp2_price: string | null;
      tp3_price: string | null;
      execution_status: string;
      strategy: string;
    }>(
      `SELECT symbol, leverage, actual_fill_price::TEXT, stop_loss::TEXT, take_profit::TEXT,
              tp1_price::TEXT, tp2_price::TEXT, tp3_price::TEXT, execution_status, strategy
         FROM public.trade_executions
        WHERE user_id = $1 AND environment = $2
          AND execution_status IN ('PROTECTED', 'ENTRY_FILLED', 'EXECUTING', 'AWAITING_CONFIRMATION')
        ORDER BY id DESC`,
      [userId, environment],
    );
    return res.rows;
  } catch {
    return [];
  }
}

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

    // Query active executions to enrich missing leverage, stops and targets
    const activeExecs = await fetchDbActiveExecutions(user.id, settings.active_environment);
    const execBySymbol = new Map<string, (typeof activeExecs)[0]>();
    for (const row of activeExecs) {
      if (!execBySymbol.has(row.symbol)) {
        execBySymbol.set(row.symbol, row);
      }
    }

    const positions = parsed.data
      .filter((position) => Number(position.positionAmt) !== 0)
      .map((position) => {
        const exec = execBySymbol.get(position.symbol);
        const resolvedLeverage = position.leverage && Number(position.leverage) > 0
          ? position.leverage
          : exec?.leverage ? String(exec.leverage) : null;

        const resolvedEntryPrice = position.entryPrice && Number(position.entryPrice) > 0
          ? position.entryPrice
          : exec?.actual_fill_price && Number(exec.actual_fill_price) > 0
            ? exec.actual_fill_price
            : null;

        const notional = Math.abs(Number(position.positionAmt) * Number(position.markPrice));
        const levNum = Number(resolvedLeverage) || 1;
        const margin = notional / levNum;

        return {
          ...position,
          entryPrice: resolvedEntryPrice,
          leverage: resolvedLeverage,
          notionalUsdt: notional.toFixed(2),
          marginUsdt: margin.toFixed(2),
          stopLoss: exec?.stop_loss ?? null,
          takeProfit: exec?.take_profit ?? null,
          tp1: exec?.tp1_price ?? null,
          tp2: exec?.tp2_price ?? null,
          tp3: exec?.tp3_price ?? null,
          executionStatus: exec?.execution_status ?? 'OPEN',
          strategy: exec?.strategy ?? null,
          direction: position.positionSide === 'BOTH'
            ? Number(position.positionAmt) > 0 ? 'LONG' : 'SHORT'
            : position.positionSide,
          environment: settings.active_environment,
        };
      });

    return Response.json({
      data: {
        exchange: 'BINANCE',
        environment: settings.active_environment,
        virtualFunds: settings.active_environment === 'DEMO',
        positions,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof BinanceFuturesError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Futures positions are unavailable.' }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
