import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BinanceFuturesError, createBinanceEnvironmentAdapter, getFuturesBalance, tradingExecutionGate, type TradingEnvironment } from './binance-futures';
import { query } from './db';
import { getFullPositionTakeProfit } from './binance-execution-policy';
import {
  buildCloseAllAlgoOrderParameters,
  cancelBinanceAlgoOrder,
  findUniqueOpenBinanceAlgoOrder,
  listOpenBinanceAlgoOrders,
  submitAndVerifyBinanceAlgoOrder,
  verifyBinanceAlgoOrder,
} from './binance-algo-orders';
import {
  assertTrailingActivationDirection,
  cancelProtectionAfterFlat,
  assertEmergencyStopInactive,
  buildTrailingStopOrderParameters,
  closePositionAndVerify,
  getTrailingActivationPrice,
  hasReachedTarget,
  type BinanceProtectionExchange,
} from './binance-protection-lifecycle';
import { assertSignalStrategy, strategyForSignal } from './strategy-routing';
import { assertStrategySchemaReady, getStrategyProfiles, requireExecutableStrategy, type StrategyProfile } from './strategy-management';
import {
  createCustomerExecutionLifecycle,
  type ExecutionLifecycleDependencies,
  type ExecutionScope,
  type LifecycleExecution,
} from './execution-lifecycle';

type Signal = {
  id: string;
  signal_key: string;
  scanner_type: 'STANDARD' | 'HIGH_RISK';
  symbol: string;
  side: 'LONG' | 'SHORT';
  entry_price: string;
  entry_zone_low: string;
  entry_zone_high: string;
  initial_stop: string;
  tp1: string;
  tp2: string;
  tp3: string | null;
  generated_at: string;
  expires_at: string;
  status: string;
  entry_status: string;
};

type SymbolInfo = {
  status: string;
  filters: Array<Record<string, string>>;
};

const exchangeInfoSchema = z.object({
  symbols: z.array(z.object({
    symbol: z.string(),
    status: z.string(),
    contractType: z.string(),
    quoteAsset: z.string(),
    filters: z.array(z.record(z.string(), z.union([z.string(), z.number()]).transform(String))),
  })),
});

function floorToStep(value: number, step: string): string {
  if (!Number.isFinite(value) || value <= 0 || !/^\d+(?:\.\d+)?$/.test(step)) throw new Error('Invalid trade quantity or exchange step size.');
  const places = Math.max(step.split('.')[1]?.length ?? 0, 0);
  const scale = 10 ** places;
  const scaledValue = BigInt(Math.floor(value * scale + Number.EPSILON));
  const scaledStep = BigInt(Math.round(Number(step) * scale));
  if (scaledStep <= 0n) throw new Error('Binance returned an invalid quantity step size.');
  const rounded = (scaledValue / scaledStep) * scaledStep;
  const integer = rounded / BigInt(scale);
  const fraction = String(rounded % BigInt(scale)).padStart(places, '0');
  return places ? `${integer}.${fraction}`.replace(/\.?0+$/, '') : String(integer);
}

function ceilToStep(value: number, step: string): string {
  if (!Number.isFinite(value) || value <= 0 || !/^\d+(?:\.\d+)?$/.test(step)) throw new Error('Invalid trade price or exchange tick size.');
  const places = Math.max(step.split('.')[1]?.length ?? 0, 0);
  const scale = 10 ** places;
  const scaledValue = BigInt(Math.ceil(value * scale - Number.EPSILON));
  const scaledStep = BigInt(Math.round(Number(step) * scale));
  if (scaledStep <= 0n) throw new Error('Binance returned an invalid price tick size.');
  const rounded = ((scaledValue + scaledStep - 1n) / scaledStep) * scaledStep;
  const integer = rounded / BigInt(scale);
  const fraction = String(rounded % BigInt(scale)).padStart(places, '0');
  return places ? `${integer}.${fraction}`.replace(/\.?0+$/, '') : String(integer);
}

function numericString(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new BinanceFuturesError('Binance returned an invalid order response.');
  }
  return value;
}

function createBinanceProtectionExchange(
  adapter: Awaited<ReturnType<typeof createBinanceEnvironmentAdapter>>,
): BinanceProtectionExchange {
  return {
    async getPosition(symbol) {
      const raw: unknown = await adapter.request('GET', '/fapi/v3/positionRisk', { symbol });
      const rows = z.array(z.object({
        symbol: z.string(),
        positionAmt: z.string().regex(/^-?\d+(?:\.\d+)?$/),
      })).parse(raw);
      return { symbol, amount: rows.find((row) => row.symbol === symbol)?.positionAmt ?? '0' };
    },
    async closePosition(input) {
      const raw: unknown = await adapter.request('POST', '/fapi/v1/order', {
        symbol: input.symbol,
        side: input.side,
        type: 'MARKET',
        quantity: input.quantity,
        reduceOnly: 'true',
        newClientOrderId: input.clientOrderId,
        newOrderRespType: 'RESULT',
      });
      return z.object({ status: z.string() }).parse(raw);
    },
    async getCloseOrder(symbol, clientOrderId) {
      const raw: unknown = await adapter.request('GET', '/fapi/v1/order', {
        symbol,
        origClientOrderId: clientOrderId,
      });
      return z.object({ status: z.string() }).parse(raw);
    },
    async getOpenProtectionOrders(symbol) {
      const orders = await listOpenBinanceAlgoOrders(adapter, symbol);
      return orders.map((order) => ({
        id: String(order.algoId),
        clientId: order.clientAlgoId,
      }));
    },
    async cancelProtectionOrder(symbol, order) {
      await cancelBinanceAlgoOrder(adapter, symbol, order.id);
    },
  };
}

