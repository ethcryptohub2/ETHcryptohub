import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BinanceFuturesError, createBinanceEnvironmentAdapter, getFuturesBalance, tradingExecutionGate, type TradingEnvironment } from './binance-futures';
import { query } from './db';
import { getTradingSettings } from './trading-settings';

type Signal = {
  id: string;
  signal_key: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entry_price: string;
  entry_zone_low: string;
  entry_zone_high: string;
  initial_stop: string;
  tp1: string;
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

async function submitConditionalOrder(
  adapter: Awaited<ReturnType<typeof createBinanceEnvironmentAdapter>>,
  parameters: Record<string, string>,
): Promise<string> {
  const clientAlgoId = parameters.clientAlgoId;
  if (!clientAlgoId) throw new Error('Missing conditional-order idempotency key.');
  const orderSchema = z.object({
    algoId: z.union([z.number(), z.string()]),
    clientAlgoId: z.string(),
    algoStatus: z.string(),
    algoType: z.string(),
    symbol: z.string(),
    side: z.string(),
    orderType: z.string(),
    triggerPrice: z.union([z.number(), z.string()]),
    workingType: z.string(),
    closePosition: z.union([z.boolean(), z.string()]).transform(String),
  });
  let algoId: string | undefined;
  try {
    const response: unknown = await adapter.request('POST', '/fapi/v1/algoOrder', parameters);
    if (typeof response === 'object' && response !== null && 'algoId' in response) {
      const parsed = z.union([z.number(), z.string()]).safeParse(response.algoId);
      if (parsed.success) algoId = String(parsed.data);
    }
  } catch {
    // The request may have succeeded despite a network error; reconcile before recovery.
  }
  const reconciled: unknown = await adapter.request(
    'GET',
    '/fapi/v1/algoOrder',
    { symbol: parameters.symbol!, ...(algoId ? { algoId } : { clientAlgoId }) },
  );
  const parsed = orderSchema.safeParse(reconciled);
  if (
    !parsed.success ||
    parsed.data.algoStatus !== 'NEW' ||
    parsed.data.clientAlgoId !== clientAlgoId ||
    parsed.data.algoType !== 'CONDITIONAL' ||
    parsed.data.symbol !== parameters.symbol ||
    parsed.data.side !== parameters.side ||
    parsed.data.orderType !== parameters.type ||
    Number(parsed.data.triggerPrice) !== Number(parameters.triggerPrice) ||
    parsed.data.workingType !== parameters.workingType ||
    parsed.data.closePosition !== 'true'
  ) {
    throw new BinanceFuturesError(`Conditional order ${clientAlgoId} was not verified as active with the requested protection; the position recovery path will run.`);
  }
  return String(parsed.data.algoId);
}

async function getSignal(signalId: string): Promise<Signal> {
  const result = await query<Signal>(
    `SELECT id::TEXT, signal_key, symbol, side, entry_price::TEXT, initial_stop::TEXT,
            entry_zone_low::TEXT, entry_zone_high::TEXT, tp1::TEXT,
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
  const target = Number(signal.tp1);
  if (
    !/^[A-Z0-9]{2,30}$/.test(signal.symbol) ||
    ![entry, stop, target].every((price) => Number.isFinite(price) && price > 0) ||
    (signal.side === 'LONG' ? !(stop < entry && entry < target) : !(target < entry && entry < stop))
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

async function computeOrder(signal: Signal, userId: number, environment: TradingEnvironment, allowBackgroundEnvironment = false) {
  const [settings, balance, adapter] = await Promise.all([
    getTradingSettings(userId),
    getFuturesBalance(userId, environment),
    createBinanceEnvironmentAdapter(userId, environment),
  ]);
  if (!allowBackgroundEnvironment && settings.active_environment !== environment) {
    throw new BinanceFuturesError('The selected environment changed. Select it again before continuing.', 409);
  }
  const [info, markPrice] = await Promise.all([
    getSymbolInfo(adapter, signal.symbol),
    getMarkPrice(adapter, signal.symbol),
  ]);
  if (markPrice < Number(signal.entry_zone_low) || markPrice > Number(signal.entry_zone_high)) {
    throw new BinanceFuturesError("Current Binance mark price is outside this signal's valid entry zone.", 409);
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
  if (!maxLeverage || settings.default_leverage > maxLeverage) {
    throw new BinanceFuturesError(`Selected leverage exceeds this pair's Binance limit (${maxLeverage || 'unavailable'}x).`, 422);
  }

  const entry = Number(signal.entry_price);
  const stop = Number(signal.initial_stop);
  const equity = Number(balance.walletBalance);
  const available = Number(balance.availableBalance);
  const riskAmount = equity * Number(settings.risk_percentage) / 100;
  const notional = settings.order_size_mode === 'RISK_BASED'
    ? riskAmount / Math.abs(entry - stop) * entry
    : Number(settings.fixed_notional_usdt);
  const rawQuantity = settings.order_size_mode === 'RISK_BASED'
    ? riskAmount / Math.abs(entry - stop)
    : notional / entry;
  const quantity = floorToStep(rawQuantity, step);
  const numericQuantity = Number(quantity);
  const roundedNotional = numericQuantity * entry;
  if (numericQuantity < minQty || numericQuantity > maxQty || roundedNotional < minNotional) {
    throw new BinanceFuturesError('Calculated order does not meet Binance quantity or notional limits.', 422);
  }
  if (!Number.isFinite(available) || roundedNotional / settings.default_leverage > available) {
    throw new BinanceFuturesError('Available Futures balance is insufficient for this order and leverage.', 422);
  }

  const stopPrice = signal.side === 'LONG' ? ceilToStep(stop, tick) : floorToStep(stop, tick);
  const targetPrice = signal.side === 'LONG' ? floorToStep(Number(signal.tp1), tick) : ceilToStep(Number(signal.tp1), tick);
  if (
    signal.side === 'LONG'
      ? !(Number(stopPrice) < markPrice && markPrice < Number(targetPrice))
      : !(Number(targetPrice) < markPrice && markPrice < Number(stopPrice))
  ) {
    throw new BinanceFuturesError('Rounded stop and take-profit triggers must remain on the correct side of the current mark price.', 422);
  }
  return {
    settings,
    info,
    adapter,
    quantity,
    notionalUsdt: roundedNotional.toFixed(8),
    leverage: settings.default_leverage,
    markPrice: markPrice.toString(),
    stopPrice,
    targetPrice,
  };
}

async function updateExecution(id: string, environment: TradingEnvironment, status: string, fields: {
  fillPrice?: string;
  orderId?: string;
  tpOrderId?: string;
  slOrderId?: string;
  error?: string;
}) {
  await query(
    `UPDATE public.trade_executions
        SET execution_status = $2,
            actual_fill_price = COALESCE($3::NUMERIC, actual_fill_price),
            binance_order_id = COALESCE($4, binance_order_id),
            tp_order_id = COALESCE($5, tp_order_id),
            sl_order_id = COALESCE($6, sl_order_id),
            error_message = $7, updated_at = NOW()
      WHERE id = $1 AND environment = $8`,
    [id, status, fields.fillPrice ?? null, fields.orderId ?? null, fields.tpOrderId ?? null, fields.slOrderId ?? null, fields.error ?? null, environment],
  );
}

export async function previewSignalOrder(userId: number, signalId: string, environment: TradingEnvironment) {
  const signal = await getSignal(signalId);
  const prepared = await computeOrder(signal, userId, environment);
  const killSwitchEnabled = environment === 'DEMO'
    ? prepared.settings.demo_kill_switch_enabled
    : prepared.settings.live_kill_switch_enabled;
  const executionMode = environment === 'DEMO'
    ? prepared.settings.demo_execution_mode
    : prepared.settings.live_execution_mode;
  return {
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
    canExecute: tradingExecutionGate(environment) && !killSwitchEnabled &&
      executionMode === 'CONFIRM',
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
  const signal = await getSignal(signalId);
  const prepared = await computeOrder(signal, userId, environment, mode === 'AUTOMATIC');
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
  const autoTradeEnabled = environment === 'DEMO'
    ? prepared.settings.demo_auto_trade_enabled
    : prepared.settings.live_auto_trade_enabled;
  const killSwitchEnabled = environment === 'DEMO'
    ? prepared.settings.demo_kill_switch_enabled
    : prepared.settings.live_kill_switch_enabled;
  const executionMode = environment === 'DEMO'
    ? prepared.settings.demo_execution_mode
    : prepared.settings.live_execution_mode;
  if (killSwitchEnabled || (mode === 'AUTOMATIC' && (!autoTradeEnabled || executionMode !== 'AUTOMATIC'))) {
    throw new BinanceFuturesError('Automatic execution is disabled or the emergency stop is active for this environment.', 409);
  }
  if (mode === 'CONFIRM' && executionMode !== 'CONFIRM') {
    throw new BinanceFuturesError('Manual confirmation is unavailable while Automatic mode is selected.', 409);
  }

  const clientOrderId = `${environment === 'DEMO' ? 'ed' : 'el'}${randomUUID().replaceAll('-', '')}`.slice(0, 36);
  const inserted = await query<{ id: string }>(
    `INSERT INTO public.trade_executions (
       user_id, signal_id, environment, symbol, side, entry_price, quantity, notional_usdt,
       leverage, stop_loss, take_profit, client_order_id, execution_status,
       execution_mode, user_confirmed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'EXECUTING', $13,
               CASE WHEN $13 = 'CONFIRM' THEN NOW() ELSE NULL END)
     ON CONFLICT (user_id, signal_id, environment) DO NOTHING
     RETURNING id::TEXT`,
    [
      userId, signal.id, environment, signal.symbol, signal.side, signal.entry_price, prepared.quantity,
      prepared.notionalUsdt, prepared.leverage, prepared.stopPrice, prepared.targetPrice,
      clientOrderId, mode,
    ],
  );
  const executionId = inserted.rows[0]?.id;
  if (!executionId) throw new BinanceFuturesError('This signal already has an execution record and cannot be submitted again.', 409);

  const adapter = prepared.adapter;
  const entrySide = signal.side === 'LONG' ? 'BUY' : 'SELL';
  const exitSide = entrySide === 'BUY' ? 'SELL' : 'BUY';
  let orderId: string | undefined;
  let filledQuantity = 0;
  let stopOrderId: string | undefined;
  let targetOrderId: string | undefined;
  let stopOrderAttempted = false;
  let targetOrderAttempted = false;
  const stopClientAlgoId = `ehs${randomUUID().replaceAll('-', '')}`.slice(0, 36);
  const targetClientAlgoId = `eht${randomUUID().replaceAll('-', '')}`.slice(0, 36);
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

    const [currentSignal, currentSettings] = await Promise.all([
      getSignal(signalId),
      getTradingSettings(userId),
    ]);
    if (
      currentSignal.signal_key !== signal.signal_key ||
      (mode === 'CONFIRM' && currentSettings.active_environment !== environment) ||
      (environment === 'DEMO' ? currentSettings.demo_kill_switch_enabled : currentSettings.live_kill_switch_enabled) ||
      (mode === 'AUTOMATIC' && !(environment === 'DEMO' ? currentSettings.demo_auto_trade_enabled : currentSettings.live_auto_trade_enabled))
    ) {
      throw new BinanceFuturesError('Signal or trading authorization changed before order placement. No order was submitted.', 409);
    }

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
        await updateExecution(executionId, environment, 'PROTECTION_FAILED', {
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
        await updateExecution(executionId, environment, 'PROTECTION_FAILED', {
          error: 'Binance accepted or returned an unrecognized entry response. The system did not retry; reconcile by client order ID before taking action.',
        });
        return { id: executionId, status: 'PROTECTION_FAILED' as const };
      }
    }
    if (!filledOrder.success) {
      await updateExecution(executionId, environment, 'PROTECTION_FAILED', {
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
            await updateExecution(executionId, environment, 'PROTECTION_FAILED', {
              orderId: String(orderDetails.orderId),
              error: `Entry order remains in an unconfirmed state (${orderDetails.status}); check Binance immediately.`,
            });
            return { id: executionId, status: 'PROTECTION_FAILED' as const };
          }
        } catch (cancelError) {
          await updateExecution(executionId, environment, 'PROTECTION_FAILED', {
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
        await updateExecution(executionId, environment, 'ENTRY_FILLED', {
          fillPrice: partialFillPrice,
          orderId,
        });
        throw new BinanceFuturesError(`Entry order was only partially filled (${orderDetails.status}); the partial position will be closed.`, 502);
      }
      await updateExecution(executionId, environment, 'FAILED', {
        orderId: String(orderDetails.orderId),
        error: `Entry order was not fully filled (status: ${orderDetails.status}).`,
      });
      return { id: executionId, status: 'FAILED' as const };
    }
    const fillPrice = orderDetails.avgPrice && Number(orderDetails.avgPrice) > 0
      ? numericString(orderDetails.avgPrice)
      : (Number(orderDetails.cumQuote ?? 0) / filledQuantity).toString();
    orderId = String(orderDetails.orderId);
    await updateExecution(executionId, environment, 'ENTRY_FILLED', { fillPrice, orderId });

    stopOrderAttempted = true;
    stopOrderId = await submitConditionalOrder(
      adapter,
      {
        algoType: 'CONDITIONAL',
        symbol: signal.symbol,
        side: exitSide,
        type: 'STOP_MARKET',
        triggerPrice: prepared.stopPrice,
        closePosition: 'true',
        workingType: 'MARK_PRICE',
        clientAlgoId: stopClientAlgoId,
      },
    );
    targetOrderAttempted = true;
    targetOrderId = await submitConditionalOrder(
      adapter,
      {
        algoType: 'CONDITIONAL',
        symbol: signal.symbol,
        side: exitSide,
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: prepared.targetPrice,
        closePosition: 'true',
        workingType: 'MARK_PRICE',
        clientAlgoId: targetClientAlgoId,
      },
    );
    await updateExecution(executionId, environment, 'PROTECTED', {
      orderId,
      slOrderId: stopOrderId,
      tpOrderId: targetOrderId,
    });
    return { id: executionId, status: 'PROTECTED' as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Trade execution failed.';
    if (filledQuantity > 0) {
      let emergencyError: string | null = null;
      for (const conditionalOrder of [
        ...(stopOrderAttempted ? [{ algoId: stopOrderId, clientAlgoId: stopClientAlgoId }] : []),
        ...(targetOrderAttempted ? [{ algoId: targetOrderId, clientAlgoId: targetClientAlgoId }] : []),
      ]) {
        try {
          await adapter.request(
            'DELETE', '/fapi/v1/algoOrder',
            { symbol: signal.symbol, ...(conditionalOrder.algoId ? { algoId: conditionalOrder.algoId } : { clientAlgoId: conditionalOrder.clientAlgoId }) },
          );
        } catch (cancelError) {
          emergencyError = `${cancelError instanceof Error ? cancelError.message : 'Protective-order cancellation failed.'} Client algo ID: ${conditionalOrder.clientAlgoId}.`;
        }
      }
      try {
        const closeOrder: unknown = await adapter.request(
          'POST', '/fapi/v1/order',
          {
            symbol: signal.symbol,
            side: signal.side === 'LONG' ? 'SELL' : 'BUY',
            type: 'MARKET',
            quantity: floorToStep(filledQuantity, filterValue(prepared.info, 'MARKET_LOT_SIZE', 'stepSize') || filterValue(prepared.info, 'LOT_SIZE', 'stepSize') || '0.001'),
            reduceOnly: 'true',
            newClientOrderId: `${environment === 'DEMO' ? 'edx' : 'elx'}${randomUUID().replaceAll('-', '')}`.slice(0, 36),
          },
        );
        const closeResult = z.object({ status: z.string() }).safeParse(closeOrder);
        if (!closeResult.success || closeResult.data.status !== 'FILLED') {
          emergencyError = `Emergency close was not confirmed as fully filled${emergencyError ? `; protective-order cancellation: ${emergencyError}` : ''}.`;
        } else {
          const positions = await adapter.request<unknown>('GET', '/fapi/v3/positionRisk', { symbol: signal.symbol });
          const positionRows = z.array(z.object({ symbol: z.string(), positionAmt: z.string() })).parse(positions);
          if (positionRows.some((position) => position.symbol === signal.symbol && Number(position.positionAmt) !== 0)) {
            emergencyError = `Emergency close filled but the position is not flat${emergencyError ? `; protective-order cancellation: ${emergencyError}` : ''}.`;
          }
        }
      } catch (flattenError) {
        emergencyError = `${flattenError instanceof Error ? flattenError.message : 'Emergency close failed.'}${emergencyError ? `; protective-order cancellation: ${emergencyError}` : ''}`;
      }
      await updateExecution(executionId, environment, 'PROTECTION_FAILED', {
        orderId,
        slOrderId: stopOrderId,
        tpOrderId: targetOrderId,
        error: `${message} ${emergencyError ? `Emergency recovery requires immediate review: ${emergencyError}` : 'Emergency close was confirmed; verify the position is flat in Binance.'}`,
      });
      return { id: executionId, status: 'PROTECTION_FAILED' as const };
    }
    await updateExecution(executionId, environment, 'FAILED', { orderId, error: message });
    if (error instanceof BinanceFuturesError) throw error;
    throw new BinanceFuturesError(message);
  }
}

export async function processNewAutomaticTrades(signalIds: string[]) {
  if (!signalIds.length) return;
  const configuredUsers = await query<{ user_id: number; environment: TradingEnvironment }>(
    `SELECT user_id, 'DEMO' AS environment FROM public.user_trading_settings
      WHERE demo_auto_trade_enabled = TRUE
        AND demo_kill_switch_enabled = FALSE
        AND demo_execution_mode = 'AUTOMATIC'
     UNION ALL
     SELECT user_id, 'LIVE' AS environment FROM public.user_trading_settings
      WHERE live_auto_trade_enabled = TRUE
        AND live_kill_switch_enabled = FALSE
        AND live_execution_mode = 'AUTOMATIC'
      ORDER BY user_id, environment`,
  );
  for (const signalId of signalIds) {
    for (const { user_id: userId, environment } of configuredUsers.rows) {
      if (!tradingExecutionGate(environment)) continue;
      try {
        await executeSignal(userId, signalId, environment, 'AUTOMATIC');
      } catch (error) {
        console.error(
          `${environment} auto-trade skipped for user ${userId} and signal ${signalId}:`,
          error instanceof Error ? error.message.slice(0, 240) : 'Unknown execution error.',
        );
      }
    }
  }
}

export async function listUserExecutions(userId: number, input: {
  page: number;
  status?: string;
  symbol?: string;
  environment?: TradingEnvironment | 'ALL';
}) {
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
  const count = await query<{ total: string }>(
    `SELECT COUNT(*)::TEXT AS total FROM public.trade_executions WHERE ${clauses.join(' AND ')}`,
    values,
  );
  const limit = 20;
  values.push(limit, (input.page - 1) * limit);
  const rows = await query(
    `SELECT id::TEXT, signal_id::TEXT, environment, symbol, side, quantity::TEXT, notional_usdt::TEXT,
            leverage, entry_price::TEXT, actual_fill_price::TEXT, stop_loss::TEXT,
            take_profit::TEXT, binance_order_id, tp_order_id, sl_order_id,
            execution_status, execution_mode, error_code, error_message, created_at, updated_at
       FROM public.trade_executions WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const performance = await query<{ environment: TradingEnvironment; total: string; protected: string; failed: string }>(
    `SELECT environment, COUNT(*)::TEXT AS total,
            COUNT(*) FILTER (WHERE execution_status = 'PROTECTED')::TEXT AS protected,
            COUNT(*) FILTER (WHERE execution_status IN ('FAILED', 'PROTECTION_FAILED', 'REJECTED'))::TEXT AS failed
       FROM public.trade_executions WHERE user_id = $1
       GROUP BY environment`,
    [userId],
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
    `SELECT id::TEXT, signal_id::TEXT, environment, symbol, side, quantity::TEXT, notional_usdt::TEXT,
            leverage, entry_price::TEXT, actual_fill_price::TEXT, stop_loss::TEXT,
            take_profit::TEXT, binance_order_id, tp_order_id, sl_order_id,
            execution_status, execution_mode, error_code, error_message, created_at, updated_at
       FROM public.trade_executions WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ?? null;
}
