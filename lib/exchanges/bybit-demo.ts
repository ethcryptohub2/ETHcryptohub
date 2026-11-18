import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ExchangeBalance,
  ExchangeAdapter,
  ExchangeCredentials,
  ExchangeEnvironment,
  ExchangeInstrument,
  ExchangeOrder,
  ExchangeOrderSide,
  ExchangePosition,
  ExchangeTicker,
} from './types';

const BYBIT_DEMO_REST_URL = 'https://api-demo.bybit.com';
const RECV_WINDOW = '5000';
const REQUEST_TIMEOUT_MS = 10_000;

const envelopeSchema = z.object({
  retCode: z.number(),
  retMsg: z.string(),
  result: z.object({
    list: z.array(z.record(z.string(), z.unknown())).optional(),
    nextPageCursor: z.string().optional(),
  }).passthrough(),
}).passthrough();

const instrumentSchema = z.object({
  symbol: z.string(),
  contractType: z.string(),
  status: z.string(),
  baseCoin: z.string(),
  quoteCoin: z.string(),
  priceFilter: z.object({ tickSize: z.string() }),
  lotSizeFilter: z.object({
    qtyStep: z.string(),
    minOrderQty: z.string(),
    maxOrderQty: z.string(),
    maxMktOrderQty: z.string().optional(),
    minNotionalValue: z.string().optional(),
  }),
  leverageFilter: z.object({ maxLeverage: z.string() }).optional(),
});

const tickerSchema = z.object({
  symbol: z.string(),
  lastPrice: z.string(),
  markPrice: z.string().optional(),
});

const orderSchema = z.object({
  symbol: z.string(),
  orderId: z.string(),
  orderLinkId: z.string().optional(),
  side: z.enum(['Buy', 'Sell']),
  orderType: z.string(),
  orderStatus: z.string(),
  qty: z.string(),
  cumExecQty: z.string().optional(),
  price: z.string().optional(),
});

const positionSchema = z.object({
  symbol: z.string(),
  side: z.enum(['Buy', 'Sell', '']),
  size: z.string(),
  avgPrice: z.string(),
  markPrice: z.string().optional(),
  unrealisedPnl: z.string(),
  leverage: z.string().optional(),
});

export class BybitDemoError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly retCode: number | null = null,
  ) {
    super(message);
    this.name = 'BybitDemoError';
  }
}

function assertSymbol(symbol: string) {
  if (!/^[A-Z0-9]{2,30}$/.test(symbol)) throw new BybitDemoError('Invalid Bybit linear symbol.', 422);
}

function assertPositiveDecimal(value: string, label: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw new BybitDemoError(`${label} must be a positive decimal value.`, 422);
  }
}

function decimalInteger(value: string, scale: number) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
}

function compareDecimals(left: string, right: string) {
  const scale = Math.max(left.split('.')[1]?.length ?? 0, right.split('.')[1]?.length ?? 0);
  const leftInteger = decimalInteger(left, scale);
  const rightInteger = decimalInteger(right, scale);
  return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
}

function isProductBelow(value: string, price: string, minimum: string) {
  const valueScale = value.split('.')[1]?.length ?? 0;
  const priceScale = price.split('.')[1]?.length ?? 0;
  const minimumScale = minimum.split('.')[1]?.length ?? 0;
  const productScale = valueScale + priceScale;
  const product = decimalInteger(value, valueScale) * decimalInteger(price, priceScale);
  const minimumInteger = decimalInteger(minimum, minimumScale);
  return productScale >= minimumScale
    ? product < minimumInteger * (10n ** BigInt(productScale - minimumScale))
    : product * (10n ** BigInt(minimumScale - productScale)) < minimumInteger;
}

function isStepMultiple(value: string, step: string) {
  const scale = Math.max(value.split('.')[1]?.length ?? 0, step.split('.')[1]?.length ?? 0);
  const divisor = decimalInteger(step, scale);
  return divisor > 0n && decimalInteger(value, scale) % divisor === 0n;
}

type BybitLimitOrderInput = {
  symbol: string;
  side: ExchangeOrderSide;
  quantity: string;
  price: string;
  clientOrderId: string;
  reduceOnly?: boolean;
  initialProtection?: { stopLoss: string; takeProfit: string };
};