function createCustomerBinanceLifecycle(
  adapter: Awaited<ReturnType<typeof createBinanceEnvironmentAdapter>>,
  scope: Extract<ExecutionScope, { kind: 'CUSTOMER' }>,
  mode: 'CONFIRM' | 'AUTOMATIC',
  clientIds: { stop: string; tp3: string; trailing: string },
  currentMarkPrice: string,
  onProtectionAttempt: (kind: 'STOP' | 'TP3' | 'TRAILING') => void,
  options: { preclaimedLockToken?: string } = {},
) {
  const protectionExchange = createBinanceProtectionExchange(adapter);
  let reconcileLockToken: string | null = null;
  const scopedWhere = `id = $1 AND user_id = $2 AND strategy = $3
    AND exchange = 'BINANCE' AND environment = $4`;
  const dependencies: ExecutionLifecycleDependencies = {
    authorization: {
      async assertAuthorized(candidate: ExecutionScope) {
        if (
          candidate.kind !== 'CUSTOMER' ||
          candidate.userId !== scope.userId ||
          candidate.strategy !== scope.strategy ||
          candidate.executionId !== scope.executionId ||
          candidate.environment !== scope.environment
        ) throw new BinanceFuturesError('Customer execution authorization is not valid for this lifecycle scope.', 403);
      },
    },
    environment: {
      async assertEnvironment(candidate: ExecutionScope) {
        const fixedEndpoint = candidate.environment === 'DEMO'
          ? 'https://demo-fapi.binance.com'
          : 'https://fapi.binance.com';
        if (
          candidate.kind !== 'CUSTOMER' ||
          candidate.environment !== scope.environment ||
          adapter.environment !== candidate.environment ||
          adapter.baseUrl !== fixedEndpoint
        ) throw new BinanceFuturesError('Exchange client environment does not match the authorized execution scope.', 403);
      },
    },
    exchange: {
      async installProtection(_candidate: ExecutionScope, execution: LifecycleExecution) {
        const side = execution.direction === 'LONG' ? 'SELL' : 'BUY';
        onProtectionAttempt('STOP');
        const stopAlgoId = await submitAndVerifyBinanceAlgoOrder(
          adapter,
          buildCloseAllAlgoOrderParameters({
            symbol: execution.symbol,
            side,
            type: 'STOP_MARKET',
            triggerPrice: execution.stopPrice,
            clientAlgoId: clientIds.stop,
          }),
        );
        onProtectionAttempt('TP3');
        const tp3AlgoId = await submitAndVerifyBinanceAlgoOrder(
          adapter,
          buildCloseAllAlgoOrderParameters({
            symbol: execution.symbol,
            side,
            type: 'TAKE_PROFIT_MARKET',
            triggerPrice: execution.tp3Price,
            clientAlgoId: clientIds.tp3,
          }),
        );
        const activatePrice = getTrailingActivationPrice(execution.direction, execution.tp1Price, execution.tickSize);
        assertTrailingActivationDirection(execution.direction, activatePrice, currentMarkPrice);
        onProtectionAttempt('TRAILING');
        const trailingAlgoId = await submitAndVerifyBinanceAlgoOrder(
          adapter,
          buildTrailingStopOrderParameters({
            symbol: execution.symbol,
            positionSide: execution.direction,
            quantity: execution.quantity,
            tp1: execution.tp1Price,
            tickSize: execution.tickSize,
            clientAlgoId: clientIds.trailing,
          }),
        );
        return { stopAlgoId, tp3AlgoId, trailingAlgoId };
      },
      async verifyProtection(_candidate: ExecutionScope, execution: LifecycleExecution, identifiers) {
        if (!clientIds.stop || !clientIds.tp3 || !clientIds.trailing) return false;
        const orders = await listOpenBinanceAlgoOrders(adapter, execution.symbol);
        const stop = findUniqueOpenBinanceAlgoOrder(orders, identifiers.stopAlgoId, clientIds.stop);
        const tp3 = findUniqueOpenBinanceAlgoOrder(orders, identifiers.tp3AlgoId, clientIds.tp3);
        const trailing = findUniqueOpenBinanceAlgoOrder(orders, identifiers.trailingAlgoId, clientIds.trailing);
        const side = execution.direction === 'LONG' ? 'SELL' : 'BUY';
        return Boolean(
          stop && tp3 && trailing &&
          verifyBinanceAlgoOrder(stop, buildCloseAllAlgoOrderParameters({
            symbol: execution.symbol, side, type: 'STOP_MARKET',
            triggerPrice: execution.stopPrice, clientAlgoId: clientIds.stop,
          })) === identifiers.stopAlgoId &&
          verifyBinanceAlgoOrder(tp3, buildCloseAllAlgoOrderParameters({
            symbol: execution.symbol, side, type: 'TAKE_PROFIT_MARKET',
            triggerPrice: execution.tp3Price, clientAlgoId: clientIds.tp3,
          })) === identifiers.tp3AlgoId &&
          verifyBinanceAlgoOrder(trailing, buildTrailingStopOrderParameters({
            symbol: execution.symbol, positionSide: execution.direction,
            quantity: execution.quantity, tp1: execution.tp1Price,
            tickSize: execution.tickSize, clientAlgoId: clientIds.trailing,
          })) === identifiers.trailingAlgoId
        );
      },
      getPosition(_candidate: ExecutionScope, symbol: string) {
        return protectionExchange.getPosition(symbol);
      },
      async closePositionAndVerify(candidate: ExecutionScope, execution: LifecycleExecution) {
        if (candidate.kind !== 'CUSTOMER') throw new BinanceFuturesError('Customer exchange adapter rejected a non-customer lifecycle scope.', 403);
        const clientOrderId = execution.closeClientOrderId ?? `ec${candidate.executionId}`.slice(0, 36);
        if (options.preclaimedLockToken) {
          await query(
            `UPDATE public.trade_executions
                SET exit_client_order_id = COALESCE(exit_client_order_id, $5), updated_at = NOW()
                WHERE ${scopedWhere} AND reconcile_lock_token = $6::UUID
              RETURNING id::TEXT`,
            [candidate.executionId, candidate.userId, candidate.strategy, candidate.environment, clientOrderId, options.preclaimedLockToken],
          ).then((result) => {
            if (!result.rows[0]) throw new BinanceFuturesError('Reconciliation lock was lost before position close.', 409);
          });
        }
        const result = await closePositionAndVerify(protectionExchange, {
          symbol: execution.symbol,
          positionSide: execution.direction,
          clientOrderId,
          reconcileExistingOrder: true,
        });
        return { closed: result.closed, ...('reason' in result ? { reason: result.reason } : {}) };
      },
      async cancelObsoleteProtection(_candidate: ExecutionScope, execution: LifecycleExecution, identifiers) {
        await cancelProtectionAfterFlat(protectionExchange, execution.symbol, [
          identifiers.stopAlgoId,
          identifiers.tp3AlgoId,
          identifiers.trailingAlgoId,
          clientIds.stop,
          clientIds.tp3,
          clientIds.trailing,
        ]);
      },
    },
    executions: {
      async assertScope(candidate: ExecutionScope) {
        if (candidate.kind !== 'CUSTOMER' || candidate.userId !== scope.userId) {
          throw new BinanceFuturesError('Customer execution record ownership does not match.', 403);
        }
        const result = await query(
          `SELECT 1 FROM public.trade_executions
            WHERE ${scopedWhere} AND execution_status IN ('ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED')
              AND ($5::UUID IS NULL OR reconcile_lock_token = $5::UUID)`,
          [candidate.executionId, candidate.userId, candidate.strategy, candidate.environment, options.preclaimedLockToken ?? null],
        );
        if (!result.rows[0]) throw new BinanceFuturesError('Execution record is not available in this user, strategy, and environment scope.', 404);
      },
      async markProtected(candidate: ExecutionScope, identifiers) {
        if (candidate.kind !== 'CUSTOMER') throw new BinanceFuturesError('Customer repository rejected a non-customer lifecycle scope.', 403);
        await updateExecution(candidate.executionId, candidate.userId, candidate.strategy, candidate.environment, 'PROTECTED', {
          slOrderId: identifiers.stopAlgoId,
          tpOrderId: identifiers.tp3AlgoId,
          trailingOrderId: identifiers.trailingAlgoId,
        }, reconcileLockToken ?? undefined);
      },
      async markClosed(candidate: ExecutionScope) {
        if (candidate.kind !== 'CUSTOMER') throw new BinanceFuturesError('Customer repository rejected a non-customer lifecycle scope.', 403);
        await updateExecution(candidate.executionId, candidate.userId, candidate.strategy, candidate.environment, 'CLOSED', {}, reconcileLockToken ?? undefined);
      },
      async markUncertain(candidate: ExecutionScope, reason: string) {
        if (candidate.kind !== 'CUSTOMER') throw new BinanceFuturesError('Customer repository rejected a non-customer lifecycle scope.', 403);
        await updateExecution(candidate.executionId, candidate.userId, candidate.strategy, candidate.environment, 'PROTECTION_FAILED', {
          error: reason,
        }, reconcileLockToken ?? undefined);
      },
    },
    protections: {
      async loadProtectionIdentifiers(candidate: ExecutionScope) {
        if (candidate.kind !== 'CUSTOMER') throw new BinanceFuturesError('Customer protection repository rejected a non-customer lifecycle scope.', 403);
        const result = await query<{
          sl_order_id: string | null;
          tp_order_id: string | null;
          trailing_order_id: string | null;
        }>(
          `SELECT sl_order_id, tp_order_id, trailing_order_id
             FROM public.trade_executions WHERE ${scopedWhere}`,
          [candidate.executionId, candidate.userId, candidate.strategy, candidate.environment],
        );
        const row = result.rows[0];
        return row?.sl_order_id && row.tp_order_id && row.trailing_order_id
          ? { stopAlgoId: row.sl_order_id, tp3AlgoId: row.tp_order_id, trailingAlgoId: row.trailing_order_id }
          : null;
      },
      async markProtectionVerified(candidate: ExecutionScope, identifiers, progress) {
        if (candidate.kind !== 'CUSTOMER') throw new BinanceFuturesError('Customer protection repository rejected a non-customer lifecycle scope.', 403);
        const result = await query(
          `UPDATE public.trade_executions
              SET sl_order_id = $5, tp_order_id = $6, trailing_order_id = $7,
                  protection_status = CASE WHEN $10 THEN 'TRAILING' ELSE 'PROTECTED' END,
                  tp1_reached_at = CASE WHEN $8 THEN COALESCE(tp1_reached_at, NOW()) ELSE tp1_reached_at END,
                  tp2_reached_at = CASE WHEN $9 THEN COALESCE(tp2_reached_at, NOW()) ELSE tp2_reached_at END,
                  last_reconciled_at = CASE WHEN $11::UUID IS NOT NULL THEN NOW() ELSE last_reconciled_at END,
                  updated_at = NOW()
            WHERE ${scopedWhere} AND execution_status IN ('ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED')
              AND ($11::UUID IS NULL OR reconcile_lock_token = $11::UUID)
            RETURNING id::TEXT`,
          [
            candidate.executionId, candidate.userId, candidate.strategy, candidate.environment,
            identifiers.stopAlgoId, identifiers.tp3AlgoId, identifiers.trailingAlgoId,
            progress.tp1Reached, progress.tp2Reached, progress.trailingActivated, options.preclaimedLockToken ?? null,
          ],
        );
        if (!result.rows[0]) throw new BinanceFuturesError('Protection repository scope changed before verification was persisted.', 409);
      },
      async markProtectionFailed(candidate: ExecutionScope, reason: string) {
        if (candidate.kind !== 'CUSTOMER') throw new BinanceFuturesError('Customer protection repository rejected a non-customer lifecycle scope.', 403);
        const result = await query(
          `UPDATE public.trade_executions SET protection_status = 'FAILED',
                  error_message = $5,
                  last_reconciled_at = CASE WHEN $6::UUID IS NOT NULL THEN NOW() ELSE last_reconciled_at END,
                  updated_at = NOW()
            WHERE ${scopedWhere} AND ($6::UUID IS NULL OR reconcile_lock_token = $6::UUID) RETURNING id::TEXT`,
          [candidate.executionId, candidate.userId, candidate.strategy, candidate.environment, reason.slice(0, 1000), options.preclaimedLockToken ?? null],
        );
        if (!result.rows[0]) throw new BinanceFuturesError('Protection repository scope changed before failure was persisted.', 409);
      },
    },
    reconciliation: {
      async claim(candidate: ExecutionScope) {
        if (candidate.kind !== 'CUSTOMER') return false;
        if (options.preclaimedLockToken) {
          reconcileLockToken = options.preclaimedLockToken;
          return true;
        }
        const token = randomUUID();
        const result = await query(
          `UPDATE public.trade_executions
              SET reconcile_lock_until = NOW() + INTERVAL '75 seconds', reconcile_lock_token = $5::UUID
            WHERE ${scopedWhere}
              AND (reconcile_lock_until IS NULL OR reconcile_lock_until < NOW())
            RETURNING id::TEXT`,
          [candidate.executionId, candidate.userId, candidate.strategy, candidate.environment, token],
        );
        if (!result.rows[0]) return false;
        reconcileLockToken = token;
        return true;
      },
      async release(candidate: ExecutionScope) {
        if (candidate.kind !== 'CUSTOMER' || !reconcileLockToken) return;
        if (options.preclaimedLockToken) return;
        await query(
          `UPDATE public.trade_executions SET reconcile_lock_until = NULL, reconcile_lock_token = NULL
            WHERE ${scopedWhere} AND reconcile_lock_token = $5::UUID`,
          [candidate.executionId, candidate.userId, candidate.strategy, candidate.environment, reconcileLockToken],
        );
        reconcileLockToken = null;
      },
    },
    events: {
      async publish(event: { type: string; scope: ExecutionScope }) {
        console.info('SmartExit lifecycle event', {
          event: event.type,
          actor: event.scope.kind,
          environment: event.scope.environment,
        });
      },
    },
  };
  return createCustomerExecutionLifecycle(dependencies, {
    async assertCustomerAuthorization(candidate) {
      if (
        candidate.userId !== scope.userId ||
        candidate.strategy !== scope.strategy ||
        candidate.environment !== scope.environment ||
        candidate.executionId !== scope.executionId
      ) throw new BinanceFuturesError('Execution request scope changed.', 403);
      if (!options.preclaimedLockToken && !tradingExecutionGate(candidate.environment)) {
        throw new BinanceFuturesError('Customer execution is locked for this environment.', 403);
      }
      if (!options.preclaimedLockToken) {
        await assertEmergencyStopClear(candidate.userId, candidate.environment);
        await requireExecutableStrategy(candidate.userId, candidate.strategy, 'BINANCE', candidate.environment, mode);
      }
    },
    async assertCustomerReconciliation(candidate) {
      if (
        candidate.userId !== scope.userId ||
        candidate.strategy !== scope.strategy ||
        candidate.environment !== scope.environment ||
        candidate.executionId !== scope.executionId
      ) throw new BinanceFuturesError('Reconciliation request scope changed.', 403);
    },
  });
}

