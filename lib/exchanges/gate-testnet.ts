import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import type {
  ExchangeBalance,
  ExchangeCredentials,
  ExchangeEnvironment,
  ExchangeInstrument,
  ExchangeOrder,
  ExchangePosition,
} from './types';

const GATE_FUTURES_TESTNET_REST_URL = 'https://api-testnet.gateapi.io/api/v4';
const SETTLE_CURRENCY = 'usdt';
const REQUEST_TIMEOUT_MS = 10_000;
const orderNotFound = Symbol('Gate order not found');
type GateOrderRequestMethod = 'GET' | 'DELETE' | 'POST';

export const GATE_TESTNET_DOCUMENTATION_URL = 'https://www.gate.com/docs/developers/apiv4/en/';
export const GATE_TESTNET_ACCESS_URL_DOCUMENTATION =
  'https://www.gate.com/docs/developers/apiv4/en/#access-url';
export const GATE_TESTNET_AUTH_DOCUMENTATION =
  'https://www.gate.com/docs/developers/apiv4/en/#authentication';

const numericValue = z.union([z.string(), z.number()]).transform(String);

const accountSchema = z.object({
  currency: z.string(),
  total: numericValue,
  available: numericValue,
  unrealised_pnl: numericValue,
  in_dual_mode: z.boolean().optional(),
});

const contractSchema = z.object({
  name: z.string(),
  type: z.string(),
  order_price_round: numericValue,
  order_size_min: numericValue,
  order_size_max: numericValue.optional(),
  quanto_multiplier: numericValue,
  leverage_max: numericValue.optional(),
  trade_status: z.string().optional(),
  in_delisting: z.boolean().optional(),
  enable_decimal: z.boolean().optional(),
});

const positionSchema = z.object({
  contract: z.string(),
  size: numericValue,
  mode: z.string().optional(),
  entry_price: numericValue,
  mark_price: numericValue.optional(),
  unrealised_pnl: numericValue,
  leverage: numericValue.optional(),
});

const futuresSymbol = z.string().regex(/^[A-Z0-9]{1,24}_USDT$/);
const exchangeOrderId = z.string().regex(/^[1-9]\d{0,18}$/);
const clientOrderId = z.string().regex(/^t-[A-Za-z0-9_.-]{1,28}$/);
const decimal = z.string().regex(/^-?\d{1,30}(?:\.\d{1,30})?$/);
const fixtureEntrySchema = z.object({
  symbol: futuresSymbol,
  side: z.enum(['BUY', 'SELL']),
  quantity: decimal,
  price: decimal,
  clientOrderId,
}).strict();
const fixtureStopSchema = z.object({
  symbol: futuresSymbol,
  triggerOrderId: exchangeOrderId,
  positionSide: z.enum(['LONG', 'SHORT']),
  triggerPrice: decimal,
}).strict();
const priceOrderFixtureSchema = z.object({
  id: exchangeOrderId,
  status: z.literal('open'),
  initial: z.object({ contract: futuresSymbol, close: z.literal(true), reduce_only: z.literal(true),
    size: numericValue.pipe(decimal), price: decimal }),
  trigger: z.object({ strategy_type: z.literal(0), price_type: z.literal(1),
    rule: z.union([z.literal(1), z.literal(2)]), price: decimal }),
});
const orderSchema = z.object({
  id: exchangeOrderId,
  contract: futuresSymbol,
  size: decimal,
  left: decimal,
  price: decimal,
  text: z.string().max(64).optional(),
  tif: z.enum(['gtc', 'ioc', 'poc', 'fok']),
  status: z.enum(['open', 'finished']),
  finish_as: z.enum([
    '', 'filled', 'cancelled', 'liquidated', 'ioc', 'auto_deleveraged',
    'reduce_only', 'position_closed', 'reduce_out', 'stp',
  ]).optional(),
  is_reduce_only: z.boolean().optional(),
});

type GateTestnetOrder = ExchangeOrder & {
  finishReason: string | null;
  reduceOnly: boolean | null;
};

