import 'server-only';

import { z } from 'zod';
import { query } from './db';
import { createBinanceEnvironmentAdapter } from './binance-futures';

export interface SyncResult {
  ok: boolean;
  syncedAt: string;
  reconciledCount: number;
  openPositionsCount: number;
  unmatchedCount: number;
  isStale: boolean;
  staleReason?: string;
  error?: string;
}

export interface ReconciledPosition {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  leverage: number;
  notionalUsdt: number;
  liquidationPrice?: number;
}

export interface UnmatchedExchangeTrade {
  id: string;
  userId: number;
  symbol: string;
  orderId: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  time: string;
}

const userTradeSchema = z.object({
  id: z.union([z.number(), z.string()]),
  orderId: z.union([z.number(), z.string()]),
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  price: z.string(),
  qty: z.string(),
  realizedPnl: z.string(),
  marginAsset: z.string().optional(),
  quoteQty: z.string().optional(),
  commission: z.string().optional(),
  commissionAsset: z.string().optional(),
  time: z.number(),
  buyer: z.boolean().optional(),
  maker: z.boolean().optional(),
});

const incomeRowSchema = z.object({
  symbol: z.string(),
  incomeType: z.string(),
  income: z.string(),
  asset: z.string(),
  info: z.string().optional(),
  time: z.number(),
  tranId: z.union([z.number(), z.string()]),
  tradeId: z.union([z.number(), z.string()]).nullish(),
});

const positionRiskSchema = z.object({
  symbol: z.string(),
  positionAmt: z.string(),
  entryPrice: z.string(),
  markPrice: z.string(),
  unRealizedProfit: z.string(),
  leverage: z.string().optional(),
  liquidationPrice: z.string().optional(),
  marginType: z.string().optional(),
});

const orderSchema = z.object({
  orderId: z.union([z.number(), z.string()]),
  symbol: z.string(),
  status: z.string(),
  clientOrderId: z.string().optional(),
  price: z.string().optional(),
  avgPrice: z.string().optional(),
  origQty: z.string().optional(),
  executedQty: z.string().optional(),
  type: z.string().optional(),
  side: z.enum(['BUY', 'SELL']),
  stopPrice: z.string().optional(),
  time: z.number().optional(),
  updateTime: z.number().optional(),
});

/**
 * Persists or updates the sync checkpoint in public.app_settings.
 */