type BybitDemoAdapter = Omit<ExchangeAdapter, 'closePosition' | 'placeLimitOrder'> & {
  bindMutationGuard(guard: () => Promise<void>): void;
  placeLimitOrder(input: BybitLimitOrderInput): Promise<ExchangeOrder>;
  getClosedPnl(symbol: string, limit?: number): Promise<Record<string, unknown>[]>;
  setPositionProtection(symbol: string, stopLoss: string, takeProfit: string): Promise<void>;
  getPositionDetails(symbol: string): Promise<BybitDemoPositionDetails[]>;
  getRealtimeTrailingStops(symbol: string): Promise<BybitDemoTrailingStop[]>;
  setPositionLifecycleProtection(
    symbol: string,
    protection: { stopLoss: string; takeProfit: string; trailingStop: string; activePrice: string },
  ): Promise<void>;
  clearPositionProtection(symbol: string): Promise<void>;
  closePosition(symbol: string, clientOrderId?: string): Promise<ExchangeOrder>;
};

export type BybitDemoPositionDetails = {
  symbol: string;
  positionIdx: number;
  side: 'Buy' | 'Sell' | '';
  size: string;
  avgPrice: string;
  stopLoss: string;
  takeProfit: string;
  trailingStop: string;
  tpslMode?: string;
};

export type BybitDemoTrailingStop = {
  symbol: string;
  orderId: string;
  positionIdx: number | null;
  stopOrderType: 'TrailingStop';
  triggerPrice: string | null;
  tpslMode?: string;
};

function signedQuery(params: Record<string, string | boolean>) {
  return new URLSearchParams(
    Object.entries(params)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)]),
  ).toString();
}

export function signBybitDemoRequest(
  apiSecret: string,
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  payload: string,
) {
  return createHmac('sha256', apiSecret)
    .update(`${timestamp}${apiKey}${recvWindow}${payload}`)
    .digest('hex');
}

