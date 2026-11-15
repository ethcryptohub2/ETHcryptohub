import { verifyBinanceAlgoOrder, type BinanceTrailingAlgoParameters } from './binance-algo-orders';

export type BinancePositionSnapshot = {
  symbol: string;
  amount: string;
};

export type BinanceProtectionOrder = {
  id: string;
  clientId: string;
};

export type BinanceCloseOrder = {
  status: string;
};

export type BinanceProtectionExchange = {
  getPosition(symbol: string): Promise<BinancePositionSnapshot>;
  closePosition(input: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: string;
    reduceOnly: true;
    clientOrderId: string;
  }): Promise<BinanceCloseOrder>;
  getCloseOrder(symbol: string, clientOrderId: string): Promise<BinanceCloseOrder>;
  getOpenProtectionOrders(symbol: string): Promise<BinanceProtectionOrder[]>;
  cancelProtectionOrder(symbol: string, order: BinanceProtectionOrder): Promise<void>;
};

export class BinanceProtectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinanceProtectionError';
  }
}

export function assertEmergencyStopInactive(active: boolean, environment: 'DEMO' | 'LIVE') {
  if (active) {
    throw new BinanceProtectionError(`The Binance ${environment} emergency stop is active; new entries are blocked.`);
  }
}

function decimalParts(value: string) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new BinanceProtectionError('Binance price filters contain an invalid decimal value.');
  return { integer: match[1]!, fraction: match[2] ?? '' };
}

function scaledInteger(value: string, scale: number) {
  const parts = decimalParts(value);
  if (parts.fraction.length > scale) throw new BinanceProtectionError('Price precision exceeds the exchange tick size.');
  return BigInt(parts.integer) * 10n ** BigInt(scale) +
    BigInt((parts.fraction + '0'.repeat(scale)).slice(0, scale) || '0');
}

function formatScaled(value: bigint, scale: number) {
  const factor = 10n ** BigInt(scale);
  const integer = value / factor;
  const fraction = String(value % factor).padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : String(integer);
}

export function getTrailingActivationPrice(
  side: 'LONG' | 'SHORT',
  tp1: string,
  tickSize: string,
) {
  const scale = Math.max(decimalParts(tp1).fraction.length, decimalParts(tickSize).fraction.length);
  const target = scaledInteger(tp1, scale);
  const tick = scaledInteger(tickSize, scale);
  if (target <= 0n || tick <= 0n) throw new BinanceProtectionError('TP1 and Binance tick size must be positive.');
  const ticks = side === 'LONG'
    ? (target + tick - 1n) / tick
    : target / tick;
  return formatScaled(ticks * tick, scale);
}

export function hasReachedTarget(side: 'LONG' | 'SHORT', markPrice: string, targetPrice: string) {
  const mark = Number(markPrice);
  const target = Number(targetPrice);
  if (!Number.isFinite(mark) || !Number.isFinite(target) || mark <= 0 || target <= 0) {
    throw new BinanceProtectionError('Binance returned an invalid mark price or target.');
  }
  return side === 'LONG' ? mark >= target : mark <= target;
}

export function buildTrailingStopOrderParameters(input: {
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  quantity: string;
  tp1: string;
  tickSize: string;
  clientAlgoId: string;
}): BinanceTrailingAlgoParameters {
  const quantity = Number(input.quantity);
  if (!/^\d+(?:\.\d+)?$/.test(input.quantity) || !Number.isFinite(quantity) || quantity <= 0) {
    throw new BinanceProtectionError('The full position quantity for the trailing stop is invalid.');
  }
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(input.clientAlgoId)) {
    throw new BinanceProtectionError('The trailing-stop client id is invalid.');
  }
  return {
    algoType: 'CONDITIONAL',
    symbol: input.symbol,
    side: input.positionSide === 'LONG' ? 'SELL' : 'BUY',
    type: 'TRAILING_STOP_MARKET',
    activatePrice: getTrailingActivationPrice(input.positionSide, input.tp1, input.tickSize),
    callbackRate: '1',
    quantity: input.quantity,
    reduceOnly: 'true',
    workingType: 'MARK_PRICE',
    positionSide: 'BOTH',
    clientAlgoId: input.clientAlgoId,
  };
}

export function assertTrailingActivationDirection(
  side: 'LONG' | 'SHORT',
  activatePrice: string,
  currentPrice: string,
) {
  const activation = Number(activatePrice);
  const current = Number(currentPrice);
  if (
    !Number.isFinite(activation) ||
    !Number.isFinite(current) ||
    activation <= 0 ||
    current <= 0 ||
    (side === 'LONG' && activation <= current) ||
    (side === 'SHORT' && activation >= current)
  ) {
    throw new BinanceProtectionError(
      `The ${side} trailing activation price must remain beyond the current mark in the closing direction.`,
    );
  }
}

export function verifyTrailingStopOrder(
  order: unknown,
  expected: ReturnType<typeof buildTrailingStopOrderParameters>,
) {
  return verifyBinanceAlgoOrder(order, expected);
}

