import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const credentials = {
  apiKey: 'demo-key',
  apiSecret: 'demo-secret',
  testAccountId: '44',
  environment: 'DEMO',
};
const scope = {
  kind: 'ADMIN_DEMO_TEST',
  adminUserId: 9,
  testAccountId: '44',
  sessionId: '9001',
  strategy: 'STANDARD',
  environment: 'DEMO',
  executionId: '9001',
  authorizationId: '77',
};
const execution = {
  symbol: 'BTCUSDT',
  direction: 'LONG',
  quantity: '0.01',
  entryPrice: '1000',
  stopPrice: '900',
  tp1Price: '1100',
  tp2Price: '1200',
  tp3Price: '1300',
  tickSize: '0.1',
};

function positionRow(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    positionIdx: 0,
    side: '',
    size: '0',
    avgPrice: '0',
    unrealisedPnl: '0',
    leverage: '1',
    ...overrides,
  };
}

function fixture({
  accountId = '44',
  rows = [positionRow()],
  positionDetails,
  executionEnabled = false,
  placeError,
  cancelError,
  protectionError,
  unverifiableProtection = false,
  staleTrailingStops = [],
  closeLeavesPosition = false,
} = {}) {
  const calls = [];
  const clientCalls = [];
  const state = {
    position: positionDetails ?? {
      ...rows[0],
      stopLoss: '0',
      takeProfit: '0',
      trailingStop: '0',
      tpslMode: 'Full',
    },
    tickerPrice: '1000',
    orders: new Map(),
    trailingStops: [...staleTrailingStops],
    protectionError,
    unverifiableProtection,
    closeLeavesPosition,
  };
  let orderSequence = 0;
  const client = {
    async testConnection() { clientCalls.push('testConnection'); },
    async getAccountBalance() { clientCalls.push('getAccountBalance'); return []; },
    async getMarketInstruments() {
      clientCalls.push('getMarketInstruments');
      return [{
        exchangeSymbol: 'BTCUSDT',
        smartExitSymbol: 'BTCUSDT',
        contractType: 'PERPETUAL',
        quoteAsset: 'USDT',
        status: 'Trading',
        tickSize: '0.1',
        quantityStep: '0.001',
        minimumQuantity: '0.001',
        maximumQuantity: '100',
        minimumNotional: '5',
        contractSize: '1',
        maximumLeverage: 100,
      }];
    },
    async getTicker() {
      clientCalls.push('getTicker');
      return { symbol: 'BTCUSDT', lastPrice: state.tickerPrice, markPrice: state.tickerPrice };
    },
    async getPositions() {
      clientCalls.push('getPositions');
      return [];
    },
    async getPositionDetails(symbol) {
      clientCalls.push(['getPositionDetails', symbol]);
      return [{ ...state.position, symbol }];
    },
    async getRealtimeTrailingStops(symbol) {
      clientCalls.push(['getRealtimeTrailingStops', symbol]);
      return state.unverifiableProtection
        ? [{
          symbol,
          orderId: 'trailing-without-trigger',
          positionIdx: 0,
          stopOrderType: 'TrailingStop',
          triggerPrice: null,
          tpslMode: 'Full',
        }]
        : state.trailingStops.filter((order) => order.symbol === symbol);
    },
    async placeLimitOrder(input) {
      clientCalls.push(['placeLimitOrder', input]);
      if (placeError) {
        if (typeof placeError === 'function') return placeError(input, state, ++orderSequence);
        throw placeError;
      }
      const order = {
        symbol: input.symbol,
        exchangeOrderId: String(++orderSequence),
        clientOrderId: input.clientOrderId,
        side: input.side,
        type: 'Limit',
        status: 'New',
        quantity: input.quantity,
        filledQuantity: '0',
        price: input.price,
      };
      state.orders.set(input.clientOrderId, order);
      return order;
    },
    async placeMarketOrder(input) {
      clientCalls.push(['placeMarketOrder', input]);
      const order = {
        symbol: input.symbol,
        exchangeOrderId: String(++orderSequence),
        clientOrderId: input.clientOrderId,
        side: input.side,
        type: 'Market',
        status: 'Filled',
        quantity: input.quantity,
        filledQuantity: input.quantity,
        price: null,
      };
      if (input.reduceOnly && !state.closeLeavesPosition) {
        state.position = { ...state.position, side: '', size: '0' };
      }
      return order;
    },
    async reconcileOrder(symbol, clientOrderId) {
      clientCalls.push(['reconcileOrder', symbol, clientOrderId]);
      return [...state.orders.values()].find((order) =>
        order.symbol === symbol &&
        (order.clientOrderId === clientOrderId || order.exchangeOrderId === clientOrderId)) ?? null;
    },
    async getOpenOrders(symbol) {
      clientCalls.push(['getOpenOrders', symbol]);
      return [...state.orders.values()].filter((order) =>
        order.symbol === symbol && ['New', 'PartiallyFilled'].includes(order.status));
    },
    async getOrderHistory(symbol) {
      clientCalls.push(['getOrderHistory', symbol]);
      return [...state.orders.values()].filter((order) => order.symbol === symbol);
    },
    async cancelOrder(symbol, orderId) {
      clientCalls.push(['cancelOrder', symbol, orderId]);
      const order = [...state.orders.values()].find((item) => item.exchangeOrderId === orderId);
      if (order) order.status = 'Cancelled';
      if (cancelError) throw cancelError;
    },
    async setPositionLifecycleProtection(symbol, protection) {
      clientCalls.push(['setPositionLifecycleProtection', symbol, protection]);
      if (typeof state.protectionError === 'function') {
        return state.protectionError(symbol, protection, state);
      }
      if (state.protectionError) throw state.protectionError;
      state.position = {
        ...state.position,
        stopLoss: protection.stopLoss,
        takeProfit: protection.takeProfit,
        trailingStop: protection.trailingStop,
        tpslMode: 'Full',
      };
      if (!state.unverifiableProtection) {
        state.trailingStops.push({
          symbol,
          orderId: `trailing-${state.trailingStops.length + 1}`,
          positionIdx: 0,
          stopOrderType: 'TrailingStop',
          triggerPrice: protection.activePrice,
          tpslMode: 'Full',
        });
      }
    },
    async clearPositionProtection(symbol) {
      clientCalls.push(['clearPositionProtection', symbol]);
      state.trailingStops = [];
      state.position = {
        ...state.position,
        stopLoss: '0',
        takeProfit: '0',
        trailingStop: '0',
      };
    },
  };
  const transport = async (input, init) => {
    calls.push({ url: new URL(input), init });
    return new Response(JSON.stringify({
      retCode: 0,
      retMsg: 'OK',
      result: { list: rows },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const port = require('./admin-demo-bybit-adapter.ts').createAdminBybitDemoExecutionPort({ ...credentials, testAccountId: accountId }, {
    transport,
    createClient: () => client,
    now: () => 1711420489915,
    executionEnabled,
  });
  return { port, client, transport, calls, clientCalls, state };
}


export { credentials, scope, execution, positionRow, fixture };
