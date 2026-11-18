import 'server-only';

import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  DISABLED_ADMIN_DEMO_CAPABILITIES,
  type AdminDemoProviderCapabilities,
} from './admin-demo-provider-contract';
import {
  createBybitDemoAdapter,
} from './exchanges/bybit-demo';
import type {
  ExchangeBalance,
  ExchangeCredentials,
  ExchangeInstrument,
  ExchangePosition,
  ExchangeTicker,
} from './exchanges/types';
import type {
  EntryOrderResult,
  EntryRequest,
  ExchangeExecutionPort,
  ExecutionScope,
  LifecycleExecution,
  ProtectionIdentifiers,
} from './execution-lifecycle';

const BYBIT_DEMO_BASE_URL = 'https://api-demo.bybit.com' as const;
const RECV_WINDOW = '5000';
const LIFECYCLE_DISABLED_REASON =
  'Bybit Admin Demo execution is disabled by the adapter configuration.';

export type AdminBybitDemoReadClient = Pick<
  ReturnType<typeof createBybitDemoAdapter>,
  | 'testConnection'
  | 'getAccountBalance'
  | 'getMarketInstruments'
  | 'getTicker'
  | 'getPositions'
  | 'placeLimitOrder'
  | 'placeMarketOrder'
  | 'reconcileOrder'
  | 'cancelOrder'
  | 'getOpenOrders'
  | 'getOrderHistory'
  | 'getPositionDetails'
  | 'getRealtimeTrailingStops'
  | 'setPositionLifecycleProtection'
  | 'clearPositionProtection'
> & { bindMutationGuard?: (guard: () => Promise<void>) => void };

type PositionRow = {
  symbol: string;
  positionIdx: number;
  side: 'Buy' | 'Sell' | '';
  size: string;
  avgPrice: string;
  markPrice?: string;
  unrealisedPnl: string;
  leverage?: string;
  stopLoss?: string;
  takeProfit?: string;
  trailingStop?: string;
  tpslMode?: string;
};

const positionResponseSchema = z.object({
  retCode: z.number(),
  retMsg: z.string(),
  result: z.object({
    list: z.array(z.object({
      symbol: z.string(),
      positionIdx: z.union([z.number(), z.string()]).transform(Number),
      side: z.enum(['Buy', 'Sell', '']),
      size: z.string().regex(/^\d+(?:\.\d+)?$/),
      avgPrice: z.string(),
      markPrice: z.string().optional(),
      unrealisedPnl: z.string(),
      leverage: z.string().optional(),
      stopLoss: z.string().optional(),
      takeProfit: z.string().optional(),
      trailingStop: z.string().optional(),
      tpslMode: z.string().optional(),
    })),
  }),
});

function assertSymbol(symbol: string) {
  if (!/^[A-Z0-9]{2,30}$/.test(symbol)) {
    throw new Error('Invalid Bybit linear symbol.');
  }
}

function assertExecution(execution: LifecycleExecution) {
  assertSymbol(execution.symbol);
  if (execution.direction !== 'LONG' && execution.direction !== 'SHORT') {
    throw new Error('Execution direction must be LONG or SHORT.');
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(execution.quantity) || Number(execution.quantity) <= 0) {
    throw new Error('Execution quantity must be a positive decimal.');
  }
}

function assertAdminDemoScope(
  scope: ExecutionScope,
  testAccountId: string,
): asserts scope is Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }> {
  if (
    scope.kind !== 'ADMIN_DEMO_TEST' ||
    scope.environment !== 'DEMO' ||
    scope.strategy !== 'STANDARD' ||
    scope.testAccountId !== testAccountId ||
    !Number.isSafeInteger(scope.adminUserId) ||
    scope.adminUserId < 1 ||
    !/^\d+$/.test(scope.sessionId) ||
    scope.executionId !== scope.sessionId ||
    scope.authorizationId.length === 0
  ) {
    throw new Error('Fixed Bybit Demo adapter rejected an out-of-scope execution.');
  }
}

function decimalParts(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error('Bybit returned an invalid decimal filter.');
  }
  const [whole, fraction = ''] = value.split('.');
  return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function compareDecimals(left: string, right: string) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const leftInteger = a.integer * 10n ** BigInt(scale - a.scale);
  const rightInteger = b.integer * 10n ** BigInt(scale - b.scale);
  return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
}

function isStepMultiple(value: string, step: string) {
  const a = decimalParts(value);
  const b = decimalParts(step);
  const scale = Math.max(a.scale, b.scale);
  const unit = b.integer * 10n ** BigInt(scale - b.scale);
  const amount = a.integer * 10n ** BigInt(scale - a.scale);
  return unit > 0n && amount % unit === 0n;
}

