import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type {
  ExchangeAdapter,
  ExchangeBalance,
  ExchangeCredentials,
  ExchangeInstrument,
  ExchangeOrder,
  ExchangePosition,
} from './types';
import type { AdminDemoProviderCapabilities } from '../admin-demo-provider-contract';

const OKX_DEMO_REST_URL = 'https://openapi.okx.com';
const REQUEST_TIMEOUT_MS = 10_000;

const envelopeSchema = z.object({
  code: z.string(),
  msg: z.string().optional(),
  data: z.array(z.record(z.string(), z.unknown())),
}).passthrough();

const accountConfigurationSchema = z.object({
  acctLv: z.enum(['1', '2', '3', '4']),
  posMode: z.enum(['net_mode', 'long_short_mode']),
}).passthrough();

const balanceDetailsSchema = z.object({
  ccy: z.string(),
  cashBal: z.string(),
  availBal: z.string(),
  eq: z.string(),
  upl: z.string(),
});

const instrumentSchema = z.object({
  instId: z.string(),
  instType: z.string(),
  state: z.string(),
  settleCcy: z.string(),
  ctType: z.string(),
  ctVal: z.string(),
  ctMult: z.string(),
  tickSz: z.string(),
  lotSz: z.string(),
  minSz: z.string(),
  maxLmtSz: z.string().optional(),
  lever: z.string().optional(),
}).passthrough();

const positionSchema = z.object({
  instId: z.string(),
  instType: z.literal('SWAP'),
  pos: z.string(),
  posSide: z.literal('net'),
  avgPx: z.string(),
  markPx: z.string().optional(),
  upl: z.string(),
  lever: z.string().optional(),
}).passthrough();

const swapId = z.string().regex(/^[A-Z0-9]{1,24}-USDT-SWAP$/);
const exchangeOrderId = z.string().regex(/^[1-9]\d{0,31}$/);
const clientOrderId = z.string().regex(/^[A-Za-z0-9]{1,32}$/);
const orderAmount = z.string().regex(/^\d{1,30}(?:\.\d{1,30})?$/);
const orderSchema = z.object({
  instType: z.literal('SWAP'),
  instId: swapId,
  ordId: exchangeOrderId,
  clOrdId: z.union([clientOrderId, z.literal('')]),
  side: z.enum(['buy', 'sell']),
  ordType: z.enum(['market', 'limit', 'post_only', 'fok', 'ioc', 'optimal_limit_ioc']),
  state: z.enum(['live', 'partially_filled', 'filled', 'canceled', 'mmp_canceled']),
  sz: orderAmount,
  accFillSz: orderAmount,
  px: z.union([orderAmount, z.literal('')]),
});

export type OkxDemoAccountConfiguration = {
  accountLevel: 'spot' | 'futures' | 'multi-currency-margin' | 'portfolio-margin';
  positionMode: 'net_mode' | 'long_short_mode';
};

export const OKX_DEMO_CAPABILITIES: Readonly<AdminDemoProviderCapabilities> = {
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
};

export class OkxDemoError extends Error {
  constructor(message: string, readonly status = 502, readonly code: string | null = null) {
    super(message);
    this.name = 'OkxDemoError';
  }
}

function assertCredential(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OkxDemoError(`OKX Demo ${label} is required.`, 422);
  }
}

function decimalParts(value: string) {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? '';
  const integer = BigInt(`${match[1]}${match[2]}${fraction}`);
  return { integer, scale: fraction.length };
}

function isPositiveDecimal(value: string) {
  const parsed = decimalParts(value);
  return parsed !== null && parsed.integer > 0n;
}

function canonicalDecimal(integer: bigint, scale: number) {
  const negative = integer < 0n;
  let digits = (negative ? -integer : integer).toString().padStart(scale + 1, '0');
  if (scale > 0) {
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
      .replace(/0+$/, '')
      .replace(/\.$/, '');
  }
  if (digits === '') digits = '0';
  return `${negative ? '-' : ''}${digits}`;
}

function multiplyDecimals(left: string, right: string) {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (!leftParts || !rightParts) return null;
  return canonicalDecimal(
    leftParts.integer * rightParts.integer,
    leftParts.scale + rightParts.scale,
  );
}