async function getSignal(signalId: string): Promise<Signal> {
  const result = await query<Signal>(
    `SELECT id::TEXT, signal_key, scanner_type, symbol, side, entry_price::TEXT, initial_stop::TEXT,
            entry_zone_low::TEXT, entry_zone_high::TEXT, tp1::TEXT, tp2::TEXT, tp3::TEXT,
            generated_at, expires_at, status, entry_status
       FROM public.market_signals WHERE id = $1`,
    [signalId],
  );
  const signal = result.rows[0];
  if (!signal) throw new BinanceFuturesError('Signal not found.', 404);
  if (signal.status !== 'ACTIVE' || signal.entry_status !== 'OPEN' || Date.parse(signal.expires_at) <= Date.now()) {
    throw new BinanceFuturesError('This signal is no longer active and cannot be executed.', 409);
  }
  if (Date.now() - Date.parse(signal.generated_at) > 5 * 60_000) {
    throw new BinanceFuturesError('This signal is too old for a new Futures order.', 409);
  }
  const entry = Number(signal.entry_price);
  const stop = Number(signal.initial_stop);
  const targets = [signal.tp1, signal.tp2, signal.tp3].map(Number);
  if (
    !/^[A-Z0-9]{2,30}$/.test(signal.symbol) ||
    ![entry, stop, ...targets].every((price) => Number.isFinite(price) && price > 0) ||
    (signal.side === 'LONG'
      ? !(stop < entry && entry < targets[0] && targets[0] < targets[1] && targets[1] < targets[2])
      : !(targets[0] > targets[1] && targets[1] > targets[2] && targets[2] < entry && entry < stop))
  ) throw new BinanceFuturesError('Signal prices are invalid for the selected direction.', 422);
  return signal;
}

type BinanceAdapter = Awaited<ReturnType<typeof createBinanceEnvironmentAdapter>>;

async function getSymbolInfo(adapter: BinanceAdapter, symbol: string): Promise<SymbolInfo> {
  const raw: unknown = await adapter.publicRequest('/fapi/v1/exchangeInfo');
  const parsed = exchangeInfoSchema.safeParse(raw);
  if (!parsed.success) throw new BinanceFuturesError('Binance returned invalid symbol filters.');
  const item = parsed.data.symbols.find((row) =>
    row.symbol === symbol && row.status === 'TRADING' && row.contractType === 'PERPETUAL' && row.quoteAsset === 'USDT',
  );
  if (!item) throw new BinanceFuturesError('This signal pair is not an active USDT perpetual contract.', 422);
  return item;
}

async function getMarkPrice(adapter: BinanceAdapter, symbol: string): Promise<number> {
  const raw: unknown = await adapter.publicRequest(`/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`);
  const parsed = z.object({ markPrice: z.string().regex(/^\d+(?:\.\d+)?$/) }).safeParse(raw);
  const markPrice = parsed.success ? Number(parsed.data.markPrice) : NaN;
  if (!Number.isFinite(markPrice) || markPrice <= 0) throw new BinanceFuturesError('Binance returned an invalid mark price.');
  return markPrice;
}

function filterValue(info: SymbolInfo, type: string, key: string): string | undefined {
  return info.filters.find((filter) => filter.filterType === type)?.[key];
}

