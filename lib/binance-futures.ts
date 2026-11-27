import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { decryptCredential } from './binance-credentials';
import { query } from './db';

export type TradingEnvironment = 'DEMO' | 'LIVE';

const environmentUrls: Record<TradingEnvironment, string> = {
  DEMO: 'https://demo-fapi.binance.com',
  LIVE: 'https://fapi.binance.com',
};

const balanceRowSchema = z.object({
  asset: z.string().min(1),
  balance: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  crossWalletBalance: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  crossUnPnl: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  availableBalance: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  maxWithdrawAmount: z.string().regex(/^-?\d+(?:\.\d+)?$/).optional(),
  marginAvailable: z.boolean().optional(),
  updateTime: z.number().int().nonnegative().optional(),
});

const credentialsSchema = z.object({
  api_key_ciphertext: z.string().min(1),
  api_secret_ciphertext: z.string().min(1),
  environment_confirmed: z.boolean(),
});

export class BinanceFuturesError extends Error {
  constructor(message: string, readonly status = 502, readonly exchangeCode?: number) {
    super(message);
    this.name = 'BinanceFuturesError';
  }
}

export function isTradingEnvironment(value: unknown): value is TradingEnvironment {
  return value === 'DEMO' || value === 'LIVE';
}

export function tradingExecutionGate(environment: TradingEnvironment) {
  if (!isTradingEnvironment(environment)) return false;
  if (environment === 'DEMO') {
    if (process.env.WORKER_SAFE_MODE === 'true' || process.env.DEMO_ORDER_DISPATCH_ENABLED === 'false') {
      return false;
    }
    return (
      (process.env.BINANCE_FUTURES_TRADING_ENABLED === 'true' &&
        process.env.BINANCE_FUTURES_DEMO_TRADING_ENABLED === 'true' &&
        process.env.BINANCE_FUTURES_DEMO_VERIFIED === 'true') ||
      process.env.VERCEL_ENV === 'preview' ||
      process.env.SMARTEXIT_DEPLOYMENT_ENV === 'staging' ||
      process.env.NODE_ENV !== 'production'
    );
  }
  return process.env.BINANCE_FUTURES_LIVE_TRADING_APPROVED === 'true';
}

async function getCredentials(userId: number, environment: TradingEnvironment) {
  if (!isTradingEnvironment(environment)) throw new BinanceFuturesError('Invalid Binance environment.', 422);
  let result = await query(
    `SELECT api_key_ciphertext, api_secret_ciphertext, environment_confirmed
       FROM public.binance_api_credentials WHERE user_id = $1 AND environment = $2`,
    [userId, environment],
  );
  if (!result.rows[0]) {
    result = await query(
      `SELECT api_key_ciphertext, api_secret_ciphertext, environment_confirmed
         FROM public.exchange_api_credentials WHERE user_id = $1 AND exchange = 'BINANCE' AND environment = $2`,
      [userId, environment],
    );
  }
  const parsed = credentialsSchema.safeParse(result.rows[0]);
  if (!parsed.success) {
    throw new BinanceFuturesError(`Save ${environment === 'DEMO' ? 'Demo' : 'Live'} Binance API credentials before using this environment.`, 400);
  }
  if (!parsed.data.environment_confirmed) {
    throw new BinanceFuturesError(
      `Re-enter the ${environment === 'DEMO' ? 'Demo' : 'Live'} Binance credentials in the matching environment to confirm their endpoint before use.`,
      409,
    );
  }
  try {
    return {
      apiKey: decryptCredential(parsed.data.api_key_ciphertext),
      apiSecret: decryptCredential(parsed.data.api_secret_ciphertext),
    };
  } catch {
    throw new BinanceFuturesError('Stored Binance credentials could not be decrypted. Re-save the credentials after checking the server encryption key.', 503);
  }
}

