import { createHmac } from 'node:crypto';
import type { ExchangeEnvironment } from './types';

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
  constructor(message: string, readonly status = 503) {
    super(message);
    this.name = 'BitgetDemoError';
  }
}

export function signBitgetDemoRequest(
  apiSecret: string,
  timestamp: string,
  method: 'GET',
  requestPath: string,
  queryString = '',
) {
  const preimage = `${timestamp}${method}${requestPath}${queryString ? `?${queryString}` : ''}`;
  return createHmac('sha256', apiSecret).update(preimage).digest('base64');
}

export function createBitgetDemoAdapter(environment: ExchangeEnvironment = 'DEMO') {
  const environmentName = environment === 'DEMO'
    ? 'Demo'
    : environment === 'TESTNET'
      ? 'Testnet'
      : 'Live';
  throw new BitgetDemoError(
    `Bitget ${environmentName} integration is unsupported: current official documentation does not verify Demo-mode requirements for the futures account, contracts, and positions endpoints. No requests are enabled.`,
  );
}