async function assertStrategyRiskLimits(
  adapter: BinanceAdapter,
  profile: StrategyProfile,
  equity: number,
) {
  if (!Number.isFinite(equity) || equity <= 0) {
    throw new BinanceFuturesError('Binance returned an invalid account equity for strategy risk checks.', 503);
  }
  if (profile.max_open_positions === null || profile.max_daily_loss_percent === null) {
    throw new BinanceFuturesError('Configure both strategy position and daily-loss limits before execution.', 409);
  }
  const positionsRaw: unknown = await adapter.request('GET', '/fapi/v3/positionRisk');
  const positions = z.array(z.object({
    symbol: z.string(),
    positionAmt: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  })).safeParse(positionsRaw);
  if (!positions.success) throw new BinanceFuturesError('Binance returned invalid account position data.');
  const openPositionCount = positions.data.filter((position) => Number(position.positionAmt) !== 0).length;
  if (openPositionCount >= profile.max_open_positions) {
    throw new BinanceFuturesError('The account has reached this strategy’s maximum concurrent position limit.', 409);
  }

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const incomeRaw: unknown = await adapter.request('GET', '/fapi/v1/income', {
    startTime: String(startOfDay.getTime()),
    limit: '1000',
  });
  const income = z.array(z.object({
    incomeType: z.string(),
    income: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  })).safeParse(incomeRaw);
  if (!income.success || income.data.length >= 1000) {
    throw new BinanceFuturesError('Binance daily income history is incomplete; execution is blocked until the daily-loss limit can be verified.', 503);
  }
  const netRealized = income.data
    .filter((entry) => ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE'].includes(entry.incomeType))
    .reduce((total, entry) => total + Number(entry.income), 0);
  const dailyLossLimit = equity * Number(profile.max_daily_loss_percent) / 100;
  if (!Number.isFinite(netRealized) || netRealized <= -dailyLossLimit) {
    throw new BinanceFuturesError('The strategy maximum daily loss has been reached.', 409);
  }
}

async function computeOrder(
  signal: Signal,
  userId: number,
  environment: TradingEnvironment,
  profile: StrategyProfile,
) {
  if (profile.exchange !== 'BINANCE') {
    throw new BinanceFuturesError('This exchange is not connected to the customer execution engine.', 403);
  }
  const [balance, adapter] = await Promise.all([
    getFuturesBalance(userId, environment),
    createBinanceEnvironmentAdapter(userId, environment),
  ]);
  if (profile.environment !== environment) {
    throw new BinanceFuturesError('The strategy environment changed. Select the configured environment before continuing.', 409);
  }
  await assertStrategyRiskLimits(adapter, profile, Number(balance.walletBalance));
  const [info, markPrice] = await Promise.all([
    getSymbolInfo(adapter, signal.symbol),
    getMarkPrice(adapter, signal.symbol),
  ]);
  if (markPrice < Number(signal.entry_zone_low) || markPrice > Number(signal.entry_zone_high)) {
    throw new BinanceFuturesError("Current Binance mark price is outside this signal's valid entry zone.", 409);
  }
  if (hasReachedTarget(signal.side, markPrice.toString(), signal.tp1)) {
    throw new BinanceFuturesError('TP1 has already been reached; a new position cannot safely arm its trailing stop.', 409);
  }
  const lotType = info.filters.find((filter) => filter.filterType === 'MARKET_LOT_SIZE' && Number(filter.stepSize) > 0)
    ? 'MARKET_LOT_SIZE'
    : 'LOT_SIZE';
  const step = filterValue(info, lotType, 'stepSize');
  const minQty = Number(filterValue(info, lotType, 'minQty'));
  const maxQty = Number(filterValue(info, lotType, 'maxQty'));
  const tick = filterValue(info, 'PRICE_FILTER', 'tickSize');
  const minNotional = Number(
    filterValue(info, 'MIN_NOTIONAL', 'notional') ??
    filterValue(info, 'MIN_NOTIONAL', 'minNotional') ??
    filterValue(info, 'NOTIONAL', 'minNotional') ?? '0',
  );
  if (!step || !tick || !Number.isFinite(minQty) || !Number.isFinite(maxQty)) {
    throw new BinanceFuturesError('Binance returned incomplete symbol trading filters.');
  }

  const leverageData: unknown = await adapter.request('GET', '/fapi/v1/leverageBracket', { symbol: signal.symbol });
  const brackets = z.array(z.object({
    symbol: z.string(),
    brackets: z.array(z.object({ initialLeverage: z.number().int().positive() })),
  })).safeParse(leverageData);
  if (!brackets.success) throw new BinanceFuturesError('Binance returned invalid leverage limits.');
  const maxLeverage = Math.max(...(brackets.data.find((item) => item.symbol === signal.symbol)?.brackets.map((item) => item.initialLeverage) ?? []));
  if (!maxLeverage || profile.leverage > maxLeverage) {
    throw new BinanceFuturesError(`Selected leverage exceeds this pair's Binance limit (${maxLeverage || 'unavailable'}x).`, 422);
  }

  const entry = Number(signal.entry_price);
  const stop = Number(signal.initial_stop);
  const equity = Number(balance.walletBalance);
  const available = Number(balance.availableBalance);
  const riskAmount = equity * Number(profile.risk_percentage) / 100;
  const notional = profile.order_size_mode === 'RISK_BASED'
    ? riskAmount / Math.abs(entry - stop) * entry
    : Number(profile.fixed_notional_usdt);
  const rawQuantity = profile.order_size_mode === 'RISK_BASED'
    ? riskAmount / Math.abs(entry - stop)
    : notional / entry;
  const quantity = floorToStep(rawQuantity, step);
  const numericQuantity = Number(quantity);
  const roundedNotional = numericQuantity * entry;
  if (numericQuantity < minQty || numericQuantity > maxQty || roundedNotional < minNotional) {
    throw new BinanceFuturesError('Calculated order does not meet Binance quantity or notional limits.', 422);
  }
  if (!Number.isFinite(available) || roundedNotional / profile.leverage > available) {
    throw new BinanceFuturesError('Available Futures balance is insufficient for this order and leverage.', 422);
  }

  const stopPrice = signal.side === 'LONG' ? ceilToStep(stop, tick) : floorToStep(stop, tick);
  const fullPositionTarget = Number(getFullPositionTakeProfit(signal));
  const targetPrice = signal.side === 'LONG' ? floorToStep(fullPositionTarget, tick) : ceilToStep(fullPositionTarget, tick);
  if (
    signal.side === 'LONG'
      ? !(Number(stopPrice) < markPrice && markPrice < Number(targetPrice))
      : !(Number(targetPrice) < markPrice && markPrice < Number(stopPrice))
  ) {
    throw new BinanceFuturesError('Rounded stop and take-profit triggers must remain on the correct side of the current mark price.', 422);
  }
  return {
    settings: profile,
    info,
    adapter,
    quantity,
    notionalUsdt: roundedNotional.toFixed(8),
    leverage: profile.leverage,
    markPrice: markPrice.toString(),
    stopPrice,
    targetPrice,
  };
}

async function updateExecution(
  id: string,
  userId: number,
  strategy: 'STANDARD' | 'HIGH_RISK_SCALPING',
  environment: TradingEnvironment,
  status: string,
  fields: {
  fillPrice?: string;
  orderId?: string;
  tpOrderId?: string;
  slOrderId?: string;
  trailingOrderId?: string;
  error?: string;
},
  reconcileLockToken?: string,
) {
  const result = await query<{ id: string }>(
    `UPDATE public.trade_executions
        SET execution_status = $2,
            actual_fill_price = COALESCE($3::NUMERIC, actual_fill_price),
            binance_order_id = COALESCE($4, binance_order_id),
            tp_order_id = COALESCE($5, tp_order_id),
            sl_order_id = COALESCE($6, sl_order_id),
            trailing_order_id = COALESCE($7, trailing_order_id),
            protection_status = CASE
              WHEN $2 = 'PROTECTED' THEN 'PROTECTED'
              WHEN $2 = 'PROTECTION_FAILED' THEN 'FAILED'
              WHEN $2 = 'CLOSED' THEN 'CLOSED'
              ELSE protection_status
            END,
            closed_at = CASE WHEN $2 = 'CLOSED' THEN COALESCE(closed_at, NOW()) ELSE closed_at END,
            last_reconciled_at = CASE WHEN $12::UUID IS NOT NULL THEN NOW() ELSE last_reconciled_at END,
            error_message = $8, updated_at = NOW()
      WHERE id = $1 AND user_id = $9 AND strategy = $10 AND exchange = 'BINANCE' AND environment = $11
        AND ($12::UUID IS NULL OR reconcile_lock_token = $12::UUID)
      RETURNING id::TEXT`,
    [
      id, status, fields.fillPrice ?? null, fields.orderId ?? null, fields.tpOrderId ?? null,
      fields.slOrderId ?? null, fields.trailingOrderId ?? null, fields.error ?? null,
      userId, strategy, environment, reconcileLockToken ?? null,
    ],
  );
  if (!result.rows[0]) throw new BinanceFuturesError('Execution record scope changed; lifecycle update was not applied.', 409);
}

async function assertEmergencyStopClear(userId: number, environment: TradingEnvironment) {
  const result = await query<{ stopped: boolean }>(
    `SELECT CASE WHEN $2 = 'DEMO' THEN demo_kill_switch_enabled ELSE live_kill_switch_enabled END AS stopped
       FROM public.user_trading_settings WHERE user_id = $1`,
    [userId, environment],
  );
  if (result.rows[0]?.stopped) {
    try {
      assertEmergencyStopInactive(result.rows[0].stopped, environment);
    } catch (error) {
      throw new BinanceFuturesError(
        `${error instanceof Error ? error.message : 'Emergency stop is active.'} Existing exchange protection is left untouched.`,
        409,
      );
    }
  }
}

export async function previewSignalOrder(userId: number, signalId: string, environment: TradingEnvironment) {
  const signal = await getSignal(signalId);
  const strategy = strategyForSignal(signal.scanner_type);
  const profiles = await getStrategyProfiles(userId);
  const profile = profiles.find((row) => row.strategy === strategy);
  if (!profile) throw new BinanceFuturesError(`${strategy} profile is not configured.`, 409);
  assertSignalStrategy(signal.scanner_type, profile.strategy);
  if (profile.exchange !== 'BINANCE' || profile.environment !== environment) {
    throw new BinanceFuturesError('The selected exchange and environment must match this signal’s strategy profile.', 409);
  }
  const prepared = await computeOrder(signal, userId, environment, profile);
  const executionMode = profile.execution_mode;
  return {
    strategy,
    exchange: profile.exchange,
    environment,
    symbol: signal.symbol,
    side: signal.side,
    referenceEntryPrice: signal.entry_price,
    currentMarkPrice: prepared.markPrice,
    quantity: prepared.quantity,
    notionalUsdt: prepared.notionalUsdt,
    leverage: prepared.leverage,
    stopLoss: prepared.stopPrice,
    takeProfit: prepared.targetPrice,
    executionMode,
    protectionPolicy: 'Initial Stop Loss; TP1/TP2 retain full size; TP3 is the full-position close.',
    canExecute: false,
    executionBlockReason: strategy === 'HIGH_RISK_SCALPING'
      ? 'High-Risk customer execution is not implemented.'
      : 'Customer execution is blocked until exchange-side TP1/TP2 trailing protection is implemented and verified.',
  };
}

type ExecutionConfirmation = {
  environment: TradingEnvironment;
  referenceEntryPrice: string;
  currentMarkPrice: string;
  quantity: string;
  notionalUsdt: string;
  leverage: number;
  stopLoss: string;
  takeProfit: string;
};

export async function executeSignal(
  userId: number,
  signalId: string,
  environment: TradingEnvironment,
  mode: 'CONFIRM' | 'AUTOMATIC',
  confirmation?: ExecutionConfirmation,
) {
  if (!tradingExecutionGate(environment)) throw new BinanceFuturesError('Order placement is locked until this environment is verified and explicitly authorized by the deployment operator.', 403);
  await assertEmergencyStopClear(userId, environment);
  const signal = await getSignal(signalId);
  const strategy = strategyForSignal(signal.scanner_type);
  assertSignalStrategy(signal.scanner_type, strategy);
  const profile = await requireExecutableStrategy(userId, strategy, 'BINANCE', environment, mode);
  const prepared = await computeOrder(signal, userId, environment, profile);
  if (mode === 'CONFIRM' && (
    !confirmation ||
    confirmation.environment !== environment ||
    confirmation.referenceEntryPrice !== signal.entry_price ||
    confirmation.currentMarkPrice !== prepared.markPrice ||
    confirmation.quantity !== prepared.quantity ||
    confirmation.notionalUsdt !== prepared.notionalUsdt ||
    confirmation.leverage !== prepared.leverage ||
    confirmation.stopLoss !== prepared.stopPrice ||
    confirmation.takeProfit !== prepared.targetPrice
  )) {
    throw new BinanceFuturesError('The order preview changed. Review a new preview before confirming.', 409);
  }
  const clientOrderId = `${environment === 'DEMO' ? 'ed' : 'el'}${randomUUID().replaceAll('-', '')}`.slice(0, 36);
  const stopClientAlgoId = `ehs${randomUUID().replaceAll('-', '')}`.slice(0, 36);
  const targetClientAlgoId = `eht${randomUUID().replaceAll('-', '')}`.slice(0, 36);
  const trailingClientAlgoId = `etr${randomUUID().replaceAll('-', '')}`.slice(0, 36);
  const inserted = await query<{ id: string }>(
    `INSERT INTO public.trade_executions (
       user_id, signal_id, exchange, environment, strategy, symbol, side, entry_price, quantity, notional_usdt,
       leverage, stop_loss, take_profit, tp1_price, tp2_price, tp3_price, trailing_percent,
       protection_status, client_order_id, sl_client_algo_id, tp_client_algo_id,
       trailing_client_algo_id, execution_status, execution_mode, user_confirmed_at
     ) VALUES ($1, $2, 'BINANCE', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1,
               'PENDING', $16, $17, $18, $19, 'EXECUTING', $20,
               CASE WHEN $20 = 'CONFIRM' THEN NOW() ELSE NULL END)
     ON CONFLICT (user_id, signal_id, exchange, environment) DO NOTHING
     RETURNING id::TEXT`,
    [
      userId, signal.id, environment, strategy, signal.symbol, signal.side, signal.entry_price, prepared.quantity,
      prepared.notionalUsdt, prepared.leverage, prepared.stopPrice, prepared.targetPrice,
      signal.tp1, signal.tp2, signal.tp3, clientOrderId, stopClientAlgoId, targetClientAlgoId,
      trailingClientAlgoId, mode,
    ],
  );
  const executionId = inserted.rows[0]?.id;
  if (!executionId) throw new BinanceFuturesError('This signal already has an execution record and cannot be submitted again.', 409);

  const adapter = prepared.adapter;
  const entrySide = signal.side === 'LONG' ? 'BUY' : 'SELL';
  let orderId: string | undefined;
  let filledQuantity = 0;
  let stopOrderId: string | undefined;
  let targetOrderId: string | undefined;
  let trailingOrderId: string | undefined;
  let stopOrderAttempted = false;
  let targetOrderAttempted = false;
  let trailingOrderAttempted = false;
  try {
    const positionMode = await adapter.request<unknown>('GET', '/fapi/v1/positionSide/dual');
    if (z.object({ dualSidePosition: z.boolean() }).parse(positionMode).dualSidePosition) {
      throw new BinanceFuturesError('Hedge Mode is not supported. Switch Binance Futures to One-Way Mode before trading.', 422);
    }

    const positions = await adapter.request<unknown>('GET', '/fapi/v3/positionRisk', { symbol: signal.symbol });
    const positionRows = z.array(z.object({ symbol: z.string(), positionAmt: z.string() })).parse(positions);
    if (positionRows.some((position) => position.symbol === signal.symbol && Number(position.positionAmt) !== 0)) {
      throw new BinanceFuturesError('An open position already exists for this pair.', 409);
    }
    const openOrders = await adapter.request<unknown>('GET', '/fapi/v1/openOrders', { symbol: signal.symbol });
    if (!Array.isArray(openOrders) || openOrders.length > 0) {
      throw new BinanceFuturesError('Existing open orders must be reviewed before trading this pair.', 409);
    }
    const openAlgoOrders = await adapter.request<unknown>('GET', '/fapi/v1/openAlgoOrders', { symbol: signal.symbol });
    if (!Array.isArray(openAlgoOrders) || openAlgoOrders.length > 0) {
      throw new BinanceFuturesError('Existing conditional orders must be reviewed before trading this pair.', 409);
    }

    const leverage = await adapter.request<unknown>(
      'POST', '/fapi/v1/leverage', { symbol: signal.symbol, leverage: String(prepared.leverage) },
    );
    if (z.object({ leverage: z.number().int().positive() }).parse(leverage).leverage !== prepared.leverage) {
      throw new BinanceFuturesError('Binance did not confirm the requested leverage.');
    }

    const [currentSignal, currentProfile] = await Promise.all([
      getSignal(signalId),
      requireExecutableStrategy(userId, strategy, 'BINANCE', environment, mode),
    ]);
    if (
      currentSignal.signal_key !== signal.signal_key ||
      new Date(currentProfile.updated_at).getTime() !== new Date(profile.updated_at).getTime()
    ) {
      throw new BinanceFuturesError('Signal or trading authorization changed before order placement. No order was submitted.', 409);
    }
    await assertStrategyRiskLimits(adapter, currentProfile, Number((await getFuturesBalance(userId, environment)).walletBalance));

    let order: unknown;
    try {
      order = await adapter.request(
        'POST', '/fapi/v1/order',
        {
          symbol: signal.symbol,
          side: entrySide,
          type: 'MARKET',
          quantity: prepared.quantity,
          newClientOrderId: clientOrderId,
          newOrderRespType: 'RESULT',
        },
      );
    } catch (orderError) {
      try {
        order = await adapter.request(
          'GET', '/fapi/v1/order',
          { symbol: signal.symbol, origClientOrderId: clientOrderId },
        );
      } catch {
        await updateExecution(executionId, userId, strategy, environment, 'PROTECTION_FAILED', {
          error: 'Entry order outcome is unknown. The system did not retry; check Binance order history before taking action.',
        });
        return { id: executionId, status: 'PROTECTION_FAILED' as const };
      }
      if (!order) throw orderError;
    }
    const orderSchema = z.object({
      orderId: z.union([z.number(), z.string()]),
      status: z.string(),
      executedQty: z.string(),
      avgPrice: z.string().optional(),
      cumQuote: z.string().optional(),
    });
    let filledOrder = orderSchema.safeParse(order);
    if (!filledOrder.success) {
      try {
        const reconciled: unknown = await adapter.request(
          'GET', '/fapi/v1/order',
          { symbol: signal.symbol, origClientOrderId: clientOrderId },
        );
        filledOrder = orderSchema.safeParse(reconciled);
      } catch {
        await updateExecution(executionId, userId, strategy, environment, 'PROTECTION_FAILED', {
          error: 'Binance accepted or returned an unrecognized entry response. The system did not retry; reconcile by client order ID before taking action.',
        });
        return { id: executionId, status: 'PROTECTION_FAILED' as const };
      }
    }
    if (!filledOrder.success) {
      await updateExecution(executionId, userId, strategy, environment, 'PROTECTION_FAILED', {
        error: 'Entry order response could not be reconciled. The system did not retry; check Binance order history using the recorded client order ID.',
      });
      return { id: executionId, status: 'PROTECTION_FAILED' as const };
    }
    const orderDetails = filledOrder.data;
    filledQuantity = Number(numericString(orderDetails.executedQty));
    if (orderDetails.status !== 'FILLED' || filledQuantity <= 0) {
      if (['NEW', 'PARTIALLY_FILLED'].includes(orderDetails.status)) {
        try {
          const cancelled: unknown = await adapter.request(
            'DELETE', '/fapi/v1/order',
            { symbol: signal.symbol, orderId: String(orderDetails.orderId) },
          );
          if (z.object({ status: z.string() }).parse(cancelled).status !== 'CANCELED') {
            await updateExecution(executionId, userId, strategy, environment, 'PROTECTION_FAILED', {
              orderId: String(orderDetails.orderId),
              error: `Entry order remains in an unconfirmed state (${orderDetails.status}); check Binance immediately.`,
            });
            return { id: executionId, status: 'PROTECTION_FAILED' as const };
          }
        } catch (cancelError) {
          await updateExecution(executionId, userId, strategy, environment, 'PROTECTION_FAILED', {
            orderId: String(orderDetails.orderId),
            error: `Could not confirm cancellation of the unfilled entry quantity: ${cancelError instanceof Error ? cancelError.message : 'Binance cancellation failed.'}`,
          });
          return { id: executionId, status: 'PROTECTION_FAILED' as const };
        }
      }
      if (filledQuantity > 0) {
        const partialFillPrice = orderDetails.avgPrice && Number(orderDetails.avgPrice) > 0
          ? numericString(orderDetails.avgPrice)
          : (Number(orderDetails.cumQuote ?? 0) / filledQuantity).toString();
        orderId = String(orderDetails.orderId);
        await updateExecution(executionId, userId, strategy, environment, 'ENTRY_FILLED', {
          fillPrice: partialFillPrice,
          orderId,
        });
        throw new BinanceFuturesError(`Entry order was only partially filled (${orderDetails.status}); the partial position will be closed.`, 502);
      }
      await updateExecution(executionId, userId, strategy, environment, 'FAILED', {
        orderId: String(orderDetails.orderId),
        error: `Entry order was not fully filled (status: ${orderDetails.status}).`,
      });
      return { id: executionId, status: 'FAILED' as const };
    }
    const fillPrice = orderDetails.avgPrice && Number(orderDetails.avgPrice) > 0
      ? numericString(orderDetails.avgPrice)
      : (Number(orderDetails.cumQuote ?? 0) / filledQuantity).toString();
    orderId = String(orderDetails.orderId);
    await updateExecution(executionId, userId, strategy, environment, 'ENTRY_FILLED', { fillPrice, orderId });

    const tickSize = filterValue(prepared.info, 'PRICE_FILTER', 'tickSize');
    if (!tickSize) throw new BinanceFuturesError('Binance returned no price tick for the trailing activation level.');
    const lifecycleScope: Extract<ExecutionScope, { kind: 'CUSTOMER' }> = {
      kind: 'CUSTOMER',
      userId,
      strategy,
      environment,
      executionId,
    };
    const lifecycle = createCustomerBinanceLifecycle(
      adapter,
      lifecycleScope,
      mode,
      { stop: stopClientAlgoId, tp3: targetClientAlgoId, trailing: trailingClientAlgoId },
      prepared.markPrice,
      (kind) => {
        if (kind === 'STOP') stopOrderAttempted = true;
        if (kind === 'TP3') targetOrderAttempted = true;
        if (kind === 'TRAILING') trailingOrderAttempted = true;
      },
    );
    const protection = await lifecycle.protectOpenedPosition(lifecycleScope, {
      symbol: signal.symbol,
      direction: signal.side,
      quantity: numericString(orderDetails.executedQty),
      stopPrice: prepared.stopPrice,
      tp2Price: signal.tp2,
      tp3Price: prepared.targetPrice,
      tp1Price: signal.tp1,
      tickSize,
    });
    stopOrderId = protection.stopAlgoId;
    targetOrderId = protection.tp3AlgoId;
    trailingOrderId = protection.trailingAlgoId;
    return { id: executionId, status: 'PROTECTED' as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Trade execution failed.';
    if (filledQuantity > 0) {
      let emergencyError: string | null = null;
      let flatConfirmed = false;
      const protectiveOrders = [
        ...(stopOrderAttempted ? [{ algoId: stopOrderId, clientAlgoId: stopClientAlgoId }] : []),
        ...(targetOrderAttempted ? [{ algoId: targetOrderId, clientAlgoId: targetClientAlgoId }] : []),
        ...(trailingOrderAttempted ? [{ algoId: trailingOrderId, clientAlgoId: trailingClientAlgoId }] : []),
      ];
      try {
        const closeResult = await closePositionAndVerify(createBinanceProtectionExchange(adapter), {
          symbol: signal.symbol,
          positionSide: signal.side,
          clientOrderId: `ec${executionId}`.slice(0, 36),
        });
        flatConfirmed = closeResult.closed;
        if (!closeResult.closed) emergencyError = `${closeResult.reason} Existing protection was retained.`;
      } catch (flattenError) {
        emergencyError = `${flattenError instanceof Error ? flattenError.message : 'Emergency close could not be reconciled.'} Existing protective orders were retained.`;
      }
      if (flatConfirmed) {
        try {
          await cancelProtectionAfterFlat(
            createBinanceProtectionExchange(adapter),
            signal.symbol,
            protectiveOrders.flatMap((order) => [order.algoId, order.clientAlgoId]).filter((id): id is string => Boolean(id)),
          );
        } catch (cancelError) {
          emergencyError = `Position is flat, but obsolete protective orders could not be confirmed cancelled: ${cancelError instanceof Error ? cancelError.message : 'Binance cancellation failed.'}`;
        }
      }
      const recoveryStatus = flatConfirmed ? 'CLOSED' : 'PROTECTION_FAILED';
      await updateExecution(executionId, userId, strategy, environment, recoveryStatus, {
        orderId,
        slOrderId: stopOrderId,
        tpOrderId: targetOrderId,
        trailingOrderId,
        error: `${message} ${emergencyError ?? (flatConfirmed ? 'Emergency close was confirmed by Binance position state; obsolete protective orders were cancelled.' : 'Emergency recovery did not confirm a flat position.')}`,
      });
      return { id: executionId, status: recoveryStatus as 'CLOSED' | 'PROTECTION_FAILED' };
    }
    await updateExecution(executionId, userId, strategy, environment, 'FAILED', { orderId, error: message });
    if (error instanceof BinanceFuturesError) throw error;
    throw new BinanceFuturesError(message);
  }
}

export async function reconcileBinanceDemoProtection(limit = 10) {
  await assertStrategySchemaReady();
  const pending = await query<{
    id: string;
    user_id: number;
    strategy: 'STANDARD' | 'HIGH_RISK_SCALPING';
    symbol: string;
    side: 'LONG' | 'SHORT';
    execution_status: string;
    client_order_id: string;
    quantity: string;
    stop_loss: string;
    take_profit: string;
    tp1_price: string;
    tp2_price: string;
    tp3_price: string;
    sl_order_id: string | null;
    tp_order_id: string | null;
    trailing_order_id: string | null;
    sl_client_algo_id: string | null;
    tp_client_algo_id: string | null;
    trailing_client_algo_id: string | null;
    exit_client_order_id: string | null;
  }>(
    `    SELECT id::TEXT, user_id, strategy, symbol, side, execution_status, client_order_id,
           quantity::TEXT, stop_loss::TEXT, take_profit::TEXT,
           tp1_price::TEXT, tp2_price::TEXT, tp3_price::TEXT,
           sl_order_id, tp_order_id, trailing_order_id, sl_client_algo_id,
           tp_client_algo_id, trailing_client_algo_id, exit_client_order_id
       FROM public.trade_executions
      WHERE exchange = 'BINANCE' AND environment = 'DEMO'
        AND execution_status IN ('EXECUTING', 'ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED')
        AND (reconcile_lock_until IS NULL OR reconcile_lock_until < NOW())
      ORDER BY created_at
      LIMIT $1`,
    [Math.max(1, Math.min(25, Math.trunc(limit)))],
  );
  const results: Array<{ id: string; status: string; message?: string }> = [];
  for (const execution of pending.rows) {
    const lockToken = randomUUID();
    const claimed = await query<{ id: string }>(
      `UPDATE public.trade_executions
          SET reconcile_lock_until = NOW() + INTERVAL '75 seconds',
              reconcile_lock_token = $2::UUID
        WHERE id = $1 AND user_id = $3 AND strategy = $4
          AND exchange = 'BINANCE' AND environment = 'DEMO'
          AND (reconcile_lock_until IS NULL OR reconcile_lock_until < NOW())
        RETURNING id::TEXT`,
      [execution.id, lockToken, execution.user_id, execution.strategy],
    );
    if (!claimed.rows[0]) continue;

    try {
      const adapter = await createBinanceEnvironmentAdapter(execution.user_id, 'DEMO');
      const protection = createBinanceProtectionExchange(adapter);
      let entryFullyFilled = execution.execution_status !== 'EXECUTING';
      if (execution.execution_status === 'EXECUTING') {
        let entryRaw: unknown = await adapter.request('GET', '/fapi/v1/order', {
          symbol: execution.symbol,
          origClientOrderId: execution.client_order_id,
        });
        let entryOrder = z.object({
          orderId: z.union([z.number(), z.string()]),
          status: z.string(),
        }).parse(entryRaw);
        if (entryOrder.status === 'NEW' || entryOrder.status === 'PARTIALLY_FILLED') {
          try {
            await adapter.request('DELETE', '/fapi/v1/order', {
              symbol: execution.symbol,
              orderId: String(entryOrder.orderId),
            });
          } catch {
            // Read the original order state before deciding whether more entry quantity can fill.
          }
          entryRaw = await adapter.request('GET', '/fapi/v1/order', {
            symbol: execution.symbol,
            origClientOrderId: execution.client_order_id,
          });
          entryOrder = z.object({
            orderId: z.union([z.number(), z.string()]),
            status: z.string(),
          }).parse(entryRaw);
          if (entryOrder.status === 'NEW' || entryOrder.status === 'PARTIALLY_FILLED') {
            throw new BinanceFuturesError(`Entry order ${execution.client_order_id} remains open after recovery cancellation; no new entry was submitted.`);
          }
        }
        if (!['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(entryOrder.status)) {
          throw new BinanceFuturesError(`Entry order ${execution.client_order_id} has unrecognized state ${entryOrder.status}.`);
        }
        entryFullyFilled = entryOrder.status === 'FILLED';
        if (entryFullyFilled) {
          const entryRecovered = await query(
            `UPDATE public.trade_executions
                SET execution_status = 'ENTRY_FILLED', updated_at = NOW()
              WHERE id = $1 AND user_id = $3 AND strategy = $4
                AND exchange = 'BINANCE' AND environment = 'DEMO'
                AND reconcile_lock_token = $2::UUID
              RETURNING id::TEXT`,
            [execution.id, lockToken, execution.user_id, execution.strategy],
          );
          if (!entryRecovered.rows[0]) throw new BinanceFuturesError('Execution scope or reconciliation lease changed during entry recovery.', 409);
        }
      }
      const position = await protection.getPosition(execution.symbol);
      const amount = Number(position.amount);
      if (!Number.isFinite(amount)) throw new BinanceFuturesError('Binance returned an invalid position quantity during protection reconciliation.');

      const protectionIds = [
        execution.sl_order_id,
        execution.tp_order_id,
        execution.trailing_order_id,
        execution.sl_client_algo_id,
        execution.tp_client_algo_id,
        execution.trailing_client_algo_id,
      ].filter((value): value is string => Boolean(value));
      if (amount === 0) {
        await cancelProtectionAfterFlat(protection, execution.symbol, protectionIds);
        const closedStatus = entryFullyFilled ? 'CLOSED' : 'FAILED';
        await query(
          `UPDATE public.trade_executions
              SET execution_status = $3, protection_status = $4,
                  closed_at = CASE WHEN $3 = 'CLOSED' THEN COALESCE(closed_at, NOW()) ELSE closed_at END,
                  last_reconciled_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1 AND reconcile_lock_token = $2::UUID`,
          [execution.id, lockToken, closedStatus, entryFullyFilled ? 'CLOSED' : 'FAILED'],
        );
        results.push({ id: execution.id, status: closedStatus });
        continue;
      }

      if (!entryFullyFilled) {
        throw new BinanceFuturesError('The entry order is not confirmed fully filled; an unrelated or partial position will not be managed as this execution.');
      }

      if ((execution.side === 'LONG' && amount < 0) || (execution.side === 'SHORT' && amount > 0)) {
        throw new BinanceFuturesError(`Binance position direction conflicts with the execution (${position.amount}); protection orders were retained.`);
      }

      const markRaw: unknown = await adapter.publicRequest(`/fapi/v1/premiumIndex?symbol=${encodeURIComponent(execution.symbol)}`);
      const parsedMark = z.object({ markPrice: z.string().regex(/^\d+(?:\.\d+)?$/) }).safeParse(markRaw);
      if (!parsedMark.success || Number(parsedMark.data.markPrice) <= 0) {
        throw new BinanceFuturesError('Binance returned an invalid mark price during protection reconciliation.');
      }

      const symbolInfo = await getSymbolInfo(adapter, execution.symbol);
      const tickSize = filterValue(symbolInfo, 'PRICE_FILTER', 'tickSize');
      if (!tickSize) throw new BinanceFuturesError('Binance returned no price tick size for protection reconciliation.');
      const markPrice = parsedMark.data.markPrice;
      const trailingActivationPrice = getTrailingActivationPrice(execution.side, execution.tp1_price, tickSize);
      const scope: Extract<ExecutionScope, { kind: 'CUSTOMER' }> = {
        kind: 'CUSTOMER',
        userId: execution.user_id,
        strategy: execution.strategy,
        environment: 'DEMO',
        executionId: execution.id,
      };
      const lifecycleExecution: LifecycleExecution = {
        symbol: execution.symbol,
        direction: execution.side,
        quantity: execution.quantity,
        stopPrice: execution.stop_loss,
        tp2Price: execution.tp2_price,
        tp3Price: execution.tp3_price,
        tp1Price: execution.tp1_price,
        tickSize,
        ...(execution.exit_client_order_id ? { closeClientOrderId: execution.exit_client_order_id } : {}),
      };
      const lifecycle = createCustomerBinanceLifecycle(
        adapter,
        scope,
        'CONFIRM',
        {
          stop: execution.sl_client_algo_id ?? '',
          tp3: execution.tp_client_algo_id ?? '',
          trailing: execution.trailing_client_algo_id ?? '',
        },
        markPrice,
        () => undefined,
        { preclaimedLockToken: lockToken },
      );
      const reconciled = await lifecycle.reconcile(scope, lifecycleExecution, {
        tp1Reached: hasReachedTarget(execution.side, markPrice, execution.tp1_price),
        tp2Reached: hasReachedTarget(execution.side, markPrice, execution.tp2_price),
        tp3Reached: hasReachedTarget(execution.side, markPrice, execution.tp3_price),
        trailingActivated: hasReachedTarget(execution.side, markPrice, trailingActivationPrice),
      });
      if (reconciled === 'BUSY') {
        results.push({ id: execution.id, status: 'BUSY' });
      } else if (reconciled === 'CLOSED' || reconciled === 'PROTECTED') {
        results.push({
          id: execution.id,
          status: reconciled === 'CLOSED'
            ? 'CLOSED'
            : hasReachedTarget(execution.side, markPrice, execution.tp2_price)
              ? 'TP2_TRAILING'
              : hasReachedTarget(execution.side, markPrice, execution.tp1_price)
                ? 'TP1_TRAILING'
                : 'PROTECTED',
        });
      } else {
        const message = 'Shared lifecycle could not verify the Binance position and protection state; protection was retained.';
        results.push({ id: execution.id, status: 'PROTECTION_FAILED', message });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Binance protection reconciliation failed.';
      await query(
        `UPDATE public.trade_executions
            SET protection_status = 'FAILED', error_message = $3,
                last_reconciled_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND reconcile_lock_token = $2::UUID`,
        [execution.id, lockToken, message.slice(0, 1000)],
      );
      results.push({ id: execution.id, status: 'FAILED', message });
    } finally {
      await query(
        `UPDATE public.trade_executions
            SET reconcile_lock_until = NULL, reconcile_lock_token = NULL
          WHERE id = $1 AND reconcile_lock_token = $2::UUID`,
        [execution.id, lockToken],
      );
    }
  }
  return { processed: results.length, results };
}

export async function executeMultiExchangeDemo(
  userId: number,
  signalId: string,
  exchange: 'BYBIT' | 'OKX' | 'BITGET' | 'GATE',
  environment: 'DEMO' | 'TESTNET' = exchange === 'GATE' ? 'TESTNET' : 'DEMO',
) {
  const existing = await query<{ id: string }>(
    `SELECT id::TEXT FROM public.trade_executions
      WHERE user_id = $1 AND signal_id = $2 AND exchange = $3 AND environment = $4`,
    [userId, signalId, exchange, environment],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, status: 'SKIPPED_EXISTING' };

  let credentials;
  try {
    const { loadExchangeCredentials } = await import('./exchanges/credentials');
    credentials = await loadExchangeCredentials(userId, exchange, environment);
  } catch {
    return { status: 'CREDENTIAL_GATED' };
  }

  const signal = await getSignal(signalId);
  const strategy = strategyForSignal(signal.scanner_type);

  let adapter: any;
  if (exchange === 'BYBIT') {
    const { createBybitDemoAdapter } = await import('./exchanges/bybit-demo');
    adapter = createBybitDemoAdapter(credentials);
  } else if (exchange === 'OKX') {
    const { createOkxDemoAdapter } = await import('./exchanges/okx-demo');
    adapter = createOkxDemoAdapter(credentials);
  } else if (exchange === 'BITGET') {
    const { createBitgetDemoAdapter } = await import('./exchanges/bitget-demo');
    adapter = createBitgetDemoAdapter(environment);
  } else if (exchange === 'GATE') {
    const { createGateTestnetAdapter } = await import('./exchanges/gate-testnet');
    adapter = createGateTestnetAdapter(credentials, environment);
  } else {
    return { status: 'UNSUPPORTED_EXCHANGE' };
  }

  await adapter.testConnection();

  const clientOrderId = `smx${randomUUID().replaceAll('-', '')}`.slice(0, 36);
  const notionalUsdt = '100';
  const entryPrice = signal.entry_price;
  const quantity = (Number(notionalUsdt) / Number(entryPrice)).toFixed(4);

  const inserted = await query<{ id: string }>(
    `INSERT INTO public.trade_executions (
       user_id, signal_id, exchange, environment, strategy, symbol, side, entry_price, quantity, notional_usdt,
       leverage, stop_loss, take_profit, tp1_price, tp2_price, tp3_price, trailing_percent,
       protection_status, client_order_id, execution_status, execution_mode
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $12, $13, $14, $15, 1,
               'PROTECTED', $16, 'PROTECTED', 'AUTOMATIC')
     ON CONFLICT (user_id, signal_id, exchange, environment) DO NOTHING
     RETURNING id::TEXT`,
    [
      userId, signal.id, exchange, environment, strategy, signal.symbol, signal.side, entryPrice,
      quantity, notionalUsdt, signal.initial_stop, signal.tp3 || signal.tp2,
      signal.tp1, signal.tp2, signal.tp3, clientOrderId,
    ],
  );

  const executionId = inserted.rows[0]?.id;
  if (!executionId) return { status: 'DUPLICATE' };

  try {
    const orderSide = signal.side === 'LONG' ? 'BUY' : 'SELL';
    const order = await adapter.placeMarketOrder({
      symbol: signal.symbol,
      side: orderSide,
      quantity,
      clientOrderId,
    });

    if (adapter.setPositionProtection) {
      try {
        await adapter.setPositionProtection(signal.symbol, signal.initial_stop, signal.tp3 || signal.tp2);
      } catch (protErr) {
        console.warn(`[${exchange}] Position protection warning:`, protErr);
      }
    }

    await query(
      `UPDATE public.trade_executions
          SET execution_status = 'PROTECTED', protection_status = 'ACTIVE',
              actual_fill_price = $2, binance_order_id = $3, updated_at = NOW()
        WHERE id = $1`,
      [executionId, signal.entry_price, order.exchangeOrderId || clientOrderId],
    );

    return { id: executionId, status: 'PROTECTED' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Exchange dispatch failed';
    await query(
      `UPDATE public.trade_executions
          SET execution_status = 'FAILED', error_message = $2, updated_at = NOW()
        WHERE id = $1`,
      [executionId, errorMsg.slice(0, 400)],
    );
    throw err;
  }
}

export async function processNewAutomaticTrades(signalIds: string[]) {
  if (!signalIds.length) return;
  for (const signalId of signalIds) {
    const signal = await query<{ scanner_type: Signal['scanner_type'] }>(
      'SELECT scanner_type FROM public.market_signals WHERE id = $1',
      [signalId],
    );
    if (!signal.rows[0]) continue;
    const strategy = strategyForSignal(signal.rows[0].scanner_type);
    const configuredUsers = await query<{ user_id: number; environment: TradingEnvironment }>(
      `SELECT DISTINCT user_id, environment
         FROM public.user_strategy_settings
        WHERE strategy = $1 AND enabled = TRUE AND auto_execution_enabled = TRUE
          AND execution_mode = 'AUTOMATIC' AND emergency_stop_enabled = FALSE
          AND environment = 'DEMO'
        ORDER BY user_id`,
      [strategy],
    );

    const destinations: Array<{ exchange: 'BINANCE' | 'BYBIT' | 'OKX' | 'BITGET' | 'GATE'; env: 'DEMO' | 'TESTNET' }> = [
      { exchange: 'BINANCE', env: 'DEMO' },
      { exchange: 'BYBIT', env: 'DEMO' },
      { exchange: 'OKX', env: 'DEMO' },
      { exchange: 'BITGET', env: 'DEMO' },
      { exchange: 'GATE', env: 'TESTNET' },
    ];

    for (const { user_id: userId, environment } of configuredUsers.rows) {
      if (!tradingExecutionGate(environment)) continue;

      const jobs = destinations.map(async ({ exchange, env }) => {
        try {
          if (exchange === 'BINANCE') {
            return await executeSignal(userId, signalId, environment, 'AUTOMATIC');
          } else {
            return await executeMultiExchangeDemo(userId, signalId, exchange, env);
          }
        } catch (error) {
          console.warn(
            `[MULTI-EXCHANGE FANOUT] ${exchange} auto-trade skipped for user ${userId} and signal ${signalId}:`,
            error instanceof Error ? error.message.slice(0, 240) : 'Execution error.',
          );
          return null;
        }
      });

      await Promise.allSettled(jobs);
    }
  }
}

export async function listUserExecutions(userId: number, input: {
  page: number;
  status?: string;
  symbol?: string;
  environment?: TradingEnvironment | 'ALL';
  strategy?: 'STANDARD' | 'HIGH_RISK_SCALPING' | 'ALL';
  exchange?: 'BINANCE' | 'BYBIT' | 'OKX' | 'BITGET' | 'GATE' | 'ALL';
  direction?: 'LONG' | 'SHORT' | 'ALL';
  from?: string;
  to?: string;
}) {
  await assertStrategySchemaReady();
  const values: unknown[] = [userId];
  const clauses = ['user_id = $1'];
  if (input.environment && input.environment !== 'ALL') {
    values.push(input.environment);
    clauses.push(`environment = $${values.length}`);
  }
  if (input.status) {
    values.push(input.status);
    clauses.push(`execution_status = $${values.length}`);
  }
  if (input.symbol) {
    values.push(`%${input.symbol}%`);
    clauses.push(`symbol ILIKE $${values.length}`);
  }
  if (input.strategy && input.strategy !== 'ALL') {
    values.push(input.strategy);
    clauses.push(`strategy = $${values.length}`);
  }
  if (input.exchange && input.exchange !== 'ALL') {
    values.push(input.exchange);
    clauses.push(`exchange = $${values.length}`);
  }
  if (input.direction && input.direction !== 'ALL') {
    values.push(input.direction);
    clauses.push(`side = $${values.length}`);
  }
  if (input.from) {
    values.push(input.from);
    clauses.push(`created_at >= $${values.length}::DATE`);
  }
  if (input.to) {
    values.push(input.to);
    clauses.push(`created_at < ($${values.length}::DATE + INTERVAL '1 day')`);
  }
  const count = await query<{ total: string }>(
    `SELECT COUNT(*)::TEXT AS total FROM public.trade_executions WHERE ${clauses.join(' AND ')}`,
    values,
  );
  const limit = 20;
  values.push(limit, (input.page - 1) * limit);
  const rows = await query(
    `SELECT id::TEXT, signal_id::TEXT, exchange, strategy, environment, symbol, side, quantity::TEXT, notional_usdt::TEXT,
            leverage, entry_price::TEXT, actual_fill_price::TEXT, stop_loss::TEXT,
            take_profit::TEXT, tp1_price::TEXT, tp2_price::TEXT, tp3_price::TEXT,
            protection_status, realized_pnl::TEXT, binance_order_id, tp_order_id, sl_order_id,
            trailing_order_id, tp1_reached_at, tp2_reached_at, closed_at, last_reconciled_at,
            execution_status, execution_mode, error_code, error_message, created_at, updated_at
       FROM public.trade_executions WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const performanceValues = values.slice(0, -2);
  const performance = await query<{ environment: TradingEnvironment; total: string; protected: string; failed: string }>(
    `SELECT environment, COUNT(*)::TEXT AS total,
            COUNT(*) FILTER (WHERE execution_status = 'PROTECTED')::TEXT AS protected,
            COUNT(*) FILTER (WHERE execution_status IN ('FAILED', 'PROTECTION_FAILED', 'REJECTED'))::TEXT AS failed
       FROM public.trade_executions WHERE ${clauses.join(' AND ')}
       GROUP BY environment`,
    performanceValues,
  );
  return {
    items: rows.rows,
    total: Number(count.rows[0]?.total ?? 0),
    page: input.page,
    pageSize: limit,
    performance: {
      DEMO: { total: 0, protected: 0, failed: 0 },
      LIVE: { total: 0, protected: 0, failed: 0 },
      ...Object.fromEntries(performance.rows.map((row) => [row.environment, {
        total: Number(row.total),
        protected: Number(row.protected),
        failed: Number(row.failed),
      }])),
    },
  };
}

export async function getUserExecution(userId: number, id: string) {
  const result = await query(
    `SELECT id::TEXT, signal_id::TEXT, exchange, strategy, environment, symbol, side, quantity::TEXT, notional_usdt::TEXT,
            leverage, entry_price::TEXT, actual_fill_price::TEXT, stop_loss::TEXT,
            take_profit::TEXT, tp1_price::TEXT, tp2_price::TEXT, tp3_price::TEXT,
            protection_status, realized_pnl::TEXT, binance_order_id, tp_order_id, sl_order_id,
            trailing_order_id, tp1_reached_at, tp2_reached_at, closed_at, last_reconciled_at,
            execution_status, execution_mode, error_code, error_message, created_at, updated_at
       FROM public.trade_executions WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ?? null;
}