export async function saveSyncCheckpoint(state: {
  syncedAt: string;
  status: 'OK' | 'STALE' | 'ERROR';
  reconciledCount: number;
  openPositionsCount: number;
  error?: string;
}) {
  try {
    await query(
      `INSERT INTO public.app_settings (key, value_json, updated_at)
       VALUES ('binance_demo_trade_performance_sync', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
      [JSON.stringify(state)],
    );
  } catch (err) {
    console.error('Failed to save trade performance sync checkpoint:', err);
  }
}

/**
 * Loads the last sync checkpoint.
 */
export async function getSyncCheckpoint(): Promise<{
  syncedAt: string | null;
  status: 'OK' | 'STALE' | 'ERROR';
  reconciledCount: number;
  openPositionsCount: number;
  error?: string;
  updatedAt: string | null;
}> {
  let dbReconciled = 0;
  let dbOpenPositions = 0;
  try {
    const dbCounts = await query<{ reconciled: string; open_pos: string }>(
      `SELECT 
         COUNT(*) FILTER (WHERE reconciliation_status = 'RECONCILED')::text as reconciled,
         COUNT(*) FILTER (WHERE execution_status IN ('ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED'))::text as open_pos
       FROM public.trade_executions
      WHERE exchange = 'BINANCE' AND environment = 'DEMO'`,
    );
    dbReconciled = Number(dbCounts.rows[0]?.reconciled || 0);
    dbOpenPositions = Number(dbCounts.rows[0]?.open_pos || 0);
  } catch {}

  try {
    const res = await query<{
      value_json: {
        syncedAt?: string;
        status?: 'OK' | 'STALE' | 'ERROR';
        reconciledCount?: number;
        openPositionsCount?: number;
        error?: string;
      };
      updated_at: string;
    }>(
      `SELECT value_json, updated_at FROM public.app_settings WHERE key = 'binance_demo_trade_performance_sync'`,
    );
    if (res.rows[0]) {
      const v = res.rows[0].value_json;
      return {
        syncedAt: v?.syncedAt ?? null,
        status: v?.status ?? 'OK',
        reconciledCount: (v?.reconciledCount && v.reconciledCount > 0) ? v.reconciledCount : dbReconciled,
        openPositionsCount: (v?.openPositionsCount !== undefined && v.openPositionsCount > 0) ? v.openPositionsCount : dbOpenPositions,
        error: v?.error,
        updatedAt: res.rows[0].updated_at,
      };
    }
  } catch {}
  return {
    syncedAt: null,
    status: 'OK',
    reconciledCount: dbReconciled,
    openPositionsCount: dbOpenPositions,
    updatedAt: null,
  };
}

/**
 * Reconciles Binance USDⓈ-M Futures Demo records for all users with confirmed credentials.
 * Reads user trade fills, order history, position information, realized P&L, commissions, and funding fees.
 */
export async function reconcileBinanceDemoReporting(options: {
  force?: boolean;
  maxExecutionLimit?: number;
} = {}): Promise<SyncResult> {
  const _force = options.force;
  void _force;
  const startedAt = new Date().toISOString();

  // Find all users who have Demo credentials configured
  const usersWithCreds = await query<{ user_id: number }>(
    `SELECT DISTINCT user_id FROM (
       SELECT user_id FROM public.binance_api_credentials WHERE environment = 'DEMO' AND environment_confirmed = true
       UNION
       SELECT user_id FROM public.exchange_api_credentials WHERE exchange = 'BINANCE' AND environment = 'DEMO' AND environment_confirmed = true
     ) creds ORDER BY user_id`,
  );

  if (usersWithCreds.rows.length === 0) {
    const checkpoint = await getSyncCheckpoint();
    return {
      ok: true,
      syncedAt: checkpoint.syncedAt ?? startedAt,
      reconciledCount: checkpoint.reconciledCount,
      openPositionsCount: checkpoint.openPositionsCount,
      unmatchedCount: 0,
      isStale: true,
      staleReason: 'No users with confirmed Binance Demo credentials found.',
    };
  }

  let totalReconciled = 0;
  let totalOpenPositions = 0;
  let totalUnmatched = 0;
  let anyUserSucceeded = false;
  let syncError: string | undefined;

  for (const { user_id } of usersWithCreds.rows) {
    try {
      const adapter = await createBinanceEnvironmentAdapter(user_id, 'DEMO');

      // 1. Fetch live open positions from Binance Demo
      let rawPositions: unknown;
      try {
        rawPositions = await adapter.request('GET', '/fapi/v2/positionRisk');
      } catch {
        rawPositions = await adapter.request('GET', '/fapi/v3/positionRisk');
      }

      const parsedPositions = z.array(positionRiskSchema).safeParse(rawPositions);
      const activePositions: ReconciledPosition[] = [];
      if (parsedPositions.success) {
        for (const p of parsedPositions.data) {
          const amt = Number(p.positionAmt);
          if (amt !== 0 && Number.isFinite(amt)) {
            const entry = Number(p.entryPrice);
            const mark = Number(p.markPrice);
            const unPnl = Number(p.unRealizedProfit);
            const lev = Number(p.leverage) || 1;
            const notional = Math.abs(amt * mark);
            activePositions.push({
              symbol: p.symbol,
              positionAmt: amt,
              entryPrice: entry,
              markPrice: mark,
              unrealizedProfit: unPnl,
              leverage: lev,
              notionalUsdt: notional,
              liquidationPrice: p.liquidationPrice ? Number(p.liquidationPrice) : undefined,
            });
          }
        }
      }
      totalOpenPositions += activePositions.length;

      // 2. Fetch distinct symbols from SmartExit executions for this user
      const symbolsRes = await query<{ symbol: string; min_time: string; max_time: string }>(
        `SELECT symbol, MIN(created_at)::text as min_time, MAX(COALESCE(closed_at, NOW()))::text as max_time
           FROM public.trade_executions
          WHERE user_id = $1 AND exchange = 'BINANCE' AND environment = 'DEMO'
            AND execution_status IN ('ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED', 'CLOSED')
          GROUP BY symbol`,
        [user_id],
      );

      // Also include active position symbols
      const symbolsToPoll = new Set<string>();
      for (const row of symbolsRes.rows) symbolsToPoll.add(row.symbol);
      for (const pos of activePositions) symbolsToPoll.add(pos.symbol);

      // 3. For each symbol, incrementally fetch userTrades, allOrders, and income
      for (const symbol of symbolsToPoll) {
        try {
          // Fetch trade fills (max 1000)
          const tradesRaw: unknown = await adapter.request('GET', '/fapi/v1/userTrades', {
            symbol,
            limit: '1000',
          });
          const parsedTrades = z.array(userTradeSchema).safeParse(tradesRaw);

          if (parsedTrades.success && parsedTrades.data.length > 0) {
            for (const trade of parsedTrades.data) {
              const tradeIdStr = String(trade.id);
              const orderIdStr = String(trade.orderId);
              const priceNum = Number(trade.price);
              const qtyNum = Number(trade.qty);
              const pnlNum = Number(trade.realizedPnl);
              const commNum = Number(trade.commission ?? 0);
              const tradeTime = new Date(trade.time).toISOString();

              // Insert fill into reconciliation cache table
              await query(
                `INSERT INTO public.binance_demo_reconciliation_records (
                   user_id, symbol, record_type, exchange_id, order_id, trade_time, amount, asset, raw_payload
                 ) VALUES ($1, $2, 'TRADE_FILL', $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (user_id, record_type, exchange_id) DO UPDATE
                   SET amount = EXCLUDED.amount, raw_payload = EXCLUDED.raw_payload`,
                [
                  user_id, symbol, tradeIdStr, orderIdStr, tradeTime, pnlNum,
                  trade.commissionAsset ?? 'USDT', JSON.stringify({
                    ...trade,
                    price: priceNum,
                    qty: qtyNum,
                    realizedPnl: pnlNum,
                    commission: commNum,
                  }),
                ],
              );
            }
          }

          // Fetch income records for this symbol: REALIZED_PNL, COMMISSION, FUNDING_FEE
          const incomeRaw: unknown = await adapter.request('GET', '/fapi/v1/income', {
            symbol,
            limit: '1000',
          });
          const parsedIncome = z.array(incomeRowSchema).safeParse(incomeRaw);

          if (parsedIncome.success && parsedIncome.data.length > 0) {
            for (const inc of parsedIncome.data) {
              const tranIdStr = String(inc.tranId);
              const incType = inc.incomeType; // e.g. REALIZED_PNL, COMMISSION, FUNDING_FEE
              const incAmount = Number(inc.income);
              const incTime = new Date(inc.time).toISOString();

              await query(
                `INSERT INTO public.binance_demo_reconciliation_records (
                   user_id, symbol, record_type, exchange_id, order_id, trade_time, amount, asset, raw_payload
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (user_id, record_type, exchange_id) DO UPDATE
                   SET amount = EXCLUDED.amount, raw_payload = EXCLUDED.raw_payload`,
                [
                  user_id, symbol, `INCOME_${incType}`, tranIdStr,
                  inc.tradeId ? String(inc.tradeId) : null, incTime,
                  incAmount, inc.asset, JSON.stringify(inc),
                ],
              );
            }
          }

          // Fetch orders history to discover closing orders
          try {
            const ordersRaw: unknown = await adapter.request('GET', '/fapi/v1/allOrders', {
              symbol,
              limit: '500',
            });
            const parsedOrders = z.array(orderSchema).safeParse(ordersRaw);
            if (parsedOrders.success) {
              for (const ord of parsedOrders.data) {
                if (ord.status === 'FILLED' || ord.status === 'CANCELED' || ord.status === 'EXPIRED') {
                  const ordIdStr = String(ord.orderId);
                  const ordTime = new Date(ord.time ?? ord.updateTime ?? Date.now()).toISOString();
                  await query(
                    `INSERT INTO public.binance_demo_reconciliation_records (
                       user_id, symbol, record_type, exchange_id, order_id, client_order_id, trade_time, raw_payload
                     ) VALUES ($1, $2, 'ORDER', $3, $4, $5, $6, $7)
                     ON CONFLICT (user_id, record_type, exchange_id) DO UPDATE
                       SET client_order_id = EXCLUDED.client_order_id, raw_payload = EXCLUDED.raw_payload`,
                    [user_id, symbol, ordIdStr, ordIdStr, ord.clientOrderId ?? null, ordTime, JSON.stringify(ord)],
                  );
                }
              }
            }
          } catch {}

        } catch (symErr) {
          console.warn(`Symbol ${symbol} sync warning:`, symErr instanceof Error ? symErr.message : String(symErr));
        }
      }

      // 4. Now perform exact trade-to-execution matching and financial calculation
      const execsToMatch = await query<{
        id: string;
        symbol: string;
        side: 'LONG' | 'SHORT';
        quantity: string;
        entry_price: string;
        actual_fill_price: string | null;
        binance_order_id: string | null;
        client_order_id: string;
        sl_order_id: string | null;
        tp_order_id: string | null;
        trailing_order_id: string | null;
        exit_order_id: string | null;
        sl_client_algo_id: string | null;
        tp_client_algo_id: string | null;
        trailing_client_algo_id: string | null;
        exit_client_order_id: string | null;
        tp1_price: string | null;
        tp2_price: string | null;
        tp3_price: string | null;
        created_at: string;
        closed_at: string | null;
        stop_loss: string | null;
        execution_status: string;
        commission_usdt: string | null;
      }>(
        `SELECT id::TEXT, symbol, side, quantity::TEXT, entry_price::TEXT, actual_fill_price::TEXT,
                binance_order_id, client_order_id, sl_order_id, tp_order_id, trailing_order_id,
                exit_order_id, sl_client_algo_id, tp_client_algo_id, trailing_client_algo_id,
                exit_client_order_id, tp1_price::TEXT, tp2_price::TEXT, tp3_price::TEXT,
                created_at::TEXT, closed_at::TEXT, stop_loss::TEXT, execution_status, commission_usdt::TEXT
           FROM public.trade_executions
          WHERE user_id = $1 AND exchange = 'BINANCE' AND environment = 'DEMO'
            AND execution_status IN ('ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED', 'CLOSED')
          ORDER BY id ASC`,
        [user_id],
      );

      for (const exec of execsToMatch.rows) {
        const execId = exec.id;
        const symbol = exec.symbol;
        const entrySide = exec.side === 'LONG' ? 'BUY' : 'SELL';
        const exitSide = exec.side === 'LONG' ? 'SELL' : 'BUY';

        // A. Match entry trade fills:
        const entryFills = await query<{ id: string; amount: string; raw_payload: Record<string, unknown> }>(
          `SELECT id::TEXT, amount::TEXT, raw_payload
             FROM public.binance_demo_reconciliation_records
            WHERE user_id = $1 AND symbol = $2 AND record_type = 'TRADE_FILL'
              AND (order_id = $3 OR (raw_payload->>'side' = $4 AND trade_time >= $5::TIMESTAMPTZ - INTERVAL '2 minutes' AND trade_time <= $5::TIMESTAMPTZ + INTERVAL '2 minutes'))
            ORDER BY trade_time ASC`,
          [user_id, symbol, exec.binance_order_id, entrySide, exec.created_at],
        );

        let entryCommission = 0;
        let resolvedEntryPrice = Number(exec.actual_fill_price) || Number(exec.entry_price);
        if (entryFills.rows.length > 0) {
          let sumQuote = 0;
          let sumQty = 0;
          for (const fill of entryFills.rows) {
            const p = fill.raw_payload;
            const price = Number(p.price);
            const qty = Number(p.qty);
            if (price > 0 && qty > 0) {
              sumQuote += price * qty;
              sumQty += qty;
            }
            if (p.commission) {
              entryCommission += Math.abs(Number(p.commission));
            }
            // Mark record as matched
            await query(
              `UPDATE public.binance_demo_reconciliation_records SET matched_execution_id = $1 WHERE id = $2`,
              [execId, fill.id],
            );
          }
          if (sumQty > 0 && sumQuote > 0) {
            resolvedEntryPrice = sumQuote / sumQty;
          }
        }

        // B. For closed trades: match exit fills and income
        let grossRealizedPnl = 0;
        let exitCommission = 0;
        let resolvedExitPrice: number | null = null;
        let determinedExitReason: string | null = null;

        if (exec.execution_status === 'CLOSED') {
          // Look for opposite side trade fills between entry time and close time + 5 minutes
          const exitFills = await query<{ id: string; order_id: string; raw_payload: Record<string, unknown> }>(
            `SELECT id::TEXT, order_id, raw_payload
               FROM public.binance_demo_reconciliation_records
              WHERE user_id = $1 AND symbol = $2 AND record_type = 'TRADE_FILL'
                AND raw_payload->>'side' = $3
                AND trade_time >= $4::TIMESTAMPTZ
                AND trade_time <= $5::TIMESTAMPTZ + INTERVAL '5 minutes'
              ORDER BY trade_time ASC`,
            [user_id, symbol, exitSide, exec.created_at, exec.closed_at ?? exec.created_at],
          );

          if (exitFills.rows.length > 0) {
            let sumExitQuote = 0;
            let sumExitQty = 0;
            for (const fill of exitFills.rows) {
              const p = fill.raw_payload;
              const price = Number(p.price);
              const qty = Number(p.qty);
              if (price > 0 && qty > 0) {
                sumExitQuote += price * qty;
                sumExitQty += qty;
              }
              if (p.commission) {
                exitCommission += Math.abs(Number(p.commission));
              }
              if (p.realizedPnl) {
                grossRealizedPnl += Number(p.realizedPnl);
              }
              // Mark record as matched
              await query(
                `UPDATE public.binance_demo_reconciliation_records SET matched_execution_id = $1 WHERE id = $2`,
                [execId, fill.id],
              );

              // Check if orderId matches any protection order
              const fOrderId = String(fill.order_id);
              if (exec.tp_order_id && fOrderId === exec.tp_order_id) {
                determinedExitReason = 'TAKE_PROFIT_3';
              } else if (exec.sl_order_id && fOrderId === exec.sl_order_id) {
                determinedExitReason = 'STOP_LOSS';
              } else if (exec.trailing_order_id && fOrderId === exec.trailing_order_id) {
                determinedExitReason = 'TRAILING_STOP';
              } else if (exec.exit_order_id && fOrderId === exec.exit_order_id) {
                determinedExitReason = 'MANUAL_CLOSE';
              }
            }
            if (sumExitQty > 0 && sumExitQuote > 0) {
              resolvedExitPrice = sumExitQuote / sumExitQty;
            }
          }

          // Also check matching income records (REALIZED_PNL, COMMISSION)
          const incomeRows = await query<{ id: string; record_type: string; amount: string; raw_payload: Record<string, unknown> }>(
            `SELECT id::TEXT, record_type, amount::TEXT, raw_payload
               FROM public.binance_demo_reconciliation_records
              WHERE user_id = $1 AND symbol = $2
                AND record_type IN ('INCOME_REALIZED_PNL', 'INCOME_COMMISSION')
                AND trade_time >= $3::TIMESTAMPTZ
                AND trade_time <= $4::TIMESTAMPTZ + INTERVAL '5 minutes'`,
            [user_id, symbol, exec.created_at, exec.closed_at ?? exec.created_at],
          );

          if (exitFills.rows.length === 0 && incomeRows.rows.length > 0) {
            // Use income table if trade fills were not found directly
            for (const inc of incomeRows.rows) {
              if (inc.record_type === 'INCOME_REALIZED_PNL') {
                grossRealizedPnl += Number(inc.amount);
              } else if (inc.record_type === 'INCOME_COMMISSION') {
                exitCommission += Math.abs(Number(inc.amount));
              }
              await query(
                `UPDATE public.binance_demo_reconciliation_records SET matched_execution_id = $1 WHERE id = $2`,
                [execId, inc.id],
              );
            }
          }

          // If exit fill price still not found, compute from realized P&L and entry price
          if (!resolvedExitPrice && grossRealizedPnl !== 0) {
            const qty = Number(exec.quantity);
            if (qty > 0) {
              resolvedExitPrice = exec.side === 'LONG'
                ? resolvedEntryPrice + (grossRealizedPnl / qty)
                : resolvedEntryPrice - (grossRealizedPnl / qty);
            }
          }

          // Fallback exit reason if not yet determined
          if (!determinedExitReason) {
            if (resolvedExitPrice) {
              const tp1 = Number(exec.tp1_price);
              const tp2 = Number(exec.tp2_price);
              const tp3 = Number(exec.tp3_price);
              const sl = Number(exec.stop_loss);
              if (exec.side === 'LONG') {
                if (tp3 && resolvedExitPrice >= tp3 * 0.999) determinedExitReason = 'TAKE_PROFIT_3';
                else if (tp2 && resolvedExitPrice >= tp2 * 0.999) determinedExitReason = 'TAKE_PROFIT_2';
                else if (tp1 && resolvedExitPrice >= tp1 * 0.999) determinedExitReason = 'TAKE_PROFIT_1';
                else if (sl && resolvedExitPrice <= sl * 1.001) determinedExitReason = 'STOP_LOSS';
                else determinedExitReason = 'TRAILING_STOP';
              } else {
                if (tp3 && resolvedExitPrice <= tp3 * 1.001) determinedExitReason = 'TAKE_PROFIT_3';
                else if (tp2 && resolvedExitPrice <= tp2 * 1.001) determinedExitReason = 'TAKE_PROFIT_2';
                else if (tp1 && resolvedExitPrice <= tp1 * 1.001) determinedExitReason = 'TAKE_PROFIT_1';
                else if (sl && resolvedExitPrice >= sl * 0.999) determinedExitReason = 'STOP_LOSS';
                else determinedExitReason = 'TRAILING_STOP';
              }
            } else {
              determinedExitReason = 'FLAT_POSITION';
            }
          }
        }

        // C. Match funding fees during the trade's active lifetime
        const fundingRows = await query<{ id: string; amount: string }>(
          `SELECT id::TEXT, amount::TEXT
             FROM public.binance_demo_reconciliation_records
            WHERE user_id = $1 AND symbol = $2 AND record_type = 'INCOME_FUNDING_FEE'
              AND trade_time >= $3::TIMESTAMPTZ
              AND trade_time <= $4::TIMESTAMPTZ + INTERVAL '5 minutes'`,
          [user_id, symbol, exec.created_at, exec.closed_at ?? new Date().toISOString()],
        );

        let signedFundingFee = 0;
        for (const f of fundingRows.rows) {
          signedFundingFee += Number(f.amount);
          await query(
            `UPDATE public.binance_demo_reconciliation_records SET matched_execution_id = $1 WHERE id = $2`,
            [execId, f.id],
          );
        }

        // Total commission: entry + exit commissions
        const totalCommission = (Number(exec.commission_usdt) || entryCommission) + exitCommission;

        // Net Realized P&L = Realized Trading P&L - Commissions + Signed Funding Income
        const netRealizedPnl = exec.execution_status === 'CLOSED'
          ? grossRealizedPnl - totalCommission + signedFundingFee
          : null;

        // Check if trade hit TP3 milestone
        let tp3ReachedAt = null;
        if (determinedExitReason === 'TAKE_PROFIT_3' || (exec.tp3_price && resolvedExitPrice && (exec.side === 'LONG' ? resolvedExitPrice >= Number(exec.tp3_price) : resolvedExitPrice <= Number(exec.tp3_price)))) {
          tp3ReachedAt = exec.closed_at ?? new Date().toISOString();
        }

        // Persist reconciled financials to public.trade_executions
        await query(
          `UPDATE public.trade_executions
              SET actual_fill_price = COALESCE(actual_fill_price, $2::NUMERIC),
                  exit_fill_price = CASE WHEN $3::NUMERIC IS NOT NULL THEN $3::NUMERIC ELSE exit_fill_price END,
                  realized_pnl = CASE WHEN $4::NUMERIC IS NOT NULL THEN $4::NUMERIC ELSE realized_pnl END,
                  commission_usdt = $5::NUMERIC,
                  funding_fee_usdt = $6::NUMERIC,
                  net_realized_pnl = CASE WHEN $7::NUMERIC IS NOT NULL THEN $7::NUMERIC ELSE net_realized_pnl END,
                  exit_reason = COALESCE($8::VARCHAR, exit_reason),
                  tp3_reached_at = COALESCE(tp3_reached_at, $9::TIMESTAMPTZ),
                  reconciliation_status = 'RECONCILED',
                  last_reconciled_at = NOW()
            WHERE id = $1`,
          [
            execId,
            resolvedEntryPrice.toFixed(8),
            resolvedExitPrice ? resolvedExitPrice.toFixed(8) : null,
            exec.execution_status === 'CLOSED' ? grossRealizedPnl.toFixed(8) : null,
            totalCommission.toFixed(8),
            signedFundingFee.toFixed(8),
            netRealizedPnl !== null ? netRealizedPnl.toFixed(8) : null,
            determinedExitReason,
            tp3ReachedAt,
          ],
        );

        totalReconciled++;
      }

      // Count unmatched trade fills
      const unmatchedRes = await query<{ count: string }>(
        `SELECT COUNT(*)::text as count
           FROM public.binance_demo_reconciliation_records
          WHERE user_id = $1 AND matched_execution_id IS NULL AND record_type = 'TRADE_FILL'`,
        [user_id],
      );
      totalUnmatched += Number(unmatchedRes.rows[0]?.count ?? 0);

      anyUserSucceeded = true;
    } catch (userErr) {
      const msg = userErr instanceof Error ? userErr.message : String(userErr);
      console.warn(`Reconciliation for user ${user_id} encountered an exchange error:`, msg);
      syncError = msg;
    }
  }

  // Update synchronization checkpoint
  const isStale = !anyUserSucceeded;
  const prevCheckpoint = await getSyncCheckpoint();
  const effectiveReconciled = anyUserSucceeded ? totalReconciled : prevCheckpoint.reconciledCount;
  const effectiveOpenPositions = anyUserSucceeded ? totalOpenPositions : prevCheckpoint.openPositionsCount;

  await saveSyncCheckpoint({
    syncedAt: anyUserSucceeded ? startedAt : (prevCheckpoint.syncedAt ?? startedAt),
    status: isStale ? 'STALE' : 'OK',
    reconciledCount: effectiveReconciled,
    openPositionsCount: effectiveOpenPositions,
    error: syncError,
  });

  return {
    ok: anyUserSucceeded,
    syncedAt: anyUserSucceeded ? startedAt : (prevCheckpoint.syncedAt ?? startedAt),
    reconciledCount: effectiveReconciled,
    openPositionsCount: effectiveOpenPositions,
    unmatchedCount: totalUnmatched,
    isStale,
    staleReason: isStale ? (syncError ?? 'Exchange communication failure') : undefined,
    error: syncError,
  };
}

/**
 * Returns unmatched exchange trades for admin reporting inspection.
 */
export async function getUnmatchedExchangeTrades(limit = 50): Promise<UnmatchedExchangeTrade[]> {
  try {
    const res = await query<{
      id: string;
      user_id: number;
      symbol: string;
      order_id: string;
      trade_time: string;
      raw_payload: Record<string, unknown>;
    }>(
      `SELECT id::TEXT, user_id, symbol, order_id, trade_time::TEXT, raw_payload
         FROM public.binance_demo_reconciliation_records
        WHERE matched_execution_id IS NULL AND record_type = 'TRADE_FILL'
        ORDER BY trade_time DESC
        LIMIT $1`,
      [limit],
    );

    return res.rows.map((row) => {
      const p = row.raw_payload;
      return {
        id: row.id,
        userId: row.user_id,
        symbol: row.symbol,
        orderId: row.order_id,
        side: (p.side === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
        price: Number(p.price ?? 0),
        qty: Number(p.qty ?? 0),
        realizedPnl: Number(p.realizedPnl ?? 0),
        commission: Number(p.commission ?? 0),
        commissionAsset: String(p.commissionAsset ?? 'USDT'),
        time: row.trade_time,
      };
    });
  } catch {
    return [];
  }
}