function scaledAmounts(left: string, right: string) {
  const [leftWhole, leftFraction = ''] = left.split('.');
  const [rightWhole, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  return [
    BigInt(leftWhole + leftFraction.padEnd(scale, '0')),
    BigInt(rightWhole + rightFraction.padEnd(scale, '0')),
    scale,
  ] as const;
}

function compareAmounts(left: string, right: string) {
  const [leftValue, rightValue] = scaledAmounts(left, right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function orderQuantities(size: string, left: string) {
  const quantity = size.replace(/^-/, '');
  const remaining = left.replace(/^-/, '');
  const [total, unfilled, scale] = scaledAmounts(quantity, remaining);
  if (total === 0n || unfilled > total) {
    throw new GateTestnetError('Gate Futures Testnet returned inconsistent signed order quantities.', 502);
  }
  const digits = String(total - unfilled).padStart(scale + 1, '0');
  return {
    quantity,
    filled: scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits,
    fullyFilled: unfilled === 0n,
    partiallyFilled: unfilled > 0n && unfilled < total,
  };
}

export class GateTestnetError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'GateTestnetError';
  }
}

export const GATE_TESTNET_CAPABILITIES = Object.freeze({
  connectionTest: true,
  balance: true,
  instruments: true,
  positions: true,
  entryPreflight: false,
  marketEntry: false,
  limitEntry: false,
  stopLossProtection: false,
  takeProfitProtection: false,
  trailingProtection: false,
  reduceOnlyClose: false,
  reconciliation: false,
  adminLifecycle: false,
});

export const GATE_TESTNET_UNSUPPORTED_CAPABILITIES = Object.freeze([
  'entryPreflight',
  'marketEntry',
  'limitEntry',
  'stopLossProtection',
  'takeProfitProtection',
  'trailingProtection',
  'reduceOnlyClose',
  'reconciliation',
  'adminLifecycle',
] as const);

function sortedQuery(params: Record<string, string>) {
  return new URLSearchParams(
    Object.entries(params).sort(([left], [right]) => left.localeCompare(right)),
  ).toString();
}

export function signGateTestnetRequest(
  apiSecret: string,
  method: GateOrderRequestMethod,
  requestPath: string,
  queryString: string,
  timestamp: string,
  body = '',
) {
  const payloadHash = createHash('sha512').update(body).digest('hex');
  const preimage = `${method}\n${requestPath}\n${queryString}\n${payloadHash}\n${timestamp}`;
  return createHmac('sha512', apiSecret).update(preimage).digest('hex');
}

function positionSide(mode: string | undefined, size: string): 'LONG' | 'SHORT' | null {
  if (mode === 'dual_long') return 'LONG';
  if (mode === 'dual_short') return 'SHORT';
  const numericSize = Number(size);
  if (!Number.isFinite(numericSize) || numericSize === 0) return null;
  return numericSize > 0 ? 'LONG' : 'SHORT';
}

export type GateTestnetAdapter = {
  exchange: 'GATE';
  environment: 'TESTNET';
  capabilities: typeof GATE_TESTNET_CAPABILITIES;
  unsupportedCapabilities: typeof GATE_TESTNET_UNSUPPORTED_CAPABILITIES;
  testConnection(): Promise<void>;
  getAccountBalance(): Promise<ExchangeBalance[]>;
  getMarketInstruments(): Promise<ExchangeInstrument[]>;
  getPositions(): Promise<ExchangePosition[]>;
  getOrderStatus(symbol: string, orderId: string): Promise<GateTestnetOrder | null>;
  reconcileOrder(symbol: string, clientOrderId: string): Promise<GateTestnetOrder | null>;
  cancelOrder?: (symbol: string, orderId: string) => Promise<GateTestnetOrder>;
  placeFixtureLimitOrder?: (order: z.infer<typeof fixtureEntrySchema>) => Promise<GateTestnetOrder>;
  verifyFixtureStop?: (order: z.infer<typeof fixtureStopSchema>) => Promise<void>;
};

export function createGateTestnetAdapter(
  credentials: ExchangeCredentials,
  environment: ExchangeEnvironment = 'TESTNET',
  transport?: typeof fetch,
  fixtureMode?: 'MOCK_CANCELLATION' | 'MOCK_LIMIT_LIFECYCLE' | 'MOCK_PROTECTION_READBACK',
): GateTestnetAdapter {
  if (environment !== 'TESTNET') {
    throw new GateTestnetError('Gate adapter is pinned to TESTNET; Live and Demo environments are unavailable.', 422);
  }
  if (typeof credentials?.apiKey !== 'string' || !credentials.apiKey.trim() ||
      typeof credentials?.apiSecret !== 'string' || !credentials.apiSecret.trim()) {
    throw new GateTestnetError('Gate Futures Testnet API key and secret are required.', 422);
  }
  if (fixtureMode !== undefined && (
    !['MOCK_CANCELLATION', 'MOCK_LIMIT_LIFECYCLE', 'MOCK_PROTECTION_READBACK'].includes(fixtureMode) ||
    !transport || transport === fetch ||
    ![credentials.apiKey, credentials.apiSecret].every((value) => /^fixture-[a-z0-9-]{1,60}$/.test(value))
  )) {
    throw new GateTestnetError('Gate Futures Testnet mock orders require synthetic credentials and an injected transport.', 422);
  }
  const attemptedCancellations = new Set<string>();
  const attemptedEntries = new Set<string>();

  async function request(
    path: string,
    params: Record<string, string> = {},
    privateRequest = true,
    isOrderLookup = false,
    method: GateOrderRequestMethod = 'GET',
    body?: string,
    decimalSize = isOrderLookup,
  ) {
    const queryString = sortedQuery(params);
    const requestPath = `/api/v4${path}`;
    const url = `${GATE_FUTURES_TESTNET_REST_URL}${path}${queryString ? `?${queryString}` : ''}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (decimalSize) headers['X-Gate-Size-Decimal'] = '1';
    if (privateRequest) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      headers.KEY = credentials.apiKey;
      headers.Timestamp = timestamp;
      headers.SIGN = signGateTestnetRequest(
        credentials.apiSecret,
        method,
        requestPath,
        queryString,
        timestamp,
        body,
      );
    }

    let response: Response;
    try {
      response = await (transport ?? fetch)(url, {
        method,
        body,
        headers,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GateTestnetError('Gate Futures Testnet request failed or timed out.', 503);
    }
    if (response.redirected) {
      throw new GateTestnetError('Gate Futures Testnet rejected a redirected response.', 502);
    }
    if (!response.ok) {
      if (isOrderLookup && method === 'GET' && response.status === 404) {
        const error = z.object({ label: z.literal('ORDER_NOT_FOUND') })
          .safeParse(await response.json().catch(() => null));
        if (error.success) return orderNotFound;
      }
      throw new GateTestnetError(
        `Gate Futures Testnet returned HTTP ${response.status}.`,
        response.status === 429 ? 429 : 502,
      );
    }
    try {
      if (isOrderLookup) {
        // Gate returns int64 order IDs. Recover their original digits before schema validation.
        return JSON.parse(await response.text(), (key, value, context?: { source?: string }) => {
          if (key !== 'id' || typeof value !== 'number') return value;
          return context?.source ?? (Number.isSafeInteger(value) ? String(value) : value);
        }) as unknown;
      }
      return await response.json() as unknown;
    } catch {
      throw new GateTestnetError('Gate Futures Testnet returned invalid JSON.', 502);
    }
  }

  async function getAccount() {
    const data = await request(`/futures/${SETTLE_CURRENCY}/accounts`);
    const parsed = accountSchema.safeParse(data);
    if (!parsed.success) throw new GateTestnetError('Gate Futures Testnet returned invalid account data.', 502);
    return parsed.data;
  }

  async function verifyFixtureStop(input: z.infer<typeof fixtureStopSchema>) {
    const scope = fixtureStopSchema.safeParse(input);
    if (!scope.success || compareAmounts(scope.data.triggerPrice, '0') <= 0) {
      throw new GateTestnetError('Invalid Gate Testnet stop fixture scope.', 422);
    }
    const { symbol, triggerOrderId, positionSide, triggerPrice } = scope.data;
    const result = priceOrderFixtureSchema.safeParse(await request(
      `/futures/${SETTLE_CURRENCY}/price_orders/${triggerOrderId}`, {}, true, true,
    ));
    if (!result.success || result.data.id !== triggerOrderId || result.data.initial.contract !== symbol ||
        compareAmounts(result.data.initial.size, '0') !== 0 || compareAmounts(result.data.initial.price, '0') !== 0 ||
        result.data.trigger.rule !== (positionSide === 'LONG' ? 2 : 1) ||
        compareAmounts(result.data.trigger.price, triggerPrice) !== 0) {
      throw new GateTestnetError('Gate fixture could not verify the requested full-position reduce-only stop.', 409);
    }
  }

  async function lookupOrder(
    symbol: string,
    identifier: string,
    kind: 'id' | 'text',
    method: GateOrderRequestMethod = 'GET',
  ): Promise<GateTestnetOrder | null> {
    if (!transport || transport === fetch) {
      throw new GateTestnetError('Gate Futures Testnet remote order lookup is disabled.', 501);
    }
    const idSchema = kind === 'id' ? exchangeOrderId : clientOrderId;
    if (!futuresSymbol.safeParse(symbol).success || !idSchema.safeParse(identifier).success) {
      throw new GateTestnetError('Invalid Gate Futures Testnet contract or order identifier.', 422);
    }
    const data = await request(`/futures/${SETTLE_CURRENCY}/orders/${identifier}`, {}, true, true, method);
    if (data === orderNotFound) return null;
    return decodeOrder(data, symbol, identifier, kind);
  }

  function decodeOrder(data: unknown, symbol: string, identifier: string, kind: 'id' | 'text'): GateTestnetOrder {
    const parsed = orderSchema.safeParse(data);
    if (!parsed.success || parsed.data.contract !== symbol || parsed.data[kind] !== identifier) {
      throw new GateTestnetError('Gate Futures Testnet order response could not be matched to the request.', 502);
    }
    const order = parsed.data;
    const { quantity, filled, fullyFilled, partiallyFilled } = orderQuantities(order.size, order.left);
    const price = Number(order.price);
    if (price < 0 || (price === 0 && order.tif !== 'ioc') ||
        (order.status === 'finished' && (!order.finish_as || (order.finish_as === 'filled') !== fullyFilled)) ||
        (order.status === 'open' && (fullyFilled || order.finish_as))) {
      throw new GateTestnetError('Gate Futures Testnet returned inconsistent order status or pricing.', 502);
    }
    return {
      symbol,
      exchangeOrderId: order.id,
      clientOrderId: order.text && clientOrderId.safeParse(order.text).success ? order.text : null,
      side: order.size.startsWith('-') ? 'SELL' : 'BUY',
      type: price === 0 ? 'MARKET' : 'LIMIT',
      status: order.status === 'open'
        ? (partiallyFilled ? 'PARTIALLY_FILLED' : 'OPEN')
        : order.finish_as!.toUpperCase(),
      quantity,
      filledQuantity: filled,
      price: price === 0 ? null : order.price,
      finishReason: order.finish_as || null,
      reduceOnly: order.is_reduce_only ?? null,
    };
  }

  async function placeFixtureLimitOrder(input: z.infer<typeof fixtureEntrySchema>) {
    const parsed = fixtureEntrySchema.safeParse(input);
    if (!parsed.success || compareAmounts(parsed.data.quantity, '0') <= 0 || compareAmounts(parsed.data.price, '0') <= 0) {
      throw new GateTestnetError('Invalid Gate Futures Testnet mock limit-entry intent.', 422);
    }
    const { symbol, side, quantity, price, clientOrderId: clientId } = parsed.data;
    const matches = (order: GateTestnetOrder | null): order is GateTestnetOrder => !!order &&
      order.clientOrderId === clientId && order.side === side && order.type === 'LIMIT' &&
      order.reduceOnly === false && order.price !== null && compareAmounts(order.price, price) === 0 &&
      compareAmounts(order.quantity, quantity) === 0;
    const existing = await lookupOrder(symbol, clientId, 'text');
    if (existing) {
      if (!matches(existing)) throw new GateTestnetError('Gate Futures Testnet mock limit-entry replay conflicts with the original intent.', 409);
      return existing;
    }
    if (attemptedEntries.has(clientId)) {
      throw new GateTestnetError('Gate Futures Testnet mock entry was already attempted. Reconcile the original order.', 409);
    }
    const account = await getAccount();
    if (account.currency !== 'USDT' || account.in_dual_mode !== false) {
      throw new GateTestnetError('Gate Futures Testnet mock limit entry requires an explicitly verified one-way USDT account.', 409);
    }
    const contract = contractSchema.safeParse(await request(
      `/futures/${SETTLE_CURRENCY}/contracts/${symbol}`, {}, false, false, 'GET', undefined, true,
    ));
    if (!contract.success || contract.data.name !== symbol || contract.data.in_delisting !== false ||
        contract.data.trade_status !== 'tradable' ||
        !decimal.safeParse(contract.data.order_price_round).success ||
        !decimal.safeParse(contract.data.order_size_min).success || !decimal.safeParse(contract.data.order_size_max).success) {
      throw new GateTestnetError('Gate Futures Testnet mock contract limits are unavailable.', 409);
    }
    const [priceUnits, tick] = scaledAmounts(price, contract.data.order_price_round);
    if (tick <= 0n || priceUnits % tick !== 0n ||
        compareAmounts(quantity, contract.data.order_size_min) < 0 ||
        compareAmounts(quantity, contract.data.order_size_max!) > 0 ||
        (contract.data.enable_decimal !== true && !/^\d+$/.test(quantity))) {
      throw new GateTestnetError('Gate Futures Testnet mock order violates contract bounds or precision.', 422);
    }
    // The Set check after awaiting metadata is the in-instance dispatch fence for parallel fixture submissions.
    if (attemptedEntries.has(clientId)) throw new GateTestnetError('Gate Futures Testnet mock entry was already attempted.', 409);
    attemptedEntries.add(clientId);
    const body = JSON.stringify({
      contract: symbol, size: side === 'SELL' ? `-${quantity}` : quantity, price,
      tif: 'gtc', text: clientId, reduce_only: false,
    });
    try {
      const acknowledged = decodeOrder(await request(
        `/futures/${SETTLE_CURRENCY}/orders`, {}, true, true, 'POST', body,
      ), symbol, clientId, 'text');
      const confirmed = await lookupOrder(symbol, acknowledged.exchangeOrderId, 'id');
      if (matches(acknowledged) && matches(confirmed) && compareAmounts(confirmed.filledQuantity, acknowledged.filledQuantity) >= 0) {
        return confirmed;
      }
    } catch (error) {
      throw new GateTestnetError('Gate Futures Testnet mock entry could not be confirmed. Reconcile the original order.',
        error instanceof GateTestnetError ? error.status : 502);
    }
    throw new GateTestnetError('Gate Futures Testnet mock entry lacked matching evidence. Reconcile the original order.', 409);
  }

  async function cancelOrder(symbol: string, orderId: string): Promise<GateTestnetOrder> {
    const original = await lookupOrder(symbol, orderId, 'id');
    if (original?.finishReason === 'cancelled') return original;
    if (!original || !['OPEN', 'PARTIALLY_FILLED'].includes(original.status)) {
      throw new GateTestnetError('Gate Futures Testnet cancellation requires a confirmed open order.', 409);
    }
    const identity = `${symbol}:${orderId}`;
    if (attemptedCancellations.has(identity)) {
      throw new GateTestnetError('Gate Futures Testnet already attempted cancellation. Reconcile the original order.', 409);
    }
    attemptedCancellations.add(identity);
    let acknowledged: GateTestnetOrder | null;
    try {
      acknowledged = await lookupOrder(symbol, orderId, 'id', 'DELETE');
    } catch (error) {
      throw new GateTestnetError(
        'Gate Futures Testnet cancellation could not be confirmed. Reconcile the original order.',
        error instanceof GateTestnetError ? error.status : 502,
      );
    }
    const reconciled = await lookupOrder(symbol, orderId, 'id');
    const consistentlyCancelled = (candidate: GateTestnetOrder | null): candidate is GateTestnetOrder => !!candidate &&
      candidate.finishReason === 'cancelled' && candidate.clientOrderId === original.clientOrderId &&
      candidate.side === original.side && candidate.type === original.type &&
      candidate.reduceOnly === original.reduceOnly &&
      compareAmounts(candidate.quantity, original.quantity) === 0 &&
      compareAmounts(candidate.filledQuantity, original.filledQuantity) >= 0;
    if (!consistentlyCancelled(acknowledged) || !consistentlyCancelled(reconciled) ||
        compareAmounts(reconciled.filledQuantity, acknowledged.filledQuantity) !== 0) {
      throw new GateTestnetError('Gate Futures Testnet cancellation lacks consistent terminal status. Reconcile the original order.', 409);
    }
    return reconciled;
  }

  return {
    exchange: 'GATE',
    environment: 'TESTNET',
    capabilities: GATE_TESTNET_CAPABILITIES,
    unsupportedCapabilities: GATE_TESTNET_UNSUPPORTED_CAPABILITIES,

    async testConnection() {
      await getAccount();
    },

    async getAccountBalance() {
      const account = await getAccount();
      return [{
        asset: account.currency,
        walletBalance: account.total,
        availableBalance: account.available,
        unrealizedPnl: account.unrealised_pnl,
      }];
    },

    async getMarketInstruments() {
      const data = await request(`/futures/${SETTLE_CURRENCY}/contracts`, {}, false);
      const parsed = z.array(contractSchema).safeParse(data);
      if (!parsed.success) throw new GateTestnetError('Gate Futures Testnet returned invalid futures contracts.', 502);
      return parsed.data.map((contract) => ({
        exchangeSymbol: contract.name,
        smartExitSymbol: contract.name,
        contractType: /[_-]\d{8}$/.test(contract.name) ? 'OTHER' : 'PERPETUAL',
        quoteAsset: 'USDT',
        status: contract.trade_status ?? (contract.in_delisting ? 'delisting' : 'tradable'),
        tickSize: contract.order_price_round,
        quantityStep: contract.enable_decimal ? contract.order_size_min : '1',
        minimumQuantity: contract.order_size_min,
        maximumQuantity: contract.order_size_max ?? null,
        minimumNotional: null,
        contractSize: contract.quanto_multiplier,
        maximumLeverage: contract.leverage_max ? Number(contract.leverage_max) : null,
      }));
    },

    async getPositions() {
      const data = await request(`/futures/${SETTLE_CURRENCY}/positions`);
      const parsed = z.array(positionSchema).safeParse(data);
      if (!parsed.success) throw new GateTestnetError('Gate Futures Testnet returned invalid position data.', 502);
      return parsed.data.flatMap((position) => {
        const side = positionSide(position.mode, position.size);
        if (!side) return [];
        const quantity = position.size.startsWith('-') ? position.size.slice(1) : position.size;
        return [{
          symbol: position.contract,
          side,
          quantity,
          entryPrice: position.entry_price,
          markPrice: position.mark_price ?? null,
          unrealizedPnl: position.unrealised_pnl,
          leverage: position.leverage ? Number(position.leverage) : null,
        }];
      });
    },

    getOrderStatus: (symbol, orderId) => lookupOrder(symbol, orderId, 'id'),
    // Gate's lookup retention can hide a cancelled order. Never treat null as safe to resubmit.
    reconcileOrder: (symbol, orderId) => lookupOrder(symbol, orderId, 'text'),
    ...(fixtureMode === 'MOCK_CANCELLATION' || fixtureMode === 'MOCK_LIMIT_LIFECYCLE' ? { cancelOrder } : {}),
    ...(fixtureMode === 'MOCK_LIMIT_LIFECYCLE' ? { placeFixtureLimitOrder } : {}),
    ...(fixtureMode === 'MOCK_PROTECTION_READBACK' ? { verifyFixtureStop } : {}),
  };
}