async function signedRequest<T>(
  baseUrl: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  parameters: Record<string, string>,
  apiKey: string,
  apiSecret: string,
  transport: typeof fetch = fetch,
): Promise<T> {
  const params = new URLSearchParams({
    recvWindow: '10000',
    ...parameters,
    timestamp: parameters.timestamp ?? String(Date.now() - 1500),
  });
  const signature = createHmac('sha256', apiSecret).update(params.toString()).digest('hex');
  let response: Response;
  try {
    response = await transport(`${baseUrl}${path}?${params.toString()}&signature=${signature}`, {
      method,
      headers: { 'X-MBX-APIKEY': apiKey, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new BinanceFuturesError('Binance Futures could not be reached. Check the selected environment connection and retry.', 502);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'msg' in body && typeof body.msg === 'string'
      ? body.msg.slice(0, 240)
      : 'Binance rejected the Futures request.';
    const exchangeCode = typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'number'
      ? body.code
      : undefined;
    throw new BinanceFuturesError(message, 502, exchangeCode);
  }
  return body as T;
}

async function publicRequest<T>(baseUrl: string, path: string, transport: typeof fetch = fetch): Promise<T> {
  let response: Response;
  try {
    response = await transport(`${baseUrl}${path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new BinanceFuturesError('Binance Futures market information is unavailable for the selected environment.', 502);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new BinanceFuturesError('Binance Futures market information is unavailable for the selected environment.', 502);
  return body as T;
}

export type BinanceCredentialPair = { apiKey: string; apiSecret: string };

const fixedDemoSignedPaths = {
  GET: new Set([
    '/fapi/v3/account',
    '/fapi/v3/positionRisk',
    '/fapi/v1/positionSide/dual',
    '/fapi/v1/order',
    '/fapi/v1/userTrades',
    '/fapi/v1/algoOrder',
    '/fapi/v1/openAlgoOrders',
  ]),
  POST: new Set(['/fapi/v1/order', '/fapi/v1/algoOrder']),
  DELETE: new Set(['/fapi/v1/order', '/fapi/v1/algoOrder']),
};

export function createFixedBinanceDemoClient(
  credentials: BinanceCredentialPair,
  transport: typeof fetch = fetch,
) {
  const baseUrl = 'https://demo-fapi.binance.com';
  const demoTransport: typeof fetch = (input, init) => transport(input, { ...init, redirect: 'error' });
  return {
    environment: 'DEMO' as const,
    baseUrl,
    request: async <T>(
      method: 'GET' | 'POST' | 'DELETE',
      path: string,
      parameters: Record<string, string> = {},
    ) => {
      if (!Object.hasOwn(fixedDemoSignedPaths, method) || !fixedDemoSignedPaths[method].has(path)) {
        throw new BinanceFuturesError('Binance Demo signed request is outside the reviewed endpoint allowlist.', 422);
      }
      return signedRequest<T>(baseUrl, method, path, parameters, credentials.apiKey, credentials.apiSecret, demoTransport);
    },
    publicRequest: async <T>(path: string) => {
      if (path !== '/fapi/v1/exchangeInfo' && !/^\/fapi\/v1\/premiumIndex\?symbol=[A-Z0-9]{2,40}$/.test(path)) {
        throw new BinanceFuturesError('Binance Demo public request is outside the reviewed endpoint allowlist.', 422);
      }
      return publicRequest<T>(baseUrl, path, demoTransport);
    },
  };
}

export async function createBinanceEnvironmentAdapter(userId: number, environment: TradingEnvironment) {
  if (!isTradingEnvironment(environment)) throw new BinanceFuturesError('Invalid Binance environment.', 422);
  const credentials = await getCredentials(userId, environment);
  const baseUrl = environmentUrls[environment];
  return {
    environment,
    baseUrl,
    request: <T>(
      method: 'GET' | 'POST' | 'DELETE',
      path: string,
      parameters: Record<string, string> = {},
    ) => signedRequest<T>(baseUrl, method, path, parameters, credentials.apiKey, credentials.apiSecret),
    publicRequest: <T>(path: string) => publicRequest<T>(baseUrl, path),
  };
}

export async function getBinanceCredentials(userId: number, environment: TradingEnvironment) {
  return getCredentials(userId, environment);
}

export async function getFuturesBalance(userId: number, environment: TradingEnvironment) {
  const adapter = await createBinanceEnvironmentAdapter(userId, environment);
  const raw: unknown = await adapter.request('GET', '/fapi/v3/balance');
  const parsed = z.array(balanceRowSchema).safeParse(raw);
  if (!parsed.success) throw new BinanceFuturesError('Binance returned an invalid Futures balance response.');
  const usdt = parsed.data.find((asset) => asset.asset === 'USDT');
  if (!usdt) throw new BinanceFuturesError('No USDT balance was returned for this Futures account.');
  return {
    environment,
    virtualFunds: environment === 'DEMO',
    asset: 'USDT' as const,
    walletBalance: usdt.balance,
    availableBalance: usdt.availableBalance,
    crossWalletBalance: usdt.crossWalletBalance,
    unrealizedPnl: usdt.crossUnPnl,
    maxWithdrawAmount: usdt.maxWithdrawAmount ?? null,
    marginAvailable: usdt.marginAvailable ?? null,
    lastUpdatedAt: usdt.updateTime ? new Date(usdt.updateTime).toISOString() : null,
    synchronizedAt: new Date().toISOString(),
  };
}

export async function testBinanceEnvironment(userId: number, environment: TradingEnvironment) {
  const adapter = await createBinanceEnvironmentAdapter(userId, environment);
  await adapter.request('GET', '/fapi/v3/account');
  return { connected: true, environment, ordersPlaced: false };
}

export async function verifyFuturesTradingPermission(userId: number, environment: TradingEnvironment) {
  if (!tradingExecutionGate(environment)) {
    throw new BinanceFuturesError('Order placement is locked until the selected environment passes its explicit deployment verification gate.', 403);
  }
  try {
    const adapter = await createBinanceEnvironmentAdapter(userId, environment);
    await adapter.request(
      'POST',
      '/fapi/v1/order/test',
      { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.001' },
    );
  } catch (error) {
    if (environment === 'DEMO' && error instanceof BinanceFuturesError && error.status === 400) {
      return;
    }
    throw error;
  }
}
