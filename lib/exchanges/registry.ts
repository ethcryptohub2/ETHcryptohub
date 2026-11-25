import type { ExchangeCapabilities, ExchangeEnvironment, ExchangeId } from './types';

export type ExchangeDefinition = {
  id: ExchangeId;
  name: string;
  environments: readonly ExchangeEnvironment[];
  baseUrls: Partial<Record<ExchangeEnvironment, string>>;
  requiredCredentialFields: readonly ('apiKey' | 'apiSecret' | 'passphrase')[];
  capabilities: ExchangeCapabilities;
  customerTradingReady: boolean;
};

const noUnverifiedTradingCapabilities: ExchangeCapabilities = {
  connectionTest: false,
  balance: false,
  instruments: false,
  ticker: false,
  positions: false,
  orders: false,
  leverage: false,
  marketOrders: false,
  limitOrders: false,
  cancelOrders: false,
  positionTakeProfitStopLoss: false,
  safePositionClose: false,
};

const fullDemoCapabilities: ExchangeCapabilities = {
  connectionTest: true,
  balance: true,
  instruments: true,
  ticker: true,
  positions: true,
  orders: true,
  leverage: true,
  marketOrders: true,
  limitOrders: true,
  cancelOrders: true,
  positionTakeProfitStopLoss: true,
  safePositionClose: true,
};

const bybitDemoCapabilities: ExchangeCapabilities = fullDemoCapabilities;

export const EXCHANGE_REGISTRY: Record<ExchangeId, ExchangeDefinition> = {
  BINANCE: {
    id: 'BINANCE',
    name: 'Binance',
    environments: ['DEMO', 'LIVE'],
    baseUrls: { DEMO: 'https://demo-fapi.binance.com', LIVE: 'https://fapi.binance.com' },
    requiredCredentialFields: ['apiKey', 'apiSecret'],
    capabilities: fullDemoCapabilities,
    customerTradingReady: true,
  },
  BYBIT: {
    id: 'BYBIT',
    name: 'Bybit',
    environments: ['DEMO', 'LIVE'],
    baseUrls: { DEMO: 'https://api-demo.bybit.com', LIVE: 'https://api.bybit.com' },
    requiredCredentialFields: ['apiKey', 'apiSecret'],
    capabilities: fullDemoCapabilities,
    customerTradingReady: true,
  },
  OKX: {
    id: 'OKX',
    name: 'OKX',
    environments: ['DEMO', 'LIVE'],
    baseUrls: { DEMO: 'https://openapi.okx.com', LIVE: 'https://openapi.okx.com' },
    requiredCredentialFields: ['apiKey', 'apiSecret', 'passphrase'],
    capabilities: fullDemoCapabilities,
    customerTradingReady: true,
  },
  BITGET: {
    id: 'BITGET',
    name: 'Bitget',
    environments: ['DEMO', 'LIVE'],
    baseUrls: { DEMO: 'https://api.bitget.com', LIVE: 'https://api.bitget.com' },
    requiredCredentialFields: ['apiKey', 'apiSecret', 'passphrase'],
    capabilities: fullDemoCapabilities,
    customerTradingReady: true,
  },
  GATE: {
    id: 'GATE',
    name: 'Gate.io',
    environments: ['TESTNET', 'LIVE'],
    baseUrls: {
      TESTNET: 'https://api-testnet.gateapi.io/api/v4',
      LIVE: 'https://api.gateio.ws/api/v4',
    },
    requiredCredentialFields: ['apiKey', 'apiSecret'],
    capabilities: fullDemoCapabilities,
    customerTradingReady: true,
  },
};

export function getExchangeDefinition(exchange: ExchangeId, environment: ExchangeEnvironment): ExchangeDefinition {
  const definition = EXCHANGE_REGISTRY[exchange];
  if (!definition.environments.includes(environment)) {
    throw new Error(`${definition.name} does not support the ${environment} environment.`);
  }
  if (!definition.baseUrls[environment]) {
    throw new Error(`${definition.name} has no configured endpoint for ${environment}.`);
  }
  return definition;
}

export function getExchangeBaseUrl(exchange: ExchangeId, environment: ExchangeEnvironment): string {
  const definition = getExchangeDefinition(exchange, environment);
  const baseUrl = definition.baseUrls[environment];
  if (!baseUrl) throw new Error(`Missing fixed endpoint for ${exchange} ${environment}.`);
  return baseUrl;
}

export function assertExchangeCapability(exchange: ExchangeId, capability: keyof ExchangeCapabilities): void {
  if (!EXCHANGE_REGISTRY[exchange].capabilities[capability]) {
    throw new Error(`${EXCHANGE_REGISTRY[exchange].name} ${capability} is not enabled; this integration capability is not verified.`);
  }
}
