import 'server-only';

import { z } from 'zod';
import { createFixedBinanceDemoClient, type BinanceCredentialPair } from './binance-futures';
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
  buildTrailingStopOrderParameters,
  cancelProtectionAfterFlat,
  closePositionAndVerify,
  getTrailingActivationPrice,
  hasReachedTarget,
  type BinanceProtectionExchange,
} from './binance-protection-lifecycle';
import type {
  EntryOrderResult,
  EntryRequest,
  ExecutionScope,
  ExchangeExecutionPort,
  LifecycleExecution,
  ProtectionIdentifiers,
} from './execution-lifecycle';
import type { AdminDemoExecutionRecord } from './admin-demo-execution-repository';

export type BinanceDemoClient = ReturnType<typeof createFixedBinanceDemoClient>;
export type BinanceDemoTransport = typeof fetch;
export type AdminDemoExecutionReader = {
  getExecution(scope: ExecutionScope): Promise<AdminDemoExecutionRecord | null>;
};

const positionResponse = z.array(z.object({
  symbol: z.string(),
  positionAmt: z.string().regex(/^-?\d+(?:\.\d+)?$/),
}));
const orderResponse = z.object({
  orderId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  status: z.string(),
  executedQty: z.string().regex(/^\d+(?:\.\d+)?$/),
});
const exchangeInfoResponse = z.object({
  symbols: z.array(z.object({
    symbol: z.string(),
    status: z.string(),
    contractType: z.string(),
    quoteAsset: z.string(),
    filters: z.array(z.record(z.string(), z.union([z.string(), z.number()]).transform(String))),
  })),
});

function mapEntryOrder(raw: unknown): EntryOrderResult {
  const parsed = orderResponse.safeParse(raw);
  if (!parsed.success) return { orderId: '', status: 'UNKNOWN', executedQuantity: '0' };
  const status = ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(parsed.data.status)
    ? parsed.data.status as EntryOrderResult['status']
    : 'UNKNOWN';
  return {
    orderId: String(parsed.data.orderId),
    status,
    executedQuantity: parsed.data.executedQty,
  };
}

function decimalScale(value: string) {
  const match = /^\d+(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error('Binance quantity filter returned an invalid decimal.');
  return match[1]?.length ?? 0;
}

function scaled(value: string, scale: number) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 10n ** BigInt(scale) +
    BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0');
}

function isStepMultiple(value: string, step: string) {
  const scale = Math.max(decimalScale(value), decimalScale(step));
  const unit = scaled(step, scale);
  return unit > 0n && scaled(value, scale) % unit === 0n;
}

function expectedPositionSide(direction: 'LONG' | 'SHORT') {
  return direction === 'LONG' ? 'BUY' as const : 'SELL' as const;
}

function assertDemoScope(
  scope: ExecutionScope,
  accountId: string,
): asserts scope is Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }> {
  if (
    scope.kind !== 'ADMIN_DEMO_TEST' ||
    scope.environment !== 'DEMO' ||
    scope.strategy !== 'STANDARD' ||
    scope.testAccountId !== accountId
  ) throw new Error('Fixed Binance Demo adapter rejected an out-of-scope execution.');
}