export function createBybitDemoAdapter(credentials: ExchangeCredentials): BybitDemoAdapter {
  let mutationGuard: () => Promise<void> = async () => {};
  if (!credentials.apiKey.trim() || !credentials.apiSecret.trim()) {
    throw new BybitDemoError('Bybit Demo API credentials are required.', 422);
  }

  async function request(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | boolean> = {},
    privateRequest = false,
  ) {
    const query = method === 'GET' ? signedQuery(params) : '';
    const body = method === 'POST' ? JSON.stringify(params) : '';
    const requestTarget = `${BYBIT_DEMO_REST_URL}${path}${query ? `?${query}` : ''}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (privateRequest) {
      const timestamp = Date.now().toString();
      headers['X-BAPI-API-KEY'] = credentials.apiKey;
      headers['X-BAPI-TIMESTAMP'] = timestamp;
      headers['X-BAPI-RECV-WINDOW'] = RECV_WINDOW;
      headers['X-BAPI-SIGN'] = signBybitDemoRequest(
        credentials.apiSecret,
        timestamp,
        credentials.apiKey,
        RECV_WINDOW,
        method === 'GET' ? query : body,
      );
      headers['X-BAPI-SIGN-TYPE'] = '2';
    }

    let response: Response;
    // Last asynchronous check before a mutating HTTP request, after all reads.
    // Keep it outside transport recovery: a denied mutation was never submitted.
    if (method === 'POST') await mutationGuard();
    try {
      response = await fetch(requestTarget, {
        method,
        headers,
        ...(method === 'POST' ? { body } : {}),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof BybitDemoError) throw error;
      throw new BybitDemoError('Bybit Demo API request failed or timed out; reconcile order state before retrying.', 503);
    }

    if (!response.ok) {
      const status = response.status === 429 ? 429 : 502;
      throw new BybitDemoError(`Bybit Demo API returned HTTP ${response.status}.`, status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BybitDemoError('Bybit Demo API returned an invalid response.', 502);
    }
    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success) throw new BybitDemoError('Bybit Demo API returned an unexpected response shape.', 502);
    if (parsed.data.retCode !== 0) {
      const status = parsed.data.retCode === 10006 ? 429
        : [10002, 10003, 10004, 10005, 10007, 10010, 10014].includes(parsed.data.retCode) ? 422
          : 502;
      const message = parsed.data.retCode === 10002
        ? 'Bybit Demo rejected the request timestamp. Check server clock synchronization and retry.'
        : `Bybit Demo API rejected the request (${parsed.data.retCode}): ${parsed.data.retMsg.slice(0, 180)}`;
      throw new BybitDemoError(
        message,
        status,
        parsed.data.retCode,
      );
    }
    return parsed.data.result;
  }

  async function list(path: string, params: Record<string, string>, privateRequest = true) {
    const rows: Record<string, unknown>[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page += 1) {
      const result = await request('GET', path, {
        ...params,
        ...(cursor ? { cursor } : {}),
      }, privateRequest);
      rows.push(...(result.list ?? []));
      cursor = result.nextPageCursor ?? '';
      if (!cursor) return rows;
    }
    throw new BybitDemoError('Bybit Demo pagination exceeded the safe page limit.', 502);
  }

  function normalizeOrder(value: Record<string, unknown>): ExchangeOrder {
    const parsed = orderSchema.safeParse(value);
    if (!parsed.success) throw new BybitDemoError('Bybit returned an invalid order record.', 502);
    return {
      symbol: parsed.data.symbol,
      exchangeOrderId: parsed.data.orderId,
      clientOrderId: parsed.data.orderLinkId || null,
      side: parsed.data.side === 'Buy' ? 'BUY' : 'SELL',
      type: parsed.data.orderType,
      status: parsed.data.orderStatus,
      quantity: parsed.data.qty,
      filledQuantity: parsed.data.cumExecQty ?? '0',
      price: parsed.data.price && Number(parsed.data.price) > 0 ? parsed.data.price : null,
    };
  }

  async function getOrder(symbol: string, orderLinkId: string): Promise<ExchangeOrder | null> {
    assertSymbol(symbol);
    const params = {
      category: 'linear',
      symbol,
      orderLinkId,
      limit: '50',
    };
    const realtimeRows = await list('/v5/order/realtime', { ...params, openOnly: '0' });
    const realtimeOrder = realtimeRows.find((row) => row.orderLinkId === orderLinkId);
    if (realtimeOrder) return normalizeOrder(realtimeOrder);

    const historyRows = await list('/v5/order/history', params);
    const historicalOrder = historyRows.find((row) => row.orderLinkId === orderLinkId);
    return historicalOrder ? normalizeOrder(historicalOrder) : null;
  }

  async function submitOrder(
    symbol: string,
    clientOrderId: string,
    params: Record<string, string | boolean>,
    fallback: Omit<ExchangeOrder, 'exchangeOrderId'>,
  ): Promise<ExchangeOrder> {
    let result: Record<string, unknown>;
    try {
      result = await request('POST', '/v5/order/create', params, true);
    } catch (error) {
      if (error instanceof BybitDemoError && error.retCode !== null) throw error;
      try {
        const reconciled = await getOrder(symbol, clientOrderId);
        if (reconciled) return reconciled;
      } catch {
        throw new BybitDemoError(
          `Bybit Demo order outcome is unknown. Reconcile client order ID ${clientOrderId} before retrying.`,
          503,
        );
      }
      if (error instanceof BybitDemoError && error.status < 500) throw error;
      throw new BybitDemoError(
        `Bybit Demo order outcome is unknown. Reconcile client order ID ${clientOrderId} before retrying.`,
        503,
      );
    }

    const orderId = typeof result.orderId === 'string' ? result.orderId : '';
    let reconciled: ExchangeOrder | null = null;
    try {
      reconciled = await getOrder(symbol, clientOrderId);
    } catch {
      if (!orderId) {
        throw new BybitDemoError(
          `Bybit Demo order outcome is unknown. Reconcile client order ID ${clientOrderId} before retrying.`,
          503,
        );
      }
    }
    if (reconciled) return reconciled;
    if (!orderId) {
      throw new BybitDemoError(
        `Bybit returned no identifiable order. Reconcile client order ID ${clientOrderId} before retrying.`,
        503,
      );
    }
    return { ...fallback, exchangeOrderId: orderId };
  }

  async function getPositionRow(symbol: string) {
    assertSymbol(symbol);
    const rows = await list('/v5/position/list', { category: 'linear', symbol });
    const activeRows = rows.filter((row) => Number(row.size) > 0);
    if (rows.length !== 1 || rows.some((row) => row.symbol !== symbol || Number(row.positionIdx) !== 0)) {
      throw new BybitDemoError('Bybit account is in hedge mode; this adapter requires one-way mode and will not submit an order.', 409);
    }
    return activeRows[0] ?? null;
  }

  async function assertOneWayMode(symbol: string) {
    assertSymbol(symbol);
    const rows = await list('/v5/position/list', { category: 'linear', symbol });
    if (rows.length !== 1 || rows.some((row) => row.symbol !== symbol || Number(row.positionIdx) !== 0)) {
      throw new BybitDemoError('Bybit account is in hedge mode; this adapter requires one-way mode and will not submit an order.', 409);
    }
  }

  async function validateOrderFilters(
    symbol: string,
    quantity: string,
    requestedPrice?: string,
    isMarket = false,
  ) {
    const rows = await list('/v5/market/instruments-info', {
      category: 'linear',
      symbol,
      limit: '1',
    }, false);
    const parsedInstrument = instrumentSchema.safeParse(rows[0]);
    if (
      !parsedInstrument.success ||
      parsedInstrument.data.status !== 'Trading' ||
      parsedInstrument.data.quoteCoin !== 'USDT' ||
      parsedInstrument.data.contractType !== 'LinearPerpetual'
    ) {
      throw new BybitDemoError('Bybit symbol is not an active USDT linear perpetual.', 422);
    }
    const filter = parsedInstrument.data.lotSizeFilter;
    const maximumQuantity = isMarket ? filter.maxMktOrderQty ?? filter.maxOrderQty : filter.maxOrderQty;
    if (
      !isStepMultiple(quantity, filter.qtyStep) ||
      compareDecimals(quantity, filter.minOrderQty) < 0 ||
      compareDecimals(quantity, maximumQuantity) > 0
    ) {
      throw new BybitDemoError('Order quantity does not satisfy Bybit quantity step or bounds.', 422);
    }
    if (requestedPrice && !isStepMultiple(requestedPrice, parsedInstrument.data.priceFilter.tickSize)) {
      throw new BybitDemoError('Order price does not satisfy the Bybit tick size.', 422);
    }
    let referencePrice = requestedPrice;
    if (!referencePrice) {
      const tickerResult = await request('GET', '/v5/market/tickers', { category: 'linear', symbol }, false);
      const ticker = tickerSchema.safeParse(tickerResult.list?.[0]);
      if (!ticker.success) throw new BybitDemoError('Bybit returned no ticker to verify minimum order notional.', 502);
      referencePrice = ticker.data.markPrice ?? ticker.data.lastPrice;
    }
    if (filter.minNotionalValue && isProductBelow(quantity, referencePrice, filter.minNotionalValue)) {
      throw new BybitDemoError('Order notional is below Bybit’s minimum for this contract.', 422);
    }
  }

  return {
    bindMutationGuard(guard: () => Promise<void>) { mutationGuard = guard; },
    exchange: 'BYBIT' as const,
    environment: 'DEMO' as ExchangeEnvironment,

    async testConnection() {
      await request('GET', '/v5/account/wallet-balance', {
        accountType: 'UNIFIED',
        coin: 'USDT',
      }, true);
    },

    async getAccountBalance(): Promise<ExchangeBalance[]> {
      const result = await request('GET', '/v5/account/wallet-balance', {
        accountType: 'UNIFIED',
        coin: 'USDT',
      }, true);
      const account = result.list?.[0];
      if (!account) throw new BybitDemoError('Bybit Demo returned no Unified account balance.', 502);
      const totalWalletBalance = String(account.totalWalletBalance ?? '0');
      const totalAvailableBalance = String(account.totalAvailableBalance ?? '0');
      const totalEquity = String(account.totalEquity ?? '0');
      const totalPerpUPL = String(account.totalPerpUPL ?? '0');
      return [{
        asset: 'USDT',
        walletBalance: totalWalletBalance,
        availableBalance: totalAvailableBalance,
        equity: totalEquity,
        unrealizedPnl: totalPerpUPL,
      }];
    },

    async getMarketInstruments(): Promise<ExchangeInstrument[]> {
      const rows = await list('/v5/market/instruments-info', {
        category: 'linear',
        limit: '1000',
      }, false);
      return rows.flatMap((row) => {
        const parsed = instrumentSchema.safeParse(row);
        if (!parsed.success || parsed.data.quoteCoin !== 'USDT') return [];
        return [{
          exchangeSymbol: parsed.data.symbol,
          smartExitSymbol: parsed.data.symbol,
          contractType: parsed.data.contractType === 'LinearPerpetual' ? 'PERPETUAL' as const : 'OTHER' as const,
          quoteAsset: parsed.data.quoteCoin,
          status: parsed.data.status,
          tickSize: parsed.data.priceFilter.tickSize,
          quantityStep: parsed.data.lotSizeFilter.qtyStep,
          minimumQuantity: parsed.data.lotSizeFilter.minOrderQty,
          maximumQuantity: parsed.data.lotSizeFilter.maxOrderQty,
          minimumNotional: parsed.data.lotSizeFilter.minNotionalValue ?? null,
          contractSize: '1',
          maximumLeverage: parsed.data.leverageFilter ? Number(parsed.data.leverageFilter.maxLeverage) : null,
        }];
      });
    },

    async getTicker(symbol: string): Promise<ExchangeTicker> {
      assertSymbol(symbol);
      const result = await request('GET', '/v5/market/tickers', { category: 'linear', symbol }, false);
      const parsed = tickerSchema.safeParse(result.list?.[0]);
      if (!parsed.success) throw new BybitDemoError('Bybit Demo returned no valid ticker for this symbol.', 404);
      return {
        symbol: parsed.data.symbol,
        lastPrice: parsed.data.lastPrice,
        markPrice: parsed.data.markPrice ?? null,
      };
    },

    async getPositions(): Promise<ExchangePosition[]> {
      const rows = await list('/v5/position/list', { category: 'linear', settleCoin: 'USDT', limit: '200' });
      return rows.flatMap((row) => {
        const parsed = positionSchema.safeParse(row);
        if (!parsed.success || parsed.data.side === '' || Number(parsed.data.size) <= 0) return [];
        return [{
          symbol: parsed.data.symbol,
          side: parsed.data.side === 'Buy' ? 'LONG' as const : 'SHORT' as const,
          quantity: parsed.data.size,
          entryPrice: parsed.data.avgPrice,
          markPrice: parsed.data.markPrice ?? null,
          unrealizedPnl: parsed.data.unrealisedPnl,
          leverage: parsed.data.leverage ? Number(parsed.data.leverage) : null,
        }];
      });
    },

    async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
      if (symbol) assertSymbol(symbol);
      const rows = await list('/v5/order/realtime', {
        category: 'linear',
        openOnly: '0',
        limit: '50',
        ...(symbol ? { symbol } : { settleCoin: 'USDT' }),
      });
      return rows.map(normalizeOrder).filter((order) => ['New', 'PartiallyFilled', 'Untriggered'].includes(order.status));
    },

    async getOrderHistory(symbol: string, limit = 50): Promise<ExchangeOrder[]> {
      assertSymbol(symbol);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BybitDemoError('Order history limit must be between 1 and 50.', 422);
      const rows = await list('/v5/order/history', {
        category: 'linear',
        symbol,
        limit: String(limit),
      });
      return rows.map(normalizeOrder);
    },

    async getExecutionHistory(symbol: string, limit = 50) {
      assertSymbol(symbol);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BybitDemoError('Execution history limit must be between 1 and 100.', 422);
      return list('/v5/execution/list', {
        category: 'linear',
        symbol,
        limit: String(limit),
      });
    },

    async getClosedPnl(symbol: string, limit = 50) {
      assertSymbol(symbol);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BybitDemoError('Closed PnL limit must be between 1 and 100.', 422);
      return list('/v5/position/closed-pnl', {
        category: 'linear',
        symbol,
        limit: String(limit),
      });
    },

    async setLeverage(symbol: string, leverage: number) {
      assertSymbol(symbol);
      if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new BybitDemoError('Leverage must be an integer from 1 to 125.', 422);
      const rows = await list('/v5/market/instruments-info', { category: 'linear', symbol, limit: '1' }, false);
      const instrument = instrumentSchema.safeParse(rows[0]);
      if (!instrument.success || instrument.data.status !== 'Trading') {
        throw new BybitDemoError('Bybit symbol is not an active linear contract.', 422);
      }
      if (instrument.data.leverageFilter && leverage > Number(instrument.data.leverageFilter.maxLeverage)) {
        throw new BybitDemoError('Requested leverage exceeds the Bybit contract limit.', 422);
      }
      await request('POST', '/v5/position/set-leverage', {
        category: 'linear',
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      }, true);
    },

    async placeMarketOrder(input: {
      symbol: string;
      side: ExchangeOrderSide;
      quantity: string;
      clientOrderId: string;
      reduceOnly?: boolean;
    }): Promise<ExchangeOrder> {
      assertSymbol(input.symbol);
      assertPositiveDecimal(input.quantity, 'Quantity');
      if (!/^[A-Za-z0-9_-]{1,36}$/.test(input.clientOrderId)) throw new BybitDemoError('Invalid client order ID.', 422);
      await assertOneWayMode(input.symbol);
      await validateOrderFilters(input.symbol, input.quantity, undefined, true);
      return submitOrder(input.symbol, input.clientOrderId, {
        category: 'linear',
        symbol: input.symbol,
        side: input.side === 'BUY' ? 'Buy' : 'Sell',
        orderType: 'Market',
        qty: input.quantity,
        positionIdx: '0',
        orderLinkId: input.clientOrderId,
        ...(input.reduceOnly ? { reduceOnly: true } : {}),
      }, {
        symbol: input.symbol,
        clientOrderId: input.clientOrderId,
        side: input.side,
        type: 'Market',
        status: 'Accepted',
        quantity: input.quantity,
        filledQuantity: '0',
        price: null,
      });
    },

    async placeLimitOrder(input: BybitLimitOrderInput): Promise<ExchangeOrder> {
      assertSymbol(input.symbol);
      assertPositiveDecimal(input.quantity, 'Quantity');
      assertPositiveDecimal(input.price, 'Price');
      if (!/^[A-Za-z0-9_-]{1,36}$/.test(input.clientOrderId)) throw new BybitDemoError('Invalid client order ID.', 422);
      await assertOneWayMode(input.symbol);
      await validateOrderFilters(input.symbol, input.quantity, input.price);
      if (input.initialProtection) {
        if (input.reduceOnly) throw new BybitDemoError('Reduce-only orders cannot attach entry protection.', 422);
        assertPositiveDecimal(input.initialProtection.stopLoss, 'Initial stop loss');
        assertPositiveDecimal(input.initialProtection.takeProfit, 'Initial take profit');
        await validateOrderFilters(input.symbol, input.quantity, input.initialProtection.stopLoss);
        await validateOrderFilters(input.symbol, input.quantity, input.initialProtection.takeProfit);
        const stop = Number(input.initialProtection.stopLoss);
        const target = Number(input.initialProtection.takeProfit);
        const entry = Number(input.price);
        if (input.side === 'BUY' ? !(stop < entry && entry < target) : !(target < entry && entry < stop)) {
          throw new BybitDemoError('Initial protection is not ordered around the entry.', 422);
        }
      }
      return submitOrder(input.symbol, input.clientOrderId, {
        category: 'linear',
        symbol: input.symbol,
        side: input.side === 'BUY' ? 'Buy' : 'Sell',
        orderType: 'Limit',
        qty: input.quantity,
        price: input.price,
        timeInForce: 'GTC',
        positionIdx: '0',
        orderLinkId: input.clientOrderId,
        ...(input.initialProtection ? {
          stopLoss: input.initialProtection.stopLoss,
          takeProfit: input.initialProtection.takeProfit,
          tpslMode: 'Full',
          slOrderType: 'Market',
          tpOrderType: 'Market',
          slTriggerBy: 'MarkPrice',
          tpTriggerBy: 'MarkPrice',
        } : {}),
        ...(input.reduceOnly ? { reduceOnly: true } : {}),
      }, {
        symbol: input.symbol,
        clientOrderId: input.clientOrderId,
        side: input.side,
        type: 'Limit',
        status: 'Accepted',
        quantity: input.quantity,
        filledQuantity: '0',
        price: input.price,
      });
    },

    async cancelOrder(symbol: string, orderId: string) {
      assertSymbol(symbol);
      if (!/^\d{1,32}$/.test(orderId)) throw new BybitDemoError('Invalid Bybit order ID.', 422);
      await request('POST', '/v5/order/cancel', { category: 'linear', symbol, orderId }, true);
    },

    async setPositionProtection(symbol: string, stopLoss: string, takeProfit: string) {
      assertSymbol(symbol);
      if (stopLoss !== '0') assertPositiveDecimal(stopLoss, 'Stop-loss trigger');
      if (takeProfit !== '0') assertPositiveDecimal(takeProfit, 'Take-profit trigger');
      if (!(await getPositionRow(symbol))) throw new BybitDemoError('No open Bybit Demo position exists for this symbol.', 404);
      await request('POST', '/v5/position/trading-stop', {
        category: 'linear',
        symbol,
        tpslMode: 'Full',
        positionIdx: '0',
        stopLoss,
        takeProfit,
        slTriggerBy: 'MarkPrice',
        tpTriggerBy: 'MarkPrice',
      }, true);
      const rows = await list('/v5/position/list', { category: 'linear', symbol });
      const position = rows.find((row) => Number(row.size) > 0);
      if (
        !position ||
        Number(position.stopLoss ?? 0) !== Number(stopLoss) ||
        Number(position.takeProfit ?? 0) !== Number(takeProfit)
      ) {
        throw new BybitDemoError('Bybit did not confirm the requested position protection.', 502);
      }
    },

    async getPositionDetails(symbol: string): Promise<BybitDemoPositionDetails[]> {
      assertSymbol(symbol);
      const rows = await list('/v5/position/list', { category: 'linear', symbol });
      return rows.map((row) => {
        const positionIdx = Number(row.positionIdx);
        const side = row.side;
        const size = row.size;
        const avgPrice = row.avgPrice;
        if (
          !Number.isInteger(positionIdx) ||
          !['Buy', 'Sell', ''].includes(String(side)) ||
          typeof size !== 'string' ||
          !/^\d+(?:\.\d+)?$/.test(size) ||
          typeof avgPrice !== 'string'
        ) {
          throw new BybitDemoError('Bybit returned invalid position details.', 502);
        }
        return {
          symbol: String(row.symbol ?? ''),
          positionIdx,
          side: side as BybitDemoPositionDetails['side'],
          size,
          avgPrice,
          stopLoss: String(row.stopLoss ?? '0'),
          takeProfit: String(row.takeProfit ?? '0'),
          trailingStop: String(row.trailingStop ?? '0'),
          ...(typeof row.tpslMode === 'string' ? { tpslMode: row.tpslMode } : {}),
        };
      });
    },

    async getRealtimeTrailingStops(symbol: string): Promise<BybitDemoTrailingStop[]> {
      assertSymbol(symbol);
      const rows = await list('/v5/order/realtime', {
        category: 'linear',
        symbol,
        orderFilter: 'StopOrder',
        openOnly: '0',
        limit: '50',
      });
      return rows.flatMap((row) => {
        if (row.stopOrderType !== 'TrailingStop') return [];
        const indexValue = row.positionIdx;
        const positionIdx = typeof indexValue === 'number' || typeof indexValue === 'string'
          ? Number(indexValue)
          : Number.NaN;
        return [{
          symbol: typeof row.symbol === 'string' ? row.symbol : '',
          orderId: typeof row.orderId === 'string' ? row.orderId : '',
          positionIdx: Number.isInteger(positionIdx) ? positionIdx : null,
          stopOrderType: 'TrailingStop' as const,
          triggerPrice: typeof row.triggerPrice === 'string' ? row.triggerPrice : null,
          ...(typeof row.tpslMode === 'string' ? { tpslMode: row.tpslMode } : {}),
        }];
      });
    },

    async setPositionLifecycleProtection(
      symbol: string,
      protection: { stopLoss: string; takeProfit: string; trailingStop: string; activePrice: string },
    ) {
      assertSymbol(symbol);
      assertPositiveDecimal(protection.stopLoss, 'Stop-loss trigger');
      assertPositiveDecimal(protection.takeProfit, 'Take-profit trigger');
      assertPositiveDecimal(protection.trailingStop, 'Trailing-stop distance');
      assertPositiveDecimal(protection.activePrice, 'Trailing-stop activation price');
      const instrumentRows = await list(
        '/v5/market/instruments-info',
        { category: 'linear', symbol, limit: '1' },
        false,
      );
      const instrument = instrumentSchema.safeParse(instrumentRows[0]);
      if (!instrument.success || instrument.data.status !== 'Trading') {
        throw new BybitDemoError('Bybit symbol is not an active linear contract.', 422);
      }
      const tickSize = instrument.data.priceFilter.tickSize;
      if (
        !isStepMultiple(protection.stopLoss, tickSize) ||
        !isStepMultiple(protection.takeProfit, tickSize) ||
        !isStepMultiple(protection.trailingStop, tickSize) ||
        !isStepMultiple(protection.activePrice, tickSize)
      ) {
        throw new BybitDemoError('Protection prices do not satisfy the Bybit tick size.', 422);
      }
      const position = await getPositionRow(symbol);
      if (!position || Number(position.positionIdx) !== 0) {
        throw new BybitDemoError('A one-way Bybit Demo position is required for protection.', 409);
      }
      await request('POST', '/v5/position/trading-stop', {
        category: 'linear',
        symbol,
        tpslMode: 'Full',
        positionIdx: '0',
        stopLoss: protection.stopLoss,
        takeProfit: protection.takeProfit,
        trailingStop: protection.trailingStop,
        activePrice: protection.activePrice,
        slTriggerBy: 'MarkPrice',
        tpTriggerBy: 'MarkPrice',
      }, true);
    },

    async clearPositionProtection(symbol: string) {
      assertSymbol(symbol);
      const rows = await list('/v5/position/list', { category: 'linear', symbol });
      if (rows.length !== 1 || rows.some((row) =>
        row.symbol !== symbol || Number(row.positionIdx) !== 0 ||
        typeof row.size !== 'string' || !/^0(?:\.0+)?$/.test(row.size))) {
        throw new BybitDemoError('Protection removal requires an independently confirmed flat one-way position.', 409);
      }
      await request('POST', '/v5/position/trading-stop', {
        category: 'linear',
        symbol,
        tpslMode: 'Full',
        positionIdx: '0',
        stopLoss: '0',
        takeProfit: '0',
        trailingStop: '0',
      }, true);
    },

    async setPositionStopLoss(symbol: string, triggerPrice: string) {
      const position = await getPositionRow(symbol);
      if (!position) throw new BybitDemoError('No open Bybit Demo position exists for this symbol.', 404);
      await this.setPositionProtection(symbol, triggerPrice, String(position.takeProfit || '0'));
    },

    async setPositionTakeProfit(symbol: string, triggerPrice: string) {
      const position = await getPositionRow(symbol);
      if (!position) throw new BybitDemoError('No open Bybit Demo position exists for this symbol.', 404);
      await this.setPositionProtection(symbol, String(position.stopLoss || '0'), triggerPrice);
    },

    async closePosition(
      symbol: string,
      clientOrderId = `smx${randomUUID().replaceAll('-', '')}`.slice(0, 36),
    ): Promise<ExchangeOrder> {
      const positions = await this.getPositions();
      const position = positions.find((item) => item.symbol === symbol);
      if (!position) throw new BybitDemoError('No open Bybit Demo position exists for this symbol.', 404);
      return this.placeMarketOrder({
        symbol,
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
        quantity: position.quantity,
        clientOrderId,
        reduceOnly: true,
      });
    },

    async reconcileOrder(symbol: string, clientOrderId: string) {
      return getOrder(symbol, clientOrderId);
    },
  };
}
