import { z } from 'zod';

export const BINANCE_FUTURES_DEMO_URL = 'https://demo-fapi.binance.com';

const decimalSchema = z.string().regex(/^\d+(?:\.\d+)?$/);

const accountSchema = z.object({ canTrade: z.boolean() }).passthrough();
const positionModeSchema = z.object({ dualSidePosition: z.boolean() }).passthrough();
const exchangeInfoSchema = z.object({
  symbols: z.array(z.object({
    symbol: z.string(),
    status: z.string(),
    contractType: z.string(),
    quoteAsset: z.string(),
    filters: z.array(z.object({
      filterType: z.string(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();
const markPriceSchema = z.object({ markPrice: decimalSchema }).passthrough();

export type BinanceDemoPreflightAdapter = {
  environment: string;
  baseUrl: string;
  request<T>(method: 'GET', path: string, parameters?: Record<string, string>): Promise<T>;
  publicRequest<T>(path: string): Promise<T>;
};

export class BinanceDemoPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinanceDemoPreflightError';
  }
}

function decimalParts(value: string) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new BinanceDemoPreflightError('Binance returned an invalid symbol-filter decimal.');
  return { integer: match[1]!, fraction: match[2] ?? '' };
}

function scaled(value: string, scale: number) {
  const parts = decimalParts(value);
  return BigInt(parts.integer) * 10n ** BigInt(scale) +
    BigInt((parts.fraction + '0'.repeat(scale)).slice(0, scale) || '0');
}

function compareDecimals(left: string, right: string) {
  const scale = Math.max(decimalParts(left).fraction.length, decimalParts(right).fraction.length);
  const leftValue = scaled(left, scale);
  const rightValue = scaled(right, scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function multiplyDecimals(left: string, right: string) {
  const leftScale = decimalParts(left).fraction.length;
  const rightScale = decimalParts(right).fraction.length;
  const product = scaled(left, leftScale) * scaled(right, rightScale);
  const scale = leftScale + rightScale;
  const factor = 10n ** BigInt(scale);
  const integer = product / factor;
  const fraction = String(product % factor).padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : String(integer);
}

function quantityFitsFilter(quantity: string, filter: Record<string, unknown>) {
  const step = typeof filter.stepSize === 'string' ? filter.stepSize : null;
  const min = typeof filter.minQty === 'string' ? filter.minQty : null;
  const max = typeof filter.maxQty === 'string' ? filter.maxQty : null;
  if (!step || !min || !max) throw new BinanceDemoPreflightError('Binance returned an incomplete quantity filter.');

  if (compareDecimals(quantity, min) < 0 || (Number(max) > 0 && compareDecimals(quantity, max) > 0)) {
    return false;
  }
  if (Number(step) <= 0) return true;
  const scale = Math.max(
    decimalParts(quantity).fraction.length,
    decimalParts(step).fraction.length,
  );
  return scaled(quantity, scale) % scaled(step, scale) === 0n;
}

function positiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && decimalSchema.safeParse(value).success && Number(value) > 0;
}

export function assertBinanceDemoOnly(environment: string) {
  if (environment !== 'DEMO') {
    throw new BinanceDemoPreflightError('This preflight accepts DEMO only; LIVE is explicitly rejected.');
  }
}

export async function inspectBinanceDemoReadiness(
  adapter: BinanceDemoPreflightAdapter,
  input: { symbol: string; quantity: string; environment?: string },
) {
  assertBinanceDemoOnly(input.environment ?? 'DEMO');
  if (adapter.environment !== 'DEMO' || adapter.baseUrl !== BINANCE_FUTURES_DEMO_URL) {
    throw new BinanceDemoPreflightError('The preflight requires the fixed Binance Futures Demo endpoint and DEMO credentials.');
  }
  if (!/^[A-Z0-9]{2,30}$/.test(input.symbol) || !positiveDecimal(input.quantity)) {
    throw new BinanceDemoPreflightError('Provide an uppercase Binance symbol and a positive decimal quantity.');
  }

  const [accountRaw, positionModeRaw, exchangeInfoRaw] = await Promise.all([
    adapter.request<unknown>('GET', '/fapi/v3/account'),
    adapter.request<unknown>('GET', '/fapi/v1/positionSide/dual'),
    adapter.publicRequest<unknown>('/fapi/v1/exchangeInfo'),
  ]);
  const account = accountSchema.safeParse(accountRaw);
  const positionMode = positionModeSchema.safeParse(positionModeRaw);
  const exchangeInfo = exchangeInfoSchema.safeParse(exchangeInfoRaw);
  if (!account.success || !positionMode.success || !exchangeInfo.success) {
    throw new BinanceDemoPreflightError('Binance returned an invalid account, position-mode, or exchange-info response.');
  }

  const instrument = exchangeInfo.data.symbols.find((item) => item.symbol === input.symbol);
  const symbolReady = Boolean(
    instrument &&
    instrument.status === 'TRADING' &&
    instrument.contractType === 'PERPETUAL' &&
    instrument.quoteAsset === 'USDT',
  );
  const filters = instrument?.filters ?? [];
  const lotFilter = filters.find((filter) => filter.filterType === 'LOT_SIZE');
  const marketLotFilter = filters.find((filter) => filter.filterType === 'MARKET_LOT_SIZE');
  const priceFilter = filters.find((filter) => filter.filterType === 'PRICE_FILTER');
  const notionalFilter = filters.find((filter) =>
    filter.filterType === 'MIN_NOTIONAL' || filter.filterType === 'NOTIONAL',
  );

  let markPrice: string | null = null;
  let notionalUsdt: string | null = null;
  let quantityFitsLotSize = false;
  let quantityFitsMarketLotSize = false;
  let minimumNotional: string | null = null;
  let notionalSufficient = false;
  if (symbolReady && instrument) {
    const markRaw: unknown = await adapter.publicRequest<unknown>(
      `/fapi/v1/premiumIndex?symbol=${encodeURIComponent(input.symbol)}`,
    );
    const parsedMark = markPriceSchema.safeParse(markRaw);
    if (!parsedMark.success || Number(parsedMark.data.markPrice) <= 0) {
      throw new BinanceDemoPreflightError('Binance returned an invalid mark price for the selected Demo symbol.');
    }
    markPrice = parsedMark.data.markPrice;
    notionalUsdt = multiplyDecimals(input.quantity, markPrice);

    if (lotFilter) quantityFitsLotSize = quantityFitsFilter(input.quantity, lotFilter);
    if (marketLotFilter) quantityFitsMarketLotSize = quantityFitsFilter(input.quantity, marketLotFilter);
    if (!lotFilter && !marketLotFilter) {
      throw new BinanceDemoPreflightError('Binance returned no usable lot-size filters for the selected symbol.');
    }

    const rawMinimum = notionalFilter?.notional ?? notionalFilter?.minNotional;
    if (positiveDecimal(rawMinimum)) {
      minimumNotional = rawMinimum;
      const appliesToMarket = notionalFilter?.applyToMarket;
      notionalSufficient = appliesToMarket === false || compareDecimals(notionalUsdt, minimumNotional) >= 0;
    }
  }

  const checks = {
    demoEndpoint: adapter.environment === 'DEMO' && adapter.baseUrl === BINANCE_FUTURES_DEMO_URL,
    accountCanTrade: account.data.canTrade,
    oneWayPositionMode: !positionMode.data.dualSidePosition,
    usdtPerpetualTrading: symbolReady,
    tickSizeAvailable: Boolean(priceFilter && positiveDecimal(priceFilter.tickSize)),
    quantityFitsLotSize,
    quantityFitsMarketLotSize,
    minimumNotionalAvailable: minimumNotional !== null,
    notionalSufficient,
  };
  return {
    exchange: 'BINANCE',
    environment: 'DEMO',
    endpoint: BINANCE_FUTURES_DEMO_URL,
    symbol: input.symbol,
    quantity: input.quantity,
    markPrice,
    notionalUsdt,
    minimumNotionalUsdt: minimumNotional,
    filters: {
      price: priceFilter ? {
        tickSize: String(priceFilter.tickSize ?? ''),
        minPrice: String(priceFilter.minPrice ?? ''),
        maxPrice: String(priceFilter.maxPrice ?? ''),
      } : null,
      lotSize: lotFilter ? {
        minQty: String(lotFilter.minQty ?? ''),
        maxQty: String(lotFilter.maxQty ?? ''),
        stepSize: String(lotFilter.stepSize ?? ''),
      } : null,
      marketLotSize: marketLotFilter ? {
        minQty: String(marketLotFilter.minQty ?? ''),
        maxQty: String(marketLotFilter.maxQty ?? ''),
        stepSize: String(marketLotFilter.stepSize ?? ''),
      } : null,
    },
    permissions: { canTrade: account.data.canTrade },
    positionMode: { dualSidePosition: positionMode.data.dualSidePosition },
    checks,
    ready: Object.values(checks).every(Boolean),
    ordersPlaced: false as const,
  };
}
