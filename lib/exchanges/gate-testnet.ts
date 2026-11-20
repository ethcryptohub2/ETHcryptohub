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

function orderQuantities(size: string, left: string) {
  const quantity = size.replace(/^-/, '');
  const remaining = left.replace(/^-/, '');
  const [quantityWhole, quantityFraction = ''] = quantity.split('.');
  const [remainingWhole, remainingFraction = ''] = remaining.split('.');
  const scale = Math.max(quantityFraction.length, remainingFraction.length);
  const total = BigInt(quantityWhole + quantityFraction.padEnd(scale, '0'));
  const unfilled = BigInt(remainingWhole + remainingFraction.padEnd(scale, '0'));
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
  method: 'GET',
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
};

export function createGateTestnetAdapter(
  credentials: ExchangeCredentials,
  environment: ExchangeEnvironment = 'TESTNET',
  transport?: typeof fetch,
): GateTestnetAdapter {
  if (environment !== 'TESTNET') {
    throw new GateTestnetError('Gate adapter is pinned to TESTNET; Live and Demo environments are unavailable.', 422);
  }
  if (typeof credentials?.apiKey !== 'string' || !credentials.apiKey.trim() ||
      typeof credentials?.apiSecret !== 'string' || !credentials.apiSecret.trim()) {
    throw new GateTestnetError('Gate Futures Testnet API key and secret are required.', 422);
  }

  async function request(
    path: string,
    params: Record<string, string> = {},
    privateRequest = true,
    isOrderLookup = false,
  ) {
    const queryString = sortedQuery(params);
    const requestPath = `/api/v4${path}`;
    const url = `${GATE_FUTURES_TESTNET_REST_URL}${path}${queryString ? `?${queryString}` : ''}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (isOrderLookup) headers['X-Gate-Size-Decimal'] = '1';
    if (privateRequest) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      headers.KEY = credentials.apiKey;
      headers.Timestamp = timestamp;
      headers.SIGN = signGateTestnetRequest(
        credentials.apiSecret,
        'GET',
        requestPath,
        queryString,
        timestamp,
      );
    }

    let response: Response;
    try {
      response = await (transport ?? fetch)(url, {
        method: 'GET',
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
      if (isOrderLookup && response.status === 404) {
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

  async function lookupOrder(
    symbol: string,
    identifier: string,
    kind: 'id' | 'text',
  ): Promise<GateTestnetOrder | null> {
    if (!transport || transport === fetch) {
      throw new GateTestnetError('Gate Futures Testnet remote order lookup is disabled.', 501);
    }
    const idSchema = kind === 'id' ? exchangeOrderId : clientOrderId;
    if (!futuresSymbol.safeParse(symbol).success || !idSchema.safeParse(identifier).success) {
      throw new GateTestnetError('Invalid Gate Futures Testnet contract or order identifier.', 422);
    }
    const data = await request(`/futures/${SETTLE_CURRENCY}/orders/${identifier}`, {}, true, true);
    if (data === orderNotFound) return null;
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
  };
}