function isStepMultiple(value: string, step: string) {
  const valueParts = decimalParts(value);
  const stepParts = decimalParts(step);
  if (!valueParts || !stepParts || stepParts.integer <= 0n) return false;
  const scale = Math.max(valueParts.scale, stepParts.scale);
  const valueInteger = valueParts.integer * 10n ** BigInt(scale - valueParts.scale);
  const stepInteger = stepParts.integer * 10n ** BigInt(scale - stepParts.scale);
  return valueInteger % stepInteger === 0n;
}

function compareDecimals(left: string, right: string) {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (!leftParts || !rightParts) return null;
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftInteger = leftParts.integer * 10n ** BigInt(scale - leftParts.scale);
  const rightInteger = rightParts.integer * 10n ** BigInt(scale - rightParts.scale);
  return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
}

function normalizePositive(value: string) {
  const parsed = decimalParts(value);
  return parsed ? canonicalDecimal(parsed.integer, parsed.scale) : value;
}

function accountLevel(value: string): OkxDemoAccountConfiguration['accountLevel'] {
  switch (value) {
    case '1': return 'spot';
    case '2': return 'futures';
    case '3': return 'multi-currency-margin';
    case '4': return 'portfolio-margin';
    default: throw new OkxDemoError('OKX returned an unsupported account mode.', 502);
  }
}

export function signOkxDemoRequest(
  apiSecret: string,
  timestamp: string,
  method: 'GET' | 'POST',
  requestPath: string,
  body = '',
) {
  return createHmac('sha256', apiSecret)
    .update(`${timestamp}${method}${requestPath}${body}`)
    .digest('base64');
}

type OkxDemoAdapter = ExchangeAdapter & {
  readonly capabilities: Readonly<AdminDemoProviderCapabilities>;
  getAccountConfiguration(): Promise<OkxDemoAccountConfiguration>;
  getOrderStatus(symbol: string, orderId: string): Promise<ExchangeOrder | null>;
};

