import type { ExchangeEnvironment, ExchangeId } from './exchanges/types';

export const ADMIN_DEMO_PROVIDERS = ['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'] as const;
export type AdminDemoProvider = (typeof ADMIN_DEMO_PROVIDERS)[number];
export type AdminDemoProviderEnvironment = Extract<ExchangeEnvironment, 'DEMO' | 'TESTNET'>;

export const ADMIN_DEMO_PROVIDER_ENVIRONMENTS: Record<
  AdminDemoProvider,
  AdminDemoProviderEnvironment
> = {
  BINANCE: 'DEMO',
  BYBIT: 'DEMO',
  OKX: 'DEMO',
  BITGET: 'DEMO',
  GATE: 'TESTNET',
};

export type AdminDemoProviderCapabilities = {
  connectionTest: boolean;
  balance: boolean;
  instruments: boolean;
  positions: boolean;
  entryPreflight: boolean;
  marketEntry: boolean;
  limitEntry: boolean;
  stopLossProtection: boolean;
  takeProfitProtection: boolean;
  trailingProtection: boolean;
  reduceOnlyClose: boolean;
  reconciliation: boolean;
  adminLifecycle: boolean;
};

export const DISABLED_ADMIN_DEMO_CAPABILITIES: Readonly<AdminDemoProviderCapabilities> = {
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
};

export function isAdminDemoProvider(value: unknown): value is AdminDemoProvider {
  return typeof value === 'string' &&
    (ADMIN_DEMO_PROVIDERS as readonly string[]).includes(value);
}

export function isAdminDemoProviderEnvironment(
  provider: AdminDemoProvider,
  environment: unknown,
): environment is AdminDemoProviderEnvironment {
  return environment === ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider];
}

export function assertAdminDemoProviderEnvironment(
  provider: ExchangeId,
  environment: unknown,
): asserts environment is AdminDemoProviderEnvironment {
  if (!isAdminDemoProvider(provider) || !isAdminDemoProviderEnvironment(provider, environment)) {
    throw new Error('Admin Demo provider environment does not match the fixed provider configuration.');
  }
}