function isBelowNotional(quantity: string, price: string, minimum: string) {
  const amount = decimalParts(quantity);
  const quote = decimalParts(price);
  const floor = decimalParts(minimum);
  const productScale = amount.scale + quote.scale;
  const product = amount.integer * quote.integer;
  const scale = Math.max(productScale, floor.scale);
  return product * 10n ** BigInt(scale - productScale) <
    floor.integer * 10n ** BigInt(scale - floor.scale);
}

function absoluteDifference(left: string, right: string) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const leftInteger = a.integer * 10n ** BigInt(scale - a.scale);
  const rightInteger = b.integer * 10n ** BigInt(scale - b.scale);
  const difference = leftInteger >= rightInteger
    ? leftInteger - rightInteger
    : rightInteger - leftInteger;
  const digits = difference.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction ? `${digits.slice(0, -scale)}.${fraction}` : digits.slice(0, -scale);
}

function isPositiveDecimal(value: string) {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;
}

function toEntryOrderResult(order: Awaited<ReturnType<AdminBybitDemoReadClient['reconcileOrder']>>): EntryOrderResult | null {
  if (!order) return null;
  const status = order.status.toUpperCase();
  const normalizedStatus: EntryOrderResult['status'] =
    status === 'NEW' || status === 'UNTRIGGERED' ? 'NEW'
      : status === 'PARTIALLYFILLED' || status === 'PARTIALLY_FILLED' ? 'PARTIALLY_FILLED'
        : status === 'FILLED' ? 'FILLED'
          : status === 'CANCELLED' || status === 'CANCELED' ? 'CANCELED'
            : status === 'REJECTED' ? 'REJECTED'
              : status === 'DEACTIVATED' || status === 'EXPIRED' ? 'EXPIRED'
                : 'UNKNOWN';
  return {
    orderId: order.exchangeOrderId,
    status: normalizedStatus,
    executedQuantity: order.filledQuantity,
  };
}

function assertEntryMatchesRequest(
  order: NonNullable<Awaited<ReturnType<AdminBybitDemoReadClient['reconcileOrder']>>>,
  request: EntryRequest,
) {
  const expectedSide = request.execution.direction === 'LONG' ? 'BUY' : 'SELL';
  if (
    order.symbol !== request.execution.symbol ||
    order.type.toUpperCase() !== 'LIMIT' ||
    order.side !== expectedSide ||
    compareDecimals(order.quantity, request.execution.quantity) !== 0 ||
    !request.entryPrice ||
    !order.price ||
    compareDecimals(order.price, request.entryPrice) !== 0
  ) {
    throw new Error('Bybit Demo client order ID is already bound to a different entry.');
  }
}

function sortedQuery(parameters: Record<string, string>) {
  return new URLSearchParams(
    Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)),
  ).toString();
}

function signRequest(secret: string, timestamp: string, apiKey: string, query: string) {
  return createHmac('sha256', secret)
    .update(`${timestamp}${apiKey}${RECV_WINDOW}${query}`)
    .digest('hex');
}

export type AdminBybitDemoAdapterOptions = {
  transport?: typeof fetch;
  createClient?: (credentials: ExchangeCredentials) => AdminBybitDemoReadClient;
  now?: () => number;
  executionEnabled?: boolean;
};

export type AdminBybitDemoPreflight = {
  ready: boolean;
  environment: 'DEMO';
  endpoint: typeof BYBIT_DEMO_BASE_URL;
  oneWayMode: boolean;
  symbolValid: boolean;
  quantityValid: boolean;
  accountReady: boolean;
  flat: boolean;
};