export async function closePositionAndVerify(
  exchange: Pick<BinanceProtectionExchange, 'getPosition' | 'closePosition' | 'getCloseOrder'>,
  input: {
    symbol: string;
    positionSide: 'LONG' | 'SHORT';
    clientOrderId: string;
    reconcileExistingOrder?: boolean;
  },
) {
  let position = await exchange.getPosition(input.symbol);
  let amount = Number(position.amount);
  if (!/^-?\d+(?:\.\d+)?$/.test(position.amount) || !Number.isFinite(amount)) {
    throw new BinanceProtectionError('Binance returned an invalid position quantity.');
  }
  if (amount === 0) return { closed: true as const, remainingQuantity: '0' };
  if ((input.positionSide === 'LONG' && amount < 0) || (input.positionSide === 'SHORT' && amount > 0)) {
    throw new BinanceProtectionError(`Binance position direction conflicts with ${input.positionSide}; no close order was submitted.`);
  }

  if (input.reconcileExistingOrder) {
    try {
      const existingOrder = await exchange.getCloseOrder(input.symbol, input.clientOrderId);
      position = await exchange.getPosition(input.symbol);
      amount = Number(position.amount);
      if (!/^-?\d+(?:\.\d+)?$/.test(position.amount) || !Number.isFinite(amount)) {
        throw new BinanceProtectionError('Binance returned an invalid position quantity while reconciling the previous close.');
      }
      if (amount === 0) return { closed: true as const, remainingQuantity: '0' };
      return {
        closed: false as const,
        remainingQuantity: position.amount,
        reason: `Existing reduce-only close order is ${existingOrder.status}; no duplicate was submitted.`,
      };
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('exchangeCode' in error) ||
        error.exchangeCode !== -2013
      ) {
        position = await exchange.getPosition(input.symbol);
        amount = Number(position.amount);
        if (!/^-?\d+(?:\.\d+)?$/.test(position.amount) || !Number.isFinite(amount)) {
          throw new BinanceProtectionError('Previous close outcome is unknown and Binance position quantity is invalid.');
        }
        if (amount === 0) return { closed: true as const, remainingQuantity: '0' };
        return {
          closed: false as const,
          remainingQuantity: position.amount,
          reason: 'Previous close order could not be reconciled; no duplicate was submitted.',
        };
      }
    }
  }

  const quantity = position.amount.startsWith('-') ? position.amount.slice(1) : position.amount;
  let order: BinanceCloseOrder;
  try {
    order = await exchange.closePosition({
      symbol: input.symbol,
      side: input.positionSide === 'LONG' ? 'SELL' : 'BUY',
      quantity,
      reduceOnly: true,
      clientOrderId: input.clientOrderId,
    });
  } catch {
    try {
      order = await exchange.getCloseOrder(input.symbol, input.clientOrderId);
    } catch {
      position = await exchange.getPosition(input.symbol);
      amount = Number(position.amount);
      if (!/^-?\d+(?:\.\d+)?$/.test(position.amount) || !Number.isFinite(amount)) {
        throw new BinanceProtectionError('Close outcome is unknown and Binance position quantity is invalid.');
      }
      if (amount === 0) return { closed: true as const, remainingQuantity: '0' };
      return {
        closed: false as const,
        remainingQuantity: position.amount,
        reason: 'Close outcome is unknown; do not retry until the order is reconciled.',
      };
    }
  }

  position = await exchange.getPosition(input.symbol);
  amount = Number(position.amount);
  if (!/^-?\d+(?:\.\d+)?$/.test(position.amount) || !Number.isFinite(amount)) {
    throw new BinanceProtectionError('Binance returned an invalid position quantity after the close attempt.');
  }
  if (amount === 0) return { closed: true as const, remainingQuantity: '0' };
  return {
    closed: false as const,
    remainingQuantity: position.amount,
    reason: `Reduce-only close status is ${order.status}; Binance confirms residual position quantity ${position.amount}.`,
  };
}

export async function cancelProtectionAfterFlat(
  exchange: Pick<BinanceProtectionExchange, 'getPosition' | 'getOpenProtectionOrders' | 'cancelProtectionOrder'>,
  symbol: string,
  orderIds: string[],
) {
  const position = await exchange.getPosition(symbol);
  if (!Number.isFinite(Number(position.amount)) || Number(position.amount) !== 0) {
    throw new BinanceProtectionError('Protective orders were retained because Binance has not confirmed a flat position.');
  }
  const ids = new Set(orderIds.filter(Boolean));
  if (ids.size === 0) return;
  const openOrders = await exchange.getOpenProtectionOrders(symbol);
  for (const order of openOrders) {
    if (ids.has(order.id) || ids.has(order.clientId)) {
      await exchange.cancelProtectionOrder(symbol, order);
    }
  }
  const remaining = await exchange.getOpenProtectionOrders(symbol);
  if (remaining.some((order) => ids.has(order.id) || ids.has(order.clientId))) {
    throw new BinanceProtectionError('Binance still reports an obsolete protective order after cancellation.');
  }
}