export function createOkxDemoAdapter(
  credentials: ExchangeCredentials,
  transport?: typeof fetch,
): OkxDemoAdapter {
  assertCredential(credentials?.apiKey, 'API key');
  assertCredential(credentials?.apiSecret, 'API secret');
  assertCredential(credentials?.passphrase, 'API passphrase');

  async function request(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string> = {},
    privateRequest = false,
  ) {
    const query = method === 'GET'
      ? new URLSearchParams(Object.entries(params)).toString()
      : '';
    const requestPath = `${path}${query ? `?${query}` : ''}`;
    const body = method === 'POST' ? JSON.stringify(params) : '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-simulated-trading': '1',
    };

    if (privateRequest) {
      const timestamp = new Date().toISOString();
      headers['OK-ACCESS-KEY'] = credentials.apiKey;
      headers['OK-ACCESS-PASSPHRASE'] = credentials.passphrase!;
      headers['OK-ACCESS-TIMESTAMP'] = timestamp;
      headers['OK-ACCESS-SIGN'] = signOkxDemoRequest(
        credentials.apiSecret,
        timestamp,
        method,
        requestPath,
        body,
      );
    }

    let response: Response;
    try {
      response = await (transport ?? fetch)(`${OKX_DEMO_REST_URL}${requestPath}`, {
        method,
        headers,
        ...(method === 'POST' ? { body } : {}),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new OkxDemoError('OKX Demo API request failed or timed out.', 503);
    }
    if (!response.ok || response.redirected) {
      throw new OkxDemoError(`OKX Demo API returned HTTP ${response.status}.`, response.status === 429 ? 429 : 502);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OkxDemoError('OKX Demo API returned an invalid response.', 502);
    }
    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success) throw new OkxDemoError('OKX Demo API returned an unexpected response shape.', 502);
    if (parsed.data.code !== '0') {
      throw new OkxDemoError(
        `OKX Demo API rejected the request (${parsed.data.code}).`,
        parsed.data.code === '50011' ? 429 : 502,
        parsed.data.code,
      );
    }
    return parsed.data.data;
  }

  async function getRawAccountConfiguration() {
    const rows = await request('GET', '/api/v5/account/config', {}, true);
    const parsed = accountConfigurationSchema.safeParse(rows[0]);
    if (!parsed.success) throw new OkxDemoError('OKX Demo returned invalid account configuration.', 502);
    return parsed.data;
  }

  function unsupported(operation: string): never {
    throw new OkxDemoError(
      `OKX Demo ${operation} is disabled: the TP1/TP2 trailing and TP3 full-position lifecycle is not implemented or reconciled.`,
      501,
    );
  }

  async function lookupOrder(
    symbol: string,
    identifier: string,
    kind: 'ordId' | 'clOrdId',
  ): Promise<ExchangeOrder | null> {
    if (!transport || transport === fetch) return unsupported('remote order lookup');
    const idSchema = kind === 'ordId' ? exchangeOrderId : clientOrderId;
    if (!swapId.safeParse(symbol).success || !idSchema.safeParse(identifier).success) {
      throw new OkxDemoError('Invalid OKX Demo swap or order identifier.', 422);
    }
    let rows: unknown[];
    try {
      rows = await request('GET', '/api/v5/trade/order', { instId: symbol, [kind]: identifier }, true);
    } catch (error) {
      if (error instanceof OkxDemoError && error.code === '51603') return null;
      throw error;
    }
    const parsed = orderSchema.safeParse(rows[0]);
    if (rows.length !== 1 || !parsed.success || parsed.data.instId !== symbol ||
        parsed.data[kind] !== identifier) {
      throw new OkxDemoError('OKX Demo order response could not be matched to the request.', 502);
    }
    const order = parsed.data;
    const fillComparison = compareDecimals(order.accFillSz, order.sz);
    if (!isPositiveDecimal(order.sz) || fillComparison === null || fillComparison > 0 ||
        (order.state === 'filled' && fillComparison !== 0) ||
        (order.state === 'partially_filled' && (!isPositiveDecimal(order.accFillSz) || fillComparison !== -1)) ||
        (order.ordType !== 'market' && order.ordType !== 'optimal_limit_ioc' && !isPositiveDecimal(order.px))) {
      throw new OkxDemoError('OKX Demo returned inconsistent order quantities or pricing.', 502);
    }
    return {
      symbol: order.instId,
      exchangeOrderId: order.ordId,
      clientOrderId: order.clOrdId || null,
      side: order.side === 'buy' ? 'BUY' : 'SELL',
      type: order.ordType.toUpperCase(),
      status: order.state.toUpperCase(),
      quantity: order.sz,
      filledQuantity: order.accFillSz,
      price: order.px || null,
    };
  }

  return {
    exchange: 'OKX',
    environment: 'DEMO',
    capabilities: OKX_DEMO_CAPABILITIES,

    async testConnection() {
      await getRawAccountConfiguration();
    },

    async getAccountConfiguration() {
      const configuration = await getRawAccountConfiguration();
      return {
        accountLevel: accountLevel(configuration.acctLv),
        positionMode: configuration.posMode,
      };
    },

    async getAccountBalance(): Promise<ExchangeBalance[]> {
      const rows = await request('GET', '/api/v5/account/balance', {}, true);
      if (rows.length === 0) return [];
      const details = z.array(balanceDetailsSchema).safeParse(rows[0].details);
      if (!details.success) throw new OkxDemoError('OKX Demo returned invalid balance details.', 502);
      return details.data.map((detail) => ({
        asset: detail.ccy,
        walletBalance: detail.cashBal,
        availableBalance: detail.availBal,
        equity: detail.eq,
        unrealizedPnl: detail.upl,
      }));
    },

    async getMarketInstruments(): Promise<ExchangeInstrument[]> {
      const rows = await request('GET', '/api/v5/public/instruments', { instType: 'SWAP' });
      return rows.flatMap((row) => {
        const parsed = instrumentSchema.safeParse(row);
        if (!parsed.success) throw new OkxDemoError('OKX returned invalid SWAP instrument metadata.', 502);
        const instrument = parsed.data;
        if (instrument.instType !== 'SWAP' || instrument.ctType !== 'linear') return [];
        if (
          !instrument.settleCcy ||
          !isPositiveDecimal(instrument.ctVal) ||
          !isPositiveDecimal(instrument.ctMult) ||
          !isPositiveDecimal(instrument.tickSz) ||
          !isPositiveDecimal(instrument.lotSz) ||
          !isPositiveDecimal(instrument.minSz) ||
          !isStepMultiple(instrument.minSz, instrument.lotSz) ||
          compareDecimals(instrument.minSz, instrument.lotSz)! < 0
        ) {
          throw new OkxDemoError(`OKX returned invalid contract sizing or lot-step filters for ${instrument.instId}.`, 502);
        }
        if (
          instrument.maxLmtSz &&
          (!isPositiveDecimal(instrument.maxLmtSz) || !isStepMultiple(instrument.maxLmtSz, instrument.lotSz))
        ) {
          throw new OkxDemoError(`OKX returned invalid maximum order size for ${instrument.instId}.`, 502);
        }
        const contractSize = multiplyDecimals(instrument.ctVal, instrument.ctMult);
        if (!contractSize || !isPositiveDecimal(contractSize)) {
          throw new OkxDemoError(`OKX returned invalid contract sizing for ${instrument.instId}.`, 502);
        }
        return [{
          exchangeSymbol: instrument.instId,
          smartExitSymbol: instrument.instId,
          contractType: 'PERPETUAL',
          quoteAsset: instrument.settleCcy,
          status: instrument.state,
          tickSize: normalizePositive(instrument.tickSz),
          quantityStep: normalizePositive(instrument.lotSz),
          minimumQuantity: normalizePositive(instrument.minSz),
          maximumQuantity: instrument.maxLmtSz && isPositiveDecimal(instrument.maxLmtSz)
            ? normalizePositive(instrument.maxLmtSz)
            : null,
          minimumNotional: null,
          contractSize,
          maximumLeverage: instrument.lever && isPositiveDecimal(instrument.lever)
            ? Number(instrument.lever)
            : null,
        }];
      });
    },

    async getPositions(): Promise<ExchangePosition[]> {
      const configuration = await getRawAccountConfiguration();
      if (configuration.posMode !== 'net_mode') {
        throw new OkxDemoError('OKX Demo positions require net position mode; no position data was normalized.', 409);
      }
      const rows = await request('GET', '/api/v5/account/positions', { instType: 'SWAP' }, true);
      return rows.flatMap((row) => {
        const parsed = positionSchema.safeParse(row);
        if (!parsed.success) throw new OkxDemoError('OKX Demo returned an invalid SWAP position.', 502);
        const position = parsed.data;
        const parsedQuantity = decimalParts(position.pos);
        if (!parsedQuantity) throw new OkxDemoError('OKX Demo returned an invalid position quantity.', 502);
        if (parsedQuantity.integer === 0n) return [];
        if (!isPositiveDecimal(position.avgPx) || !decimalParts(position.upl)) {
          throw new OkxDemoError('OKX Demo returned invalid position pricing or PnL.', 502);
        }
        const markPrice = position.markPx && isPositiveDecimal(position.markPx)
          ? normalizePositive(position.markPx)
          : null;
        return [{
          symbol: position.instId,
          side: parsedQuantity.integer > 0n ? 'LONG' as const : 'SHORT' as const,
          quantity: canonicalDecimal(
            parsedQuantity.integer < 0n ? -parsedQuantity.integer : parsedQuantity.integer,
            parsedQuantity.scale,
          ),
          entryPrice: position.avgPx,
          markPrice,
          unrealizedPnl: position.upl,
          leverage: position.lever && isPositiveDecimal(position.lever) ? Number(position.lever) : null,
        }];
      });
    },

    async getTicker() { return unsupported('ticker reads'); },
    async getOpenOrders() { return unsupported('open-order reads'); },
    async getOrderHistory() { return unsupported('order-history reads'); },
    async getExecutionHistory() { return unsupported('execution-history reads'); },
    async setLeverage() { return unsupported('leverage changes'); },
    async placeMarketOrder() { return unsupported('market entries'); },
    async placeLimitOrder() { return unsupported('limit entries'); },
    async cancelOrder() { return unsupported('order cancellation'); },
    async setPositionStopLoss() { return unsupported('stop-loss protection'); },
    async setPositionTakeProfit() { return unsupported('take-profit protection'); },
    async closePosition() { return unsupported('reduce-only close'); },
    getOrderStatus: (symbol, orderId) => lookupOrder(symbol, orderId, 'ordId'),
    // A null result is an unresolved lookup, never authority to resubmit.
    reconcileOrder: (symbol, orderId) => lookupOrder(symbol, orderId, 'clOrdId'),
  };
}
