import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type {
  ExchangeBalance,
  ExchangeCredentials,
  ExchangeEnvironment,
  ExchangeOrder,
  ExchangePosition,
} from './types';

export const BITGET_DEMO_REST_URL = 'https://api.bitget.com';
export const BITGET_DEMO_DOCUMENTATION_URL = 'https://www.bitget.com/docs/uta/quick-start.md';

export const BITGET_DEMO_CAPABILITIES = Object.freeze({
  connectionTest: false,
  balance: false,
  instruments: false,
  positions: false,
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

export const BITGET_DEMO_UNSUPPORTED_CAPABILITIES = Object.freeze([
  'connectionTest',
  'balance',
  'instruments',
  'positions',
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

export class BitgetDemoError extends Error {
  constructor(message: string, readonly status = 503, readonly code?: 'ORDER_NOT_FOUND') {
    super(message);
    this.name = 'BitgetDemoError';
  }
}

export function signBitgetDemoRequest(
  apiSecret: string,
  timestamp: string,
  method: 'GET' | 'POST',
  requestPath: string,
  queryString = '',
  body = '',
) {
  const preimage = `${timestamp}${method}${requestPath}${queryString ? `?${queryString}` : ''}${body}`;
  return createHmac('sha256', apiSecret).update(preimage).digest('base64');
}

export function createBitgetDemoAdapter(environment: ExchangeEnvironment = 'DEMO') {
  const environmentName = environment === 'DEMO'
    ? 'Demo'
    : environment === 'TESTNET'
      ? 'Testnet'
      : 'Live';
  throw new BitgetDemoError(
    `Bitget ${environmentName} remote integration is blocked pending approved account and endpoint verification. No requests are enabled.`,
  );
}

const category = 'USDT-FUTURES';
const decimal = z.string().regex(/^-?\d{1,30}(?:\.\d{1,30})?$/);
const positive = decimal.refine((value) => Number(value) > 0);
const nonnegative = decimal.refine((value) => Number(value) >= 0);
const symbol = z.string().regex(/^[A-Z0-9]{1,24}USDT$/);
const asset = z.string().regex(/^[A-Z0-9]{1,24}$/);
const orderId = z.string().regex(/^\d{1,32}$/);
const clientOrderId = z.string().regex(/^[A-Za-z0-9_:# +\-]{1,32}$/);
const balanceResponse = z.object({
  assets: z.array(z.object({
    coin: asset,
    balance: decimal,
    available: decimal,
    equity: decimal,
  })).max(500),
});
const instrumentsResponse = z.array(z.object({
  category: z.literal(category),
  symbol,
  quoteCoin: z.literal('USDT'),
  type: z.literal('perpetual'),
  status: z.string().min(1).max(32),
  priceMultiplier: positive,
  quantityMultiplier: positive,
  minOrderQty: positive,
  maxOrderQty: nonnegative,
  minOrderAmount: nonnegative,
})).max(1000);
const positionsResponse = z.object({
  list: z.array(z.object({
    category: z.literal(category),
    symbol,
    posSide: z.enum(['long', 'short']),
    holdMode: z.enum(['one_way_mode', 'hedge_mode']),
    total: nonnegative,
    avgPrice: positive,
    markPrice: positive,
    unrealisedPnl: decimal,
    leverage: positive,
  })).max(500),
});
const orderResponse = z.object({
  category: z.literal(category),
  symbol,
  orderId,
  clientOid: z.string().max(128),
  side: z.enum(['buy', 'sell']),
  orderType: z.enum(['limit', 'market']),
  orderStatus: z.enum(['live', 'new', 'partially_filled', 'filled', 'cancelled']),
  qty: positive,
  cumExecQty: nonnegative,
  price: z.union([nonnegative, z.literal('')]),
});
const cancellationResponse = z.object({ orderId, clientOid: z.string().max(128) });

function compareAmounts(left: string, right: string) {
  const [leftInteger, leftFraction = ''] = left.split('.');
  const [rightInteger, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftUnits = BigInt(leftInteger + leftFraction.padEnd(scale, '0'));
  const rightUnits = BigInt(rightInteger + rightFraction.padEnd(scale, '0'));
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

const BITGET_FIXTURE_ROUTES = {
  balance: '/api/v3/account/assets',
  instruments: '/api/v3/market/instruments',
  positions: '/api/v3/position/current-position',
  order: '/api/v3/trade/order-info',
  cancel: '/api/v3/trade/cancel-order',
} as const;

type FixtureRequest = Readonly<{
  origin: typeof BITGET_DEMO_REST_URL;
  method: 'GET' | 'POST';
  path: (typeof BITGET_FIXTURE_ROUTES)[keyof typeof BITGET_FIXTURE_ROUTES];
  query: string;
  body?: string;
  headers: Readonly<Record<string, string>>;
}>;

/** The fixture callback has no default transport. Only synthetic credentials are accepted. */
export function createBitgetDemoFixtureAdapter(
  credentials: ExchangeCredentials & { environment: ExchangeEnvironment },
  options: {
    mode: 'MOCK_READY';
    respond: (fixture: FixtureRequest) => Promise<{ status: number; body: unknown }>;
    now: () => number;
  },
) {
  if (
    credentials?.environment !== 'DEMO' || options?.mode !== 'MOCK_READY' ||
    typeof options.respond !== 'function' || typeof options.now !== 'function' ||
    ![credentials.apiKey, credentials.apiSecret, credentials.passphrase].every(
      (value) => typeof value === 'string' && /^fixture-[a-z0-9-]{1,60}$/.test(value),
    )
  ) {
    throw new BitgetDemoError('Bitget fixtures require Demo mode and synthetic credentials.', 400);
  }
  const { apiKey, apiSecret, passphrase } = credentials;
  const { respond, now } = options;
  const attemptedCancellations = new Set<string>();

  async function request<T>(
    route: keyof typeof BITGET_FIXTURE_ROUTES,
    query: string,
    schema: z.ZodType<T>,
    body?: string,
  ): Promise<T> {
    const clock = now();
    if (!Number.isSafeInteger(clock) || clock <= 0) {
      throw new BitgetDemoError('Invalid Bitget fixture timestamp.', 400);
    }
    const path = BITGET_FIXTURE_ROUTES[route];
    const timestamp = String(clock);
    const method = route === 'cancel' ? 'POST' : 'GET';
    let response: Awaited<ReturnType<typeof respond>>;
    try {
      response = await respond({
        origin: BITGET_DEMO_REST_URL,
        method,
        path,
        query,
        ...(body !== undefined ? { body } : {}),
        headers: {
          'ACCESS-KEY': apiKey,
          'ACCESS-PASSPHRASE': passphrase!,
          'ACCESS-SIGN': signBitgetDemoRequest(apiSecret, timestamp, method, path, query, body),
          'ACCESS-TIMESTAMP': timestamp,
          paptrading: '1',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch {
      throw new BitgetDemoError('Bitget fixture transport failed.', 502);
    }
    if (response?.status !== 200) {
      throw new BitgetDemoError('Bitget fixture HTTP request failed.', response?.status === 429 ? 429 : 502);
    }
    const envelope = z.object({ code: z.literal('00000'), data: schema }).safeParse(response.body);
    if (!envelope.success) {
      const absence = z.object({ code: z.literal('25204') }).safeParse(response.body);
      if (route === 'order' && absence.success) {
        throw new BitgetDemoError('Bitget could not find the requested order.', 404, 'ORDER_NOT_FOUND');
      }
      throw new BitgetDemoError('Bitget fixture returned a provider error or invalid response.', 502);
    }
    return envelope.data.data;
  }

  async function lookupOrder(
    expectedSymbol: string,
    identifier: string,
    kind: 'orderId' | 'clientOid',
  ): Promise<ExchangeOrder> {
    const idSchema = kind === 'orderId' ? orderId : clientOrderId;
    if (!symbol.safeParse(expectedSymbol).success || !idSchema.safeParse(identifier).success) {
      throw new BitgetDemoError('Invalid Bitget fixture order identifiers.', 400);
    }
    const query = new URLSearchParams({ [kind]: identifier }).toString();
    const row = await request('order', query, orderResponse);
    if (row[kind] !== identifier || row.symbol !== expectedSymbol) {
      throw new BitgetDemoError('Bitget fixture order response does not match the request.', 502);
    }
    const relativeFill = compareAmounts(row.cumExecQty, row.qty);
    if (relativeFill > 0 ||
        (row.orderStatus === 'filled' && relativeFill !== 0) ||
        (row.orderStatus === 'partially_filled' &&
          (relativeFill !== -1 || compareAmounts(row.cumExecQty, '0') === 0))) {
      throw new BitgetDemoError('Bitget fixture returned inconsistent order quantities.', 502);
    }
    return {
      symbol: row.symbol,
      exchangeOrderId: row.orderId,
      clientOrderId: row.clientOid || null,
      side: row.side === 'buy' ? 'BUY' : 'SELL',
      type: row.orderType.toUpperCase(),
      status: row.orderStatus,
      quantity: row.qty,
      filledQuantity: row.cumExecQty,
      price: row.price || null,
    };
  }

  return {
    exchange: 'BITGET' as const,
    environment: 'DEMO' as const,
    readiness: 'MOCK_READY' as const,
    capabilities: Object.freeze({
      connectionTest: true,
      balance: true,
      instruments: true,
      positions: true,
      orderStatus: true,
      orderSubmission: false,
      cancellation: true,
      protection: false,
      reconciliation: true,
    }),
    async testConnection(): Promise<void> {
      await request('balance', '', balanceResponse);
    },
    async getAccountBalance(): Promise<Omit<ExchangeBalance, 'unrealizedPnl'>[]> {
      const { assets } = await request('balance', '', balanceResponse);
      return assets.map((row) => ({
        asset: row.coin,
        walletBalance: row.balance,
        availableBalance: row.available,
        equity: row.equity,
      }));
    },
    async getMarketInstruments() {
      const rows = await request('instruments', `category=${category}`, instrumentsResponse);
      return rows.map((row) => ({
        exchangeSymbol: row.symbol,
        smartExitSymbol: row.symbol,
        contractType: 'PERPETUAL' as const,
        quoteAsset: row.quoteCoin,
        status: row.status,
        tickSize: row.priceMultiplier,
        quantityStep: row.quantityMultiplier,
        minimumQuantity: row.minOrderQty,
        maximumQuantity: Number(row.maxOrderQty) === 0 ? null : row.maxOrderQty,
        minimumNotional: row.minOrderAmount,
      }));
    },
    async getPositions(): Promise<(ExchangePosition & { positionMode: string })[]> {
      const { list } = await request('positions', `category=${category}`, positionsResponse);
      return list.filter((row) => Number(row.total) > 0).map((row) => ({
        symbol: row.symbol,
        side: row.posSide === 'long' ? 'LONG' : 'SHORT',
        quantity: row.total,
        entryPrice: row.avgPrice,
        markPrice: row.markPrice,
        unrealizedPnl: row.unrealisedPnl,
        leverage: Number(row.leverage),
        positionMode: row.holdMode,
      }));
    },
    getOrderStatus: (expectedSymbol: string, id: string) => lookupOrder(expectedSymbol, id, 'orderId'),
    async cancelOrder(expectedSymbol: string, id: string): Promise<void> {
      const original = await lookupOrder(expectedSymbol, id, 'orderId');
      if (original.status === 'cancelled') return;
      if (!['live', 'new', 'partially_filled'].includes(original.status)) {
        throw new BitgetDemoError('Bitget fixture cancellation requires a confirmed open order.', 409);
      }
      if (attemptedCancellations.has(id)) {
        throw new BitgetDemoError('Bitget fixture already attempted cancellation. Reconcile the original order.', 409);
      }
      attemptedCancellations.add(id);
      try {
        const body = JSON.stringify({ orderId: id, category });
        const accepted = await request('cancel', '', cancellationResponse, body);
        if (accepted.orderId === id && (accepted.clientOid || null) === original.clientOrderId) {
          const terminal = await lookupOrder(expectedSymbol, id, 'orderId');
          if (terminal.status === 'cancelled' && terminal.clientOrderId === original.clientOrderId &&
              terminal.side === original.side && terminal.type === original.type &&
              compareAmounts(terminal.quantity, original.quantity) === 0 &&
              compareAmounts(terminal.filledQuantity, original.filledQuantity) >= 0) return;
        }
      } catch (error) {
        throw new BitgetDemoError(
          'Bitget fixture cancellation could not be confirmed. Reconcile the original order.',
          error instanceof BitgetDemoError && error.status === 429 ? 429 : 502,
        );
      }
      throw new BitgetDemoError('Bitget fixture cancellation could not be confirmed. Reconcile the original order.', 409);
    },
    async reconcileOrder(expectedSymbol: string, id: string): Promise<ExchangeOrder | null> {
      try {
        return await lookupOrder(expectedSymbol, id, 'clientOid');
      } catch (error) {
        // An absent client ID is still unresolved, including after an ambiguous submission.
        if (error instanceof BitgetDemoError && error.code === 'ORDER_NOT_FOUND') return null;
        throw error;
      }
    },
  };
}