export function createAdminBybitDemoExecutionPort(
  credentials: ExchangeCredentials & { testAccountId: string; environment: 'DEMO' },
  options: AdminBybitDemoAdapterOptions = {},
): ExchangeExecutionPort & {
  readonly provider: 'BYBIT';
  readonly environment: 'DEMO';
  readonly baseUrl: typeof BYBIT_DEMO_BASE_URL;
  readonly capabilities: Readonly<AdminDemoProviderCapabilities>;
  testConnection(scope: ExecutionScope): Promise<void>;
  getAccountBalance(scope: ExecutionScope): Promise<ExchangeBalance[]>;
  getMarketInstruments(scope: ExecutionScope): Promise<ExchangeInstrument[]>;
  getTicker(scope: ExecutionScope, symbol: string): Promise<ExchangeTicker>;
  getPositions(scope: ExecutionScope): Promise<ExchangePosition[]>;
  preflight(scope: ExecutionScope, execution: LifecycleExecution): Promise<AdminBybitDemoPreflight>;
  submitEntry(scope: ExecutionScope, request: EntryRequest): Promise<EntryOrderResult>;
  lookupEntry(scope: ExecutionScope, symbol: string, clientOrderId: string): Promise<EntryOrderResult | null>;
  cancelEntry(scope: ExecutionScope, symbol: string, orderId: string): Promise<EntryOrderResult>;
  bindMutationGuard(guard: (scope: ExecutionScope) => Promise<void>): void;
  recoverProtection(scope: ExecutionScope, execution: LifecycleExecution): Promise<ProtectionIdentifiers>;
  reconcileStagedProtection(
    scope: ExecutionScope,
    execution: LifecycleExecution,
    progress: { tp1Reached: boolean; tp2Reached: boolean },
  ): Promise<{
    tp1Reached: boolean;
    tp2Reached: boolean;
    trailingActivated: boolean;
    tp2Update: 'UNSUPPORTED_RETAINED' | 'NOT_REQUESTED';
  }>;
} {
  if (
    credentials.environment !== 'DEMO' ||
    !/^[1-9]\d*$/.test(credentials.testAccountId) ||
    !credentials.apiKey.trim() ||
    !credentials.apiSecret.trim()
  ) {
    throw new Error('Only dedicated Bybit Demo credentials can initialize this adapter.');
  }

  const transport = options.transport ?? fetch;
  const now = options.now ?? Date.now;
  const client = (options.createClient ?? createBybitDemoAdapter)(credentials);
  const executionEnabled = options.executionEnabled === true;
  let mutationGuard: (scope: ExecutionScope) => Promise<void> = async () => {};
  let mutationScope: ExecutionScope | undefined;
  async function beforeMutation(scope: ExecutionScope) {
    mutationScope = scope;
    await mutationGuard(scope);
  }
  client.bindMutationGuard?.(async () => {
    if (!mutationScope) throw new Error('Bybit mutation scope is missing.');
    await mutationGuard(mutationScope);
  });
  if (executionEnabled && (!options.createClient || !options.transport)) {
    throw new Error('Bybit lifecycle implementation is restricted to explicitly injected mock client and transport. Remote execution remains disabled.');
  }
  const capabilities: Readonly<AdminDemoProviderCapabilities> = Object.freeze({
    ...DISABLED_ADMIN_DEMO_CAPABILITIES,
    connectionTest: true,
    balance: true,
    instruments: true,
    positions: true,
    entryPreflight: true,
    ...(executionEnabled ? {
      limitEntry: true,
      stopLossProtection: true,
      takeProfitProtection: true,
      trailingProtection: true,
      reduceOnlyClose: true,
      reconciliation: true,
      adminLifecycle: true,
    } : {}),
  });

  async function getPositionRows(symbol: string): Promise<PositionRow[]> {
    assertSymbol(symbol);
    const parameters = { category: 'linear', symbol };
    const query = sortedQuery(parameters);
    const timestamp = String(now());
    const response = await transport(`${BYBIT_DEMO_BASE_URL}/v5/position/list?${query}`, {
      method: 'GET',
      headers: {
        'X-BAPI-API-KEY': credentials.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN': signRequest(credentials.apiSecret, timestamp, credentials.apiKey, query),
        'X-BAPI-SIGN-TYPE': '2',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Bybit Demo position query returned HTTP ${response.status}.`);
    const parsed = positionResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.retCode !== 0) {
      throw new Error('Bybit Demo returned an invalid position response.');
    }
    return parsed.data.result.list;
  }

  function assertLifecycleEnabled() {
    if (!executionEnabled) throw new Error(LIFECYCLE_DISABLED_REASON);
  }

  async function getDetails(symbol: string) {
    const details = await client.getPositionDetails(symbol);
    if (details.some((row) => row.symbol !== symbol || row.positionIdx !== 0)) {
      throw new Error('Bybit account is not in verified one-way mode.');
    }
    if (details.length !== 1) {
      throw new Error('Bybit returned ambiguous one-way position data.');
    }
    return details[0];
  }

  async function validateProtectionPlan(execution: LifecycleExecution, averagePrice: string) {
    const instruments = await client.getMarketInstruments();
    const instrument = instruments.find((item) =>
      item.exchangeSymbol === execution.symbol &&
      item.contractType === 'PERPETUAL' &&
      item.quoteAsset === 'USDT' &&
      item.status === 'Trading');
    if (!instrument || compareDecimals(instrument.tickSize, execution.tickSize) !== 0) {
      throw new Error('Bybit protection tick size does not match the live contract filter.');
    }
    validateProtectionPrices(execution, instrument.tickSize);
    const long = execution.direction === 'LONG';
    const validOrdering = long
      ? compareDecimals(execution.stopPrice, averagePrice) < 0 &&
        compareDecimals(averagePrice, execution.tp1Price) < 0 &&
        compareDecimals(execution.tp1Price, execution.tp2Price) < 0 &&
        compareDecimals(execution.tp2Price, execution.tp3Price) < 0
      : compareDecimals(execution.stopPrice, averagePrice) > 0 &&
        compareDecimals(averagePrice, execution.tp1Price) > 0 &&
        compareDecimals(execution.tp1Price, execution.tp2Price) > 0 &&
        compareDecimals(execution.tp2Price, execution.tp3Price) > 0;
    if (!validOrdering) {
      throw new Error('Bybit stop and take-profit levels do not match the open position direction.');
    }
    const trailingDistance = absoluteDifference(averagePrice, execution.stopPrice);
    if (!isPositiveDecimal(trailingDistance) || !isStepMultiple(trailingDistance, instrument.tickSize)) {
      throw new Error('Bybit cannot derive a tick-aligned trailing distance from the initial risk.');
    }
    return { instrument, trailingDistance };
  }

  function validateProtectionPrices(execution: LifecycleExecution, tickSize: string) {
    const prices = [execution.stopPrice, execution.tp1Price, execution.tp2Price, execution.tp3Price];
    if (prices.some((price) => !isPositiveDecimal(price) || !isStepMultiple(price, tickSize))) {
      throw new Error('Bybit protection prices must be positive tick-aligned decimals.');
    }
    const long = execution.direction === 'LONG';
    const levelsOrdered = long
      ? compareDecimals(execution.stopPrice, execution.tp1Price) < 0 &&
        compareDecimals(execution.tp1Price, execution.tp2Price) < 0 &&
        compareDecimals(execution.tp2Price, execution.tp3Price) < 0
      : compareDecimals(execution.stopPrice, execution.tp1Price) > 0 &&
        compareDecimals(execution.tp1Price, execution.tp2Price) > 0 &&
        compareDecimals(execution.tp2Price, execution.tp3Price) > 0;
    if (!levelsOrdered) throw new Error('Bybit protection levels are not ordered for the execution direction.');
  }

  async function assertEntryPreconditions(
    scope: ExecutionScope,
    execution: LifecycleExecution,
    entryPrice?: string,
  ) {
    assertAdminDemoScope(scope, credentials.testAccountId);
    assertLifecycleEnabled();
    assertExecution(execution);
    const readiness = await preflight(scope, execution);
    if (!readiness.ready) {
      throw new Error('Bybit Demo entry preconditions require a flat one-way account, valid symbol and quantity, and a ready account.');
    }
    const instrument = (await client.getMarketInstruments()).find((item) =>
      item.exchangeSymbol === execution.symbol &&
      item.contractType === 'PERPETUAL' &&
      item.quoteAsset === 'USDT' &&
      item.status === 'Trading');
    if (!instrument || compareDecimals(instrument.tickSize, execution.tickSize) !== 0) {
      throw new Error('Bybit protection tick size does not match the live contract filter.');
    }
    validateProtectionPrices(execution, instrument.tickSize);
    if (entryPrice) {
      const isLong = execution.direction === 'LONG';
      const entryBetweenStopAndTarget = isLong
        ? compareDecimals(execution.stopPrice, entryPrice) < 0 &&
          compareDecimals(entryPrice, execution.tp1Price) < 0
        : compareDecimals(execution.stopPrice, entryPrice) > 0 &&
          compareDecimals(entryPrice, execution.tp1Price) > 0;
      if (!entryBetweenStopAndTarget) {
        throw new Error('Bybit entry price must be between the initial stop and TP1.');
      }
    }
  }

  function protectionIdentifiers(scope: ExecutionScope): ProtectionIdentifiers {
    const key = scope.executionId;
    return {
      stopAlgoId: `native-${key}-sl`,
      tp3AlgoId: `native-${key}-tp3`,
      trailingAlgoId: `native-${key}-trail-tp1`,
    };
  }

  function assertProtectionIdentifiers(scope: ExecutionScope, identifiers: ProtectionIdentifiers) {
    const expected = protectionIdentifiers(scope);
    if (
      identifiers.stopAlgoId !== expected.stopAlgoId ||
      identifiers.tp3AlgoId !== expected.tp3AlgoId ||
      identifiers.trailingAlgoId !== expected.trailingAlgoId
    ) {
      throw new Error('Bybit protection identifiers do not match this execution.');
    }
  }

  async function preflight(
    scope: ExecutionScope,
    execution: LifecycleExecution,
  ): Promise<AdminBybitDemoPreflight> {
    assertAdminDemoScope(scope, credentials.testAccountId);
    assertExecution(execution);
    const [accountReady, instruments, ticker, rows] = await Promise.all([
      client.testConnection().then(() => true),
      client.getMarketInstruments(),
      client.getTicker(execution.symbol),
      getPositionRows(execution.symbol),
    ]);

    const instrument = instruments.find((item) =>
      item.exchangeSymbol === execution.symbol &&
      item.contractType === 'PERPETUAL' &&
      item.quoteAsset === 'USDT' &&
      item.status === 'Trading');
    const symbolValid = Boolean(instrument);
    let quantityValid = false;
    if (instrument) {
      try {
        quantityValid =
          isStepMultiple(execution.quantity, instrument.quantityStep) &&
          compareDecimals(execution.quantity, instrument.minimumQuantity) >= 0 &&
          (!instrument.maximumQuantity ||
            compareDecimals(execution.quantity, instrument.maximumQuantity) <= 0) &&
          (!instrument.minimumNotional ||
            !isBelowNotional(execution.quantity, ticker.markPrice ?? ticker.lastPrice, instrument.minimumNotional));
      } catch {
        quantityValid = false;
      }
    }
    const oneWayMode = rows.length === 1 && rows.every((row) =>
      row.symbol === execution.symbol && row.positionIdx === 0);
    const flat = rows.every((row) => Number(row.size) === 0);
    return {
      ready: accountReady && oneWayMode && symbolValid && quantityValid && flat,
      environment: 'DEMO',
      endpoint: BYBIT_DEMO_BASE_URL,
      oneWayMode,
      symbolValid,
      quantityValid,
      accountReady,
      flat,
    };
  }

  return Object.assign({
    provider: 'BYBIT' as const,
    environment: 'DEMO' as const,
    baseUrl: BYBIT_DEMO_BASE_URL,
    capabilities,
    supportsResidualClose: true,
    bindMutationGuard(guard: (scope: ExecutionScope) => Promise<void>) {
      mutationGuard = guard;
    },

    async testConnection(scope: ExecutionScope) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      await client.testConnection();
    },

    async getAccountBalance(scope: ExecutionScope) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      return client.getAccountBalance();
    },

    async getMarketInstruments(scope: ExecutionScope) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      return client.getMarketInstruments();
    },

    async getTicker(scope: ExecutionScope, symbol: string) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      assertSymbol(symbol);
      return client.getTicker(symbol);
    },

    async getPositions(scope: ExecutionScope) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      return client.getPositions();
    },

    async preflight(scope: ExecutionScope, execution: LifecycleExecution) {
      return preflight(scope, execution);
    },

    async assertEntryPreconditions(scope: ExecutionScope, execution: LifecycleExecution) {
      await assertEntryPreconditions(scope, execution);
    },

    async submitEntry(scope: ExecutionScope, request: EntryRequest): Promise<EntryOrderResult> {
      assertAdminDemoScope(scope, credentials.testAccountId);
      assertLifecycleEnabled();
      assertExecution(request.execution);
      if (!request.entryPrice || !isPositiveDecimal(request.entryPrice)) {
        throw new Error('A positive limit entry price is required for Bybit Demo.');
      }
      if (!/^[A-Za-z0-9_-]{1,36}$/.test(request.clientOrderId)) {
        throw new Error('Invalid Bybit Demo client order ID.');
      }
      const existing = await client.reconcileOrder(request.execution.symbol, request.clientOrderId);
      if (existing) {
        assertEntryMatchesRequest(existing, request);
        return toEntryOrderResult(existing)!;
      }
      await assertEntryPreconditions(scope, request.execution, request.entryPrice);
      const instrument = (await client.getMarketInstruments()).find((item) =>
        item.exchangeSymbol === request.execution.symbol &&
        item.contractType === 'PERPETUAL' &&
        item.quoteAsset === 'USDT' &&
        item.status === 'Trading');
      if (
        !instrument ||
        !isStepMultiple(request.entryPrice, instrument.tickSize) ||
        Boolean(instrument.minimumNotional &&
          isBelowNotional(request.execution.quantity, request.entryPrice, instrument.minimumNotional))
      ) {
        throw new Error('Bybit Demo limit entry price violates tick-size or minimum-notional constraints.');
      }
      try {
        await beforeMutation(scope);
        const order = await client.placeLimitOrder({
          symbol: request.execution.symbol,
          side: request.execution.direction === 'LONG' ? 'BUY' : 'SELL',
          quantity: request.execution.quantity,
          price: request.entryPrice,
          clientOrderId: request.clientOrderId,
          initialProtection: {
            stopLoss: request.execution.stopPrice,
            takeProfit: request.execution.tp3Price,
          },
        });
        return toEntryOrderResult(order)!;
      } catch (error) {
        try {
          const recovered = await client.reconcileOrder(request.execution.symbol, request.clientOrderId);
          if (recovered) {
            assertEntryMatchesRequest(recovered, request);
            return toEntryOrderResult(recovered)!;
          }
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            `Bybit Demo entry outcome is uncertain; reconcile ${request.clientOrderId} before retrying.`,
            { cause: error },
          );
        }
        throw error;
      }
    },

    async lookupEntry(
      scope: ExecutionScope,
      symbol: string,
      clientOrderId: string,
    ): Promise<EntryOrderResult | null> {
      assertAdminDemoScope(scope, credentials.testAccountId);
      assertLifecycleEnabled();
      assertSymbol(symbol);
      if (!/^[A-Za-z0-9_-]{1,36}$/.test(clientOrderId)) throw new Error('Invalid Bybit Demo client order ID.');
      return toEntryOrderResult(await client.reconcileOrder(symbol, clientOrderId));
    },

    async cancelEntry(scope: ExecutionScope, symbol: string, orderId: string) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      assertLifecycleEnabled();
      assertSymbol(symbol);
      if (!/^\d{1,32}$/.test(orderId)) throw new Error('Invalid Bybit Demo order ID.');
      const openOrder = (await client.getOpenOrders(symbol))
        .find((order) => order.exchangeOrderId === orderId);
      if (!openOrder) {
        const historicalOrder = (await client.getOrderHistory(symbol, 50))
          .find((order) => order.exchangeOrderId === orderId);
        if (historicalOrder && ['Cancelled', 'Canceled', 'Filled', 'Rejected', 'Deactivated'].includes(historicalOrder.status)) {
          return toEntryOrderResult(historicalOrder)!;
        }
        throw new Error('Bybit Demo entry cannot be reconciled before cancellation.');
      }
      const before = openOrder;
      if (!before.clientOrderId) throw new Error('Bybit Demo entry has no client ID for cancellation recovery.');
      let cancelError: unknown;
      try {
        await beforeMutation(scope);
        await client.cancelOrder(symbol, orderId);
      } catch (error) {
        cancelError = error;
      }
      let after: Awaited<ReturnType<AdminBybitDemoReadClient['reconcileOrder']>>;
      try {
        after = await client.reconcileOrder(symbol, before.clientOrderId);
      } catch (recoveryError) {
        throw new AggregateError(
          [cancelError, recoveryError].filter((error) => error !== undefined),
          'Bybit Demo entry cancellation outcome is uncertain; reconcile the client order ID before retrying.',
          { cause: cancelError ?? recoveryError },
        );
      }
      if (after && ['Cancelled', 'Canceled', 'Filled', 'Rejected', 'Deactivated'].includes(after.status)) {
        return toEntryOrderResult(after)!;
      }
      if (cancelError) throw cancelError;
      if (!after || !['Cancelled', 'Canceled', 'Filled', 'Rejected', 'Deactivated'].includes(after.status)) {
        throw new Error('Bybit Demo entry cancellation could not be verified.');
      }
      return toEntryOrderResult(after)!;
    },

    async installProtection(scope: ExecutionScope, execution: LifecycleExecution): Promise<ProtectionIdentifiers> {
      assertAdminDemoScope(scope, credentials.testAccountId);
      assertLifecycleEnabled();
      assertExecution(execution);
      const position = await getDetails(execution.symbol);
      if (
        Number(position.size) <= 0 ||
        position.side !== (execution.direction === 'LONG' ? 'Buy' : 'Sell') ||
        compareDecimals(position.size, execution.quantity) !== 0
      ) {
        throw new Error('Bybit Demo position direction or quantity does not match the execution.');
      }
      const { trailingDistance } = await validateProtectionPlan(execution, position.avgPrice);
      const identifiers = protectionIdentifiers(scope);
      // A repeat/restart must observe the existing singleton before creating protection.
      if (await this.verifyProtection(scope, execution, identifiers)) return identifiers;
      const existingTrailing = await client.getRealtimeTrailingStops(execution.symbol);
      if (existingTrailing.length > 0 || Number(position.trailingStop || '0') > 0) {
        throw new Error('Bybit existing trailing protection is ambiguous; retained without replacement.');
      }
      let installError: unknown;
      try {
        await beforeMutation(scope);
        await client.setPositionLifecycleProtection(execution.symbol, {
        stopLoss: execution.stopPrice,
        takeProfit: execution.tp3Price,
        trailingStop: trailingDistance,
        activePrice: execution.tp1Price,
        });
      } catch (error) {
        // A timeout is not a rejection: read back before deciding whether installation failed.
        installError = error;
      }
      if (!(await this.verifyProtection(scope, execution, identifiers))) {
        throw new Error('Bybit Demo did not verify full-position SL, TP3, and TP1-activated trailing protection; existing protection retained.', { cause: installError });
      }
      return identifiers;
    },

    async recoverProtection(scope: ExecutionScope, execution: LifecycleExecution) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      assertLifecycleEnabled();
      const identifiers = protectionIdentifiers(scope);
      // These identifiers describe native position protection, not order ownership.
      // Read the actual position/protection before restoring durable bookkeeping.
      if (await this.verifyProtection(scope, execution, identifiers)) return identifiers;
      const position = await getDetails(execution.symbol);
      if (Number(position.size) === 0) return identifiers;
      if (position.side !== (execution.direction === 'LONG' ? 'Buy' : 'Sell') ||
          compareDecimals(position.size, execution.quantity) > 0) {
        throw new Error('Bybit recovery position differs from the execution; operator review required.');
      }
      // Do not replace ambiguous protection. An explicitly scoped emergency close
      // is safer than leaving an open, unverified position indefinitely.
      const close = await this.closePositionAndVerify(scope, execution);
      if (!close.closed) throw new Error(close.reason ?? 'Emergency closure remains unconfirmed.');
      return identifiers;
    },

    async reconcileStagedProtection(
      scope: ExecutionScope,
      execution: LifecycleExecution,
      progress: { tp1Reached: boolean; tp2Reached: boolean },
    ) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      assertLifecycleEnabled();
      if (!(await this.verifyProtection(scope, execution, protectionIdentifiers(scope)))) {
        throw new Error('Bybit staged protection could not be verified; retain protection and reconcile or emergency close.');
      }
      const ticker = await client.getTicker(execution.symbol);
      const markPrice = ticker.markPrice;
      if (!markPrice || !isPositiveDecimal(markPrice)) {
        throw new Error('Bybit staged milestones require a valid mark price.');
      }
      const reached = (price: string) => execution.direction === 'LONG'
        ? compareDecimals(markPrice, price) >= 0
        : compareDecimals(markPrice, price) <= 0;
      const tp2Reached = progress.tp2Reached || reached(execution.tp2Price);
      const tp1Reached = progress.tp1Reached || tp2Reached || reached(execution.tp1Price);
      // REST readback proves the singleton is armed. It does not prove activation or
      // preserve the high-water mark through replacement; never infer those facts.
      return {
        tp1Reached,
        tp2Reached,
        trailingActivated: false,
        tp2Update: tp2Reached ? 'UNSUPPORTED_RETAINED' as const : 'NOT_REQUESTED' as const,
      };
    },

    async verifyProtection(
      scope: ExecutionScope,
      execution: LifecycleExecution,
      identifiers: ProtectionIdentifiers,
    ) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      assertLifecycleEnabled();
      assertExecution(execution);
      assertProtectionIdentifiers(scope, identifiers);
      const position = await getDetails(execution.symbol);
      if (
        Number(position.size) <= 0 ||
        position.side !== (execution.direction === 'LONG' ? 'Buy' : 'Sell') ||
        compareDecimals(position.size, execution.quantity) !== 0 ||
        position.tpslMode !== 'Full' ||
        !position.trailingStop ||
        compareDecimals(position.stopLoss || '0', execution.stopPrice) !== 0 ||
        compareDecimals(position.takeProfit || '0', execution.tp3Price) !== 0
      ) {
        return false;
      }
      const { trailingDistance } = await validateProtectionPlan(execution, position.avgPrice);
      if (compareDecimals(position.trailingStop, trailingDistance) !== 0) return false;
      const trailingStops = await client.getRealtimeTrailingStops(execution.symbol);
      if (trailingStops.length !== 1) return false;
      const [trailingStop] = trailingStops;
      return trailingStop.symbol === execution.symbol &&
        trailingStop.orderId.length > 0 &&
        trailingStop.stopOrderType === 'TrailingStop' &&
        trailingStop.positionIdx === 0 &&
        trailingStop.triggerPrice !== null &&
        compareDecimals(trailingStop.triggerPrice, execution.tp1Price) === 0 &&
        (trailingStop.tpslMode === undefined || trailingStop.tpslMode === 'Full');
    },

    async getPosition(scope: ExecutionScope, symbol: string) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      assertSymbol(symbol);
      const position = await getDetails(symbol);
      if (Number(position.size) === 0) return { amount: '0' };
      return {
        amount: position.side === 'Buy' ? position.size : `-${position.size}`,
      };
    },

    async closePositionAndVerify(scope: ExecutionScope, execution: LifecycleExecution) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      assertLifecycleEnabled();
      assertExecution(execution);
      let position = await getDetails(execution.symbol);
      if (Number(position.size) === 0) return { closed: true };
      if (
        position.side !== (execution.direction === 'LONG' ? 'Buy' : 'Sell') ||
        compareDecimals(position.size, execution.quantity) > 0
      ) {
        return { closed: false, reason: 'Bybit Demo position direction or quantity does not match the execution.' };
      }
      const baseId = execution.closeClientOrderId || `admclose${scope.executionId}`.slice(0, 36);
      if (!/^[A-Za-z0-9_-]{1,36}$/.test(baseId)) throw new Error('Invalid Bybit Demo close idempotency key.');
      let clientOrderId = baseId;
      let availableAttempt = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        clientOrderId = attempt === 0 ? baseId
          : `admclr${createHash('sha256').update(baseId).digest('hex').slice(0, 24)}-${attempt}`;
        const prior = await client.reconcileOrder(execution.symbol, clientOrderId);
        if (!prior) { availableAttempt = true; break; }
        if (prior.symbol !== execution.symbol || prior.clientOrderId !== clientOrderId ||
            prior.side !== (execution.direction === 'LONG' ? 'SELL' : 'BUY') ||
            prior.type.toUpperCase() !== 'MARKET' ||
            compareDecimals(prior.quantity, execution.quantity) > 0) {
          return { closed: false, reason: 'Bybit close key belongs to a different order; protection retained.' };
        }
        // A terminal order must be established before allocating a replacement ID.
        // Working/unknown/partially-filled orders never permit another close order.
        if (!['Filled', 'Cancelled', 'Canceled', 'Rejected', 'Deactivated', 'Expired',
          'PartiallyFilledCanceled'].includes(prior.status)) {
          return { closed: false, reason: 'Prior close is working or uncertain; reconcile before replacement.' };
        }
      }
      if (!availableAttempt) return { closed: false, reason: 'Bounded close attempts exhausted; operator review required.' };
      // Quantity can change while an earlier close is reconciled. Use a fresh
      // signed position observation, never the original requested quantity.
      position = await getDetails(execution.symbol);
      if (Number(position.size) === 0) return { closed: true };
      if (position.side !== (execution.direction === 'LONG' ? 'Buy' : 'Sell') ||
          compareDecimals(position.size, execution.quantity) > 0) {
        return { closed: false, reason: 'Remaining position exceeds the authorized execution; operator review required.' };
      }
      let orderError: unknown;
      try {
        await beforeMutation(scope);
        const order = await client.placeMarketOrder({
          symbol: execution.symbol,
          side: execution.direction === 'LONG' ? 'SELL' : 'BUY',
          quantity: position.size,
          clientOrderId,
          reduceOnly: true,
        });
        if (order.clientOrderId && order.clientOrderId !== clientOrderId) {
          return { closed: false, reason: 'Bybit Demo close order did not match its idempotency key.' };
        }
      } catch (error) {
        orderError = error;
      }
      let after: Awaited<ReturnType<typeof getDetails>>;
      try {
        after = await getDetails(execution.symbol);
      } catch (verificationError) {
        if (orderError) {
          throw new AggregateError(
            [orderError, verificationError],
            'Bybit Demo close outcome is uncertain and the position could not be verified.',
            { cause: orderError },
          );
        }
        throw verificationError;
      }
      if (Number(after.size) === 0) return { closed: true };
      if (orderError) throw orderError;
      return { closed: false, reason: 'Bybit Demo has not confirmed a zero position after reduce-only close.' };
    },

    async cancelObsoleteProtection(
      scope: ExecutionScope,
      execution: LifecycleExecution,
      identifiers: ProtectionIdentifiers,
    ) {
      assertAdminDemoScope(scope, credentials.testAccountId);
      assertLifecycleEnabled();
      assertExecution(execution);
      assertProtectionIdentifiers(scope, identifiers);
      let position = await getDetails(execution.symbol);
      if (Number(position.size) !== 0) {
        throw new Error('Bybit Demo protection cleanup requires a confirmed zero position.');
      }
      const hasProtection = (row: typeof position) =>
        [row.stopLoss, row.takeProfit, row.trailingStop].some((value) =>
          value !== undefined && value !== '' && Number(value) !== 0);
      if (hasProtection(position)) {
        await beforeMutation(scope);
        await client.clearPositionProtection(execution.symbol);
        position = await getDetails(execution.symbol);
        if (Number(position.size) !== 0 || hasProtection(position)) {
          throw new Error('Bybit Demo stale protection cleanup could not be verified.');
        }
      }
      if ((await client.getRealtimeTrailingStops(execution.symbol)).length !== 0) {
        throw new Error('Bybit Demo zero position is confirmed but remaining trailing orders require reconciliation.');
      }
    },
  }, {
    environment: 'DEMO' as const,
    baseUrl: BYBIT_DEMO_BASE_URL,
  });
}

export const BYBIT_DEMO_LIFECYCLE_DOCUMENTATION = {
  demoDomain: 'https://bybit-exchange.github.io/docs/v5/demo',
  tradingStop: 'https://bybit-exchange.github.io/docs/v5/position/trading-stop',
} as const;