export function createAdminBinanceDemoExecutionPort(
  credentials: BinanceCredentialPair & { testAccountId: string; environment: 'DEMO' },
  records: AdminDemoExecutionReader,
  transport: BinanceDemoTransport = fetch,
): ExchangeExecutionPort & {
  readonly environment: 'DEMO';
  readonly baseUrl: 'https://demo-fapi.binance.com';
  getTargetProgress(scope: ExecutionScope, execution: LifecycleExecution): Promise<{
    tp1Reached: boolean;
    tp2Reached: boolean;
    tp3Reached: boolean;
    trailingActivated: boolean;
  }>;
  preflight(scope: ExecutionScope, execution: LifecycleExecution): Promise<{
    ready: boolean;
    environment: 'DEMO';
    endpoint: 'https://demo-fapi.binance.com';
    oneWayMode: boolean;
    symbolValid: boolean;
    quantityValid: boolean;
  }>;
} {
  if (credentials.environment !== 'DEMO' || !/^[1-9]\d*$/.test(credentials.testAccountId)) {
    throw new Error('Only dedicated Binance Demo credentials can initialize this adapter.');
  }
  const client = createFixedBinanceDemoClient(credentials, transport);

  async function getPosition(symbol: string) {
    const raw: unknown = await client.request('GET', '/fapi/v3/positionRisk', { symbol });
    const parsed = positionResponse.safeParse(raw);
    if (!parsed.success) throw new Error('Binance returned invalid Admin Demo position data.');
    return { symbol, amount: parsed.data.find((row) => row.symbol === symbol)?.positionAmt ?? '0' };
  }

  const protectionExchange: BinanceProtectionExchange = {
    getPosition,
    async closePosition(input) {
      const raw: unknown = await client.request('POST', '/fapi/v1/order', {
        symbol: input.symbol,
        side: input.side,
        type: 'MARKET',
        quantity: input.quantity,
        reduceOnly: 'true',
        positionSide: 'BOTH',
        newClientOrderId: input.clientOrderId,
        newOrderRespType: 'RESULT',
      });
      return z.object({ status: z.string() }).parse(raw);
    },
    async getCloseOrder(symbol, clientOrderId) {
      const raw: unknown = await client.request('GET', '/fapi/v1/order', {
        symbol,
        origClientOrderId: clientOrderId,
      });
      return z.object({ status: z.string() }).parse(raw);
    },
    async getOpenProtectionOrders(symbol) {
      const orders = await listOpenBinanceAlgoOrders(client, symbol);
      return orders.map((order) => ({ id: String(order.algoId), clientId: order.clientAlgoId }));
    },
    async cancelProtectionOrder(symbol, order) {
      await cancelBinanceAlgoOrder(client, symbol, order.id);
    },
  };

  async function getRecord(scope: ExecutionScope) {
    assertDemoScope(scope, credentials.testAccountId);
    const record = await records.getExecution(scope);
    if (!record || record.admin_user_id !== scope.adminUserId ||
        record.session_id !== scope.sessionId ||
        record.authorization_id !== scope.authorizationId ||
        record.test_account_id !== scope.testAccountId ||
        record.symbol.length === 0) {
      throw new Error('Admin Demo execution record is unavailable or out of scope.');
    }
    return record;
  }

  return Object.assign({
    environment: 'DEMO' as const,
    baseUrl: 'https://demo-fapi.binance.com' as const,
    async assertEntryPreconditions(scope: ExecutionScope, execution: LifecycleExecution) {
      assertDemoScope(scope, credentials.testAccountId);
      const [accountRaw, positionModeRaw, infoRaw, tickerRaw] = await Promise.all([
        client.request<unknown>('GET', '/fapi/v3/account'),
        client.request<unknown>('GET', '/fapi/v1/positionSide/dual'),
        client.publicRequest<unknown>('/fapi/v1/exchangeInfo'),
        client.publicRequest<unknown>(`/fapi/v1/premiumIndex?symbol=${encodeURIComponent(execution.symbol)}`),
      ]);
      const account = z.object({ canTrade: z.boolean() }).safeParse(accountRaw);
      const positionMode = z.object({ dualSidePosition: z.boolean() }).safeParse(positionModeRaw);
      const info = exchangeInfoResponse.safeParse(infoRaw);
      const ticker = z.object({ markPrice: z.string().regex(/^\d+(?:\.\d+)?$/) }).safeParse(tickerRaw);
      if (!account.success || !account.data.canTrade || !positionMode.success ||
          positionMode.data.dualSidePosition || !info.success || !ticker.success) {
        throw new Error('Binance Demo account, One-way mode, or market preflight is not ready.');
      }
      const market = info.data.symbols.find((row) =>
        row.symbol === execution.symbol && row.status === 'TRADING' &&
        row.contractType === 'PERPETUAL' && row.quoteAsset === 'USDT');
      if (!market) throw new Error('The requested contract is not an active USDT perpetual.');
      const lot = market.filters.find((filter) => filter.filterType === 'LOT_SIZE');
      const minNotionalFilter = market.filters.find((filter) => filter.filterType === 'MIN_NOTIONAL');
      if (!lot?.stepSize || !lot.minQty ||
          Number(execution.quantity) < Number(lot.minQty) ||
          !isStepMultiple(execution.quantity, lot.stepSize)) {
        throw new Error('Requested quantity does not satisfy Binance Demo quantity filters.');
      }
      const minNotional = Number(minNotionalFilter?.notional ?? minNotionalFilter?.minNotional ?? '0');
      if (minNotional > 0 && Number(execution.quantity) * Number(ticker.data.markPrice) < minNotional) {
        throw new Error('Requested quantity is below Binance Demo minimum notional.');
      }
      const position = await getPosition(execution.symbol);
      if (Number(position.amount) !== 0) throw new Error('Dedicated Binance Demo account must be flat before a test.');
    },
    async submitEntry(scope: ExecutionScope, request: EntryRequest) {
      assertDemoScope(scope, credentials.testAccountId);
      const record = await getRecord(scope);
      if (record.entry_client_order_id !== request.clientOrderId) {
        throw new Error('Admin Demo entry idempotency key does not match the reserved execution.');
      }
      const raw: unknown = await client.request('POST', '/fapi/v1/order', {
        symbol: request.execution.symbol,
        side: expectedPositionSide(request.execution.direction),
        type: 'MARKET',
        quantity: request.execution.quantity,
        positionSide: 'BOTH',
        newClientOrderId: request.clientOrderId,
        newOrderRespType: 'RESULT',
      });
      return mapEntryOrder(raw);
    },
    async lookupEntry(scope: ExecutionScope, symbol: string, clientOrderId: string) {
      const record = await getRecord(scope);
      if (record.symbol !== symbol || record.entry_client_order_id !== clientOrderId) {
        throw new Error('Admin Demo entry lookup is outside its reserved execution.');
      }
      try {
        const raw: unknown = await client.request('GET', '/fapi/v1/order', {
          symbol,
          origClientOrderId: clientOrderId,
        });
        return mapEntryOrder(raw);
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'exchangeCode' in error &&
            error.exchangeCode === -2013) return null;
        throw error;
      }
    },
    async cancelEntry(scope: ExecutionScope, symbol: string, orderId: string) {
      const record = await getRecord(scope);
      if (record.symbol !== symbol || !/^\d+$/.test(orderId) ||
          record.entry_exchange_order_id && record.entry_exchange_order_id !== orderId) {
        throw new Error('Admin Demo entry cancellation is outside its reserved execution.');
      }
      const raw: unknown = await client.request('DELETE', '/fapi/v1/order', { symbol, orderId });
      return mapEntryOrder(raw);
    },
    async installProtection(scope: ExecutionScope, execution: LifecycleExecution): Promise<ProtectionIdentifiers> {
      const record = await getRecord(scope);
      const side = execution.direction === 'LONG' ? 'SELL' : 'BUY';
      const stopAlgoId = await submitAndVerifyBinanceAlgoOrder(client, buildCloseAllAlgoOrderParameters({
        symbol: execution.symbol,
        side,
        type: 'STOP_MARKET',
        triggerPrice: execution.stopPrice,
        clientAlgoId: record.stop_client_algo_id,
      }));
      const tp3AlgoId = await submitAndVerifyBinanceAlgoOrder(client, buildCloseAllAlgoOrderParameters({
        symbol: execution.symbol,
        side,
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: execution.tp3Price,
        clientAlgoId: record.tp3_client_algo_id,
      }));
      const markRaw: unknown = await client.publicRequest(`/fapi/v1/premiumIndex?symbol=${encodeURIComponent(execution.symbol)}`);
      const mark = z.object({ markPrice: z.string().regex(/^\d+(?:\.\d+)?$/) }).parse(markRaw).markPrice;
      const activation = getTrailingActivationPrice(execution.direction, execution.tp1Price, execution.tickSize);
      assertTrailingActivationDirection(execution.direction, activation, mark);
      const trailingAlgoId = await submitAndVerifyBinanceAlgoOrder(client, buildTrailingStopOrderParameters({
        symbol: execution.symbol,
        positionSide: execution.direction,
        quantity: execution.quantity,
        tp1: execution.tp1Price,
        tickSize: execution.tickSize,
        clientAlgoId: record.trailing_client_algo_id,
      }));
      return { stopAlgoId, tp3AlgoId, trailingAlgoId };
    },
    async verifyProtection(scope: ExecutionScope, execution: LifecycleExecution, identifiers: ProtectionIdentifiers) {
      const record = await getRecord(scope);
      const orders = await listOpenBinanceAlgoOrders(client, execution.symbol);
      const stop = findUniqueOpenBinanceAlgoOrder(orders, identifiers.stopAlgoId, record.stop_client_algo_id);
      const tp3 = findUniqueOpenBinanceAlgoOrder(orders, identifiers.tp3AlgoId, record.tp3_client_algo_id);
      const trailing = findUniqueOpenBinanceAlgoOrder(orders, identifiers.trailingAlgoId, record.trailing_client_algo_id);
      const side = execution.direction === 'LONG' ? 'SELL' : 'BUY';
      return Boolean(
        stop && tp3 && trailing &&
        verifyBinanceAlgoOrder(stop, buildCloseAllAlgoOrderParameters({
          symbol: execution.symbol, side, type: 'STOP_MARKET',
          triggerPrice: execution.stopPrice, clientAlgoId: record.stop_client_algo_id,
        })) === identifiers.stopAlgoId &&
        verifyBinanceAlgoOrder(tp3, buildCloseAllAlgoOrderParameters({
          symbol: execution.symbol, side, type: 'TAKE_PROFIT_MARKET',
          triggerPrice: execution.tp3Price, clientAlgoId: record.tp3_client_algo_id,
        })) === identifiers.tp3AlgoId &&
        verifyBinanceAlgoOrder(trailing, buildTrailingStopOrderParameters({
          symbol: execution.symbol, positionSide: execution.direction,
          quantity: execution.quantity, tp1: execution.tp1Price,
          tickSize: execution.tickSize, clientAlgoId: record.trailing_client_algo_id,
        })) === identifiers.trailingAlgoId
      );
    },
    async getPosition(scope: ExecutionScope, symbol: string) {
      assertDemoScope(scope, credentials.testAccountId);
      return getPosition(symbol);
    },
    async closePositionAndVerify(scope: ExecutionScope, execution: LifecycleExecution) {
      assertDemoScope(scope, credentials.testAccountId);
      const result = await closePositionAndVerify(protectionExchange, {
        symbol: execution.symbol,
        positionSide: execution.direction,
        clientOrderId: execution.closeClientOrderId ?? `adclose${scope.sessionId}`.slice(0, 36),
        reconcileExistingOrder: true,
      });
      return { closed: result.closed, ...('reason' in result ? { reason: result.reason } : {}) };
    },
    async cancelObsoleteProtection(scope: ExecutionScope, execution: LifecycleExecution, identifiers: ProtectionIdentifiers) {
      assertDemoScope(scope, credentials.testAccountId);
      await cancelProtectionAfterFlat(protectionExchange, execution.symbol, [
        identifiers.stopAlgoId, identifiers.tp3AlgoId, identifiers.trailingAlgoId,
      ]);
    },
    async getTargetProgress(scope: ExecutionScope, execution: LifecycleExecution) {
      assertDemoScope(scope, credentials.testAccountId);
      const raw: unknown = await client.publicRequest(`/fapi/v1/premiumIndex?symbol=${encodeURIComponent(execution.symbol)}`);
      const mark = z.object({ markPrice: z.string().regex(/^\d+(?:\.\d+)?$/) }).parse(raw).markPrice;
      const record = await getRecord(scope);
      const tp1Reached = Boolean(record.tp1_reached_at) || hasReachedTarget(execution.direction, mark, execution.tp1Price);
      const tp2Reached = Boolean(record.tp2_reached_at) || hasReachedTarget(execution.direction, mark, execution.tp2Price);
      const tp3Reached = hasReachedTarget(execution.direction, mark, execution.tp3Price);
      return {
        tp1Reached,
        tp2Reached,
        tp3Reached,
        trailingActivated: tp1Reached,
      };
    },
    async preflight(scope: ExecutionScope, execution: LifecycleExecution) {
      assertDemoScope(scope, credentials.testAccountId);
      const [mode, info] = await Promise.all([
        client.request<unknown>('GET', '/fapi/v1/positionSide/dual'),
        client.publicRequest<unknown>('/fapi/v1/exchangeInfo'),
      ]);
      const oneWayMode = z.object({ dualSidePosition: z.literal(false) }).safeParse(mode).success;
      const infoParsed = exchangeInfoResponse.safeParse(info);
      const market = infoParsed.success ? infoParsed.data.symbols.find((row) =>
        row.symbol === execution.symbol && row.status === 'TRADING' &&
        row.contractType === 'PERPETUAL' && row.quoteAsset === 'USDT') : undefined;
      const quantityValid = Boolean(market?.filters.some((filter) =>
        filter.filterType === 'LOT_SIZE' && filter.stepSize && filter.minQty &&
        Number(execution.quantity) >= Number(filter.minQty) && isStepMultiple(execution.quantity, filter.stepSize)));
      const symbolValid = Boolean(market);
      return {
        ready: oneWayMode && symbolValid && quantityValid,
        environment: 'DEMO' as const,
        endpoint: 'https://demo-fapi.binance.com' as const,
        oneWayMode,
        symbolValid,
        quantityValid,
      };
    },
  }, {
    environment: client.environment,
    baseUrl: client.baseUrl,
  });
}
