import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import type {
  ExchangeBalance,
  ExchangeCredentials,
  ExchangeEnvironment,
  ExchangeInstrument,
  ExchangePosition,
} from './types';

const GATE_FUTURES_TESTNET_REST_URL = 'https://api-testnet.gateapi.io/api/v4';
const SETTLE_CURRENCY = 'usdt';
const REQUEST_TIMEOUT_MS = 10_000;

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
};

export function createGateTestnetAdapter(
  credentials: ExchangeCredentials,
  environment: ExchangeEnvironment = 'TESTNET',
): GateTestnetAdapter {
  if (environment !== 'TESTNET') {
    throw new GateTestnetError('Gate adapter is pinned to TESTNET; Live and Demo environments are unavailable.', 422);
  }
  if (!credentials.apiKey.trim() || !credentials.apiSecret.trim()) {
    throw new GateTestnetError('Gate Futures Testnet API key and secret are required.', 422);
  }

  async function request(path: string, params: Record<string, string> = {}, privateRequest = true) {
    const queryString = sortedQuery(params);
    const requestPath = `/api/v4${path}`;
    const url = `${GATE_FUTURES_TESTNET_REST_URL}${path}${queryString ? `?${queryString}` : ''}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
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
      response = await fetch(url, {
        method: 'GET',
        headers,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GateTestnetError('Gate Futures Testnet request failed or timed out.', 503);
    }
    if (!response.ok) {
      throw new GateTestnetError(
        `Gate Futures Testnet returned HTTP ${response.status}.`,
        response.status === 429 ? 429 : 502,
      );
    }
    try {
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
  };
}
