import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { createAdminBybitDemoExecutionPort } from './admin-demo-bybit-adapter';
import { createFixedBinanceDemoClient } from './binance-futures';
import type {
  AdminDemoProviderAccountSnapshot,
  AdminDemoProviderAuthorization,
  AdminDemoProviderAuditEvent,
  AdminDemoProviderCredential,
  AdminDemoProviderCredentialInput,
  AdminDemoProviderCredentialStatus,
  AdminDemoProviderExecution,
  AdminDemoProviderExecutionInput,
  AdminDemoProviderExecutionSummary,
  AdminDemoProviderInfo,
  AdminDemoProviderRepository,
  AdminDemoProviderSessionInput,
} from './admin-demo-provider-backend-contract';
import {
  ADMIN_DEMO_PROVIDER_ENVIRONMENTS,
  DISABLED_ADMIN_DEMO_CAPABILITIES,
  type AdminDemoProvider,
  type AdminDemoProviderCapabilities,
  type AdminDemoProviderEnvironment,
} from './admin-demo-provider-contract';
import {
  assertAdminDemoProviderActor,
  assertAdminDemoProviderCapability,
  assertAdminDemoProviderEnvironment,
  type AdminDemoProviderAdmin,
} from './admin-demo-provider-security';
import { createGateTestnetAdapter } from './exchanges/gate-testnet';
import { createOkxDemoAdapter } from './exchanges/okx-demo';
import type {
  ExchangeBalance,
  ExchangeCredentials,
  ExchangeInstrument,
  ExchangePosition,
} from './exchanges/types';
import {
  createAdminDemoProviderRepository,
  type AdminDemoProviderQuery,
} from './admin-demo-provider-repository';
import { isApprovedAdminDemoStagingTarget } from './admin-demo-staging-policy';
import { pool } from './db';
import {
  createAdminDemoExecutionLifecycle,
  type EntryOrderResult,
  type EntryRequest,
  type ExecutionScope,
  type LifecycleExecution,
  type ProtectionIdentifiers,
} from './execution-lifecycle';

export type AdminDemoProviderPreflightInput = {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: string;
  entryPrice?: string;
  stopLoss?: string;
  tp1Price?: string;
  tp2Price?: string;
  tp3Price?: string;
  tickSize?: string;
};

export type AdminDemoProviderPreflightResult = {
  kind: 'READ_ONLY_PREFLIGHT';
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  executionReady: false;
  result: Record<string, unknown>;
};

export type AdminDemoProviderExecutionRequest = {
  sessionId: string;
  authorizationId: string;
  idempotencyKey: string;
  confirmation: string;
  executionMode?: 'CONFIRM';
  entryOrderType: 'LIMIT';
  config: Required<AdminDemoProviderPreflightInput>;
};

export type AdminDemoProviderTransport = typeof fetch;
export type AdminDemoProviderActor = AdminDemoProviderAdmin;
type ProviderAdapter = {
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  exchange?: AdminDemoProvider;
  testConnection(): Promise<void>;
  getAccountBalance(): Promise<ExchangeBalance[]>;
  getMarketInstruments(): Promise<ExchangeInstrument[]>;
  getPositions(): Promise<ExchangePosition[]>;
  capabilities: Readonly<AdminDemoProviderCapabilities>;
  preflight?: (input: AdminDemoProviderPreflightInput) => Promise<unknown>;
};
type InjectedExchangeAdapter = {
  exchange: 'OKX' | 'GATE';
  environment: AdminDemoProviderEnvironment;
  capabilities?: Readonly<AdminDemoProviderCapabilities>;
  testConnection(): Promise<void>;
  getAccountBalance(): Promise<ExchangeBalance[]>;
  getMarketInstruments(): Promise<ExchangeInstrument[]>;
  getPositions(): Promise<ExchangePosition[]>;
};

export type AdminDemoProviderServiceDependencies = {
  repository: AdminDemoProviderRepository;
  transport?: AdminDemoProviderTransport;
  createBybitAdapter?: (
    credentials: ExchangeCredentials & { testAccountId: string; environment: 'DEMO' },
    options: { transport: AdminDemoProviderTransport; executionEnabled: boolean },
  ) => ReturnType<typeof createAdminBybitDemoExecutionPort>;
  createOkxAdapter?: (
    credentials: ExchangeCredentials,
    transport: AdminDemoProviderTransport,
  ) => InjectedExchangeAdapter;
  createGateAdapter?: (
    credentials: ExchangeCredentials,
    environment: 'TESTNET',
    transport: AdminDemoProviderTransport,
  ) => InjectedExchangeAdapter;
  bybitLifecycleEnabledForTests?: boolean;
};

const binanceCapabilities: Readonly<AdminDemoProviderCapabilities> = Object.freeze({
  ...DISABLED_ADMIN_DEMO_CAPABILITIES,
  connectionTest: true,
  balance: true,
  instruments: true,
  positions: true,
  entryPreflight: true,
});

const unsupportedCapabilities = DISABLED_ADMIN_DEMO_CAPABILITIES;
const binanceBalanceSchema = z.array(z.object({
  asset: z.string(),
  balance: z.string(),
  crossWalletBalance: z.string(),
  crossUnPnl: z.string(),
  availableBalance: z.string(),
  marginBalance: z.string().optional(),
}));
const binancePositionSchema = z.array(z.object({
  symbol: z.string(),
  positionAmt: z.string(),
  entryPrice: z.string().optional(),
  markPrice: z.string().optional(),
  unRealizedProfit: z.string().optional(),
  leverage: z.string().optional(),
}));
const binanceExchangeInfoSchema = z.object({
  symbols: z.array(z.object({
    symbol: z.string(),
    status: z.string(),
    contractType: z.string(),
    quoteAsset: z.string(),
    filters: z.array(z.record(z.string(), z.union([z.string(), z.number()]).transform(String))),
  })),
});

function assertProvider(provider: AdminDemoProvider) {
  const environment = ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider];
  assertAdminDemoProviderEnvironment(provider, environment);
  return environment;
}

function assertCapability(
  capabilities: Readonly<AdminDemoProviderCapabilities>,
  capability: keyof AdminDemoProviderCapabilities,
) {
  assertAdminDemoProviderCapability(capabilities, capability);
}

function assertCredentialConfigured(
  credential: AdminDemoProviderCredential | null,
  provider: AdminDemoProvider,
  environment: AdminDemoProviderEnvironment,
  adminUserId: number,
) {
  if (
    !credential ||
    credential.adminUserId !== adminUserId ||
    credential.revokedAt !== null ||
    credential.ownerConfirmedAt === null
  ) {
    throw new Error(`${provider} ${environment} credentials are not configured and owner-confirmed.`);
  }
  assertAdminDemoProviderEnvironment(credential.provider, credential.environment);
  if (credential.provider !== provider || credential.environment !== environment) {
    throw new Error('Stored Admin Demo credentials do not match the fixed provider environment.');
  }
  return credential;
}

function assertCredentialEnabled(credential: AdminDemoProviderCredential) {
  if (!credential.enabled) {
    throw new Error('An enabled Admin Demo credential is required for session or lifecycle operations.');
  }
}

function credentialsFor(credential: AdminDemoProviderCredential): ExchangeCredentials {
  return {
    apiKey: credential.apiKey,
    apiSecret: credential.apiSecret,
    ...(credential.passphrase ? { passphrase: credential.passphrase } : {}),
  };
}

function sessionScope(actor: AdminDemoProviderActor, testAccountId: string) {
  return {
    kind: 'ADMIN_DEMO_TEST' as const,
    adminUserId: actor.id,
    testAccountId,
    sessionId: '1',
    strategy: 'STANDARD' as const,
    environment: 'DEMO' as const,
    executionId: '1',
    authorizationId: '1',
  };
}

function preflightExecution(input: AdminDemoProviderPreflightInput) {
  return {
    symbol: input.symbol,
    direction: input.direction,
    quantity: input.quantity,
    entryPrice: input.entryPrice ?? '0',
    stopPrice: input.stopLoss ?? '0',
    tp1Price: input.tp1Price ?? '0',
    tp2Price: input.tp2Price ?? '0',
    tp3Price: input.tp3Price ?? '0',
    tickSize: input.tickSize ?? '0',
  };
}

function validatePreflightInput(input: AdminDemoProviderPreflightInput) {
  if (
    typeof input?.symbol !== 'string' ||
    !/^[A-Z0-9:_-]{2,40}$/.test(input.symbol) ||
    (input.direction !== 'LONG' && input.direction !== 'SHORT') ||
    typeof input.quantity !== 'string' ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input.quantity) ||
    Number(input.quantity) <= 0
  ) {
    throw new Error('Admin Demo read-only preflight input is invalid.');
  }
}

function validateExecutionInput(input: AdminDemoProviderExecutionRequest) {
  validatePreflightInput(input.config);
  const prices = [
    input.config.entryPrice,
    input.config.stopLoss,
    input.config.tp1Price,
    input.config.tp2Price,
    input.config.tp3Price,
    input.config.tickSize,
  ];
  if (!prices.every((value) =>
    typeof value === 'string' &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0)) {
    throw new Error('Admin Demo execution plan contains an invalid price.');
  }
  const [entry, stop, tp1, tp2, tp3] = [
    input.config.entryPrice,
    input.config.stopLoss,
    input.config.tp1Price,
    input.config.tp2Price,
    input.config.tp3Price,
  ].map(Number);
  const ordered = input.config.direction === 'LONG'
    ? stop! < entry! && entry! < tp1! && tp1! < tp2! && tp2! < tp3!
    : tp3! < tp2! && tp2! < tp1! && tp1! < entry! && entry! < stop!;
  if (!ordered) throw new Error('Admin Demo execution protection prices are invalid.');
}

function lifecycleExecution(input: AdminDemoProviderPreflightInput): LifecycleExecution {
  return {
    symbol: input.symbol,
    direction: input.direction,
    quantity: input.quantity,
    stopPrice: input.stopLoss!,
    tp1Price: input.tp1Price!,
    tp2Price: input.tp2Price!,
    tp3Price: input.tp3Price!,
    tickSize: input.tickSize!,
  };
}

function orderClientId(sessionId: string, idempotencyKey: string, suffix: string) {
  const digest = createHash('sha256')
    .update(`${sessionId}:${idempotencyKey}`)
    .digest('hex')
    .slice(0, 24);
  return `ADM${digest}${suffix}`;
}

function decimalParts(value: string) {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? '';
  return { integer: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

function isStepMultiple(value: string, step: string) {
  const amount = decimalParts(value);
  const increment = decimalParts(step);
  if (!amount || !increment || increment.integer <= 0n) return false;
  const scale = Math.max(amount.scale, increment.scale);
  const scaledAmount = amount.integer * 10n ** BigInt(scale - amount.scale);
  const scaledIncrement = increment.integer * 10n ** BigInt(scale - increment.scale);
  return scaledAmount % scaledIncrement === 0n;
}

function mapBinanceInstrument(row: z.infer<typeof binanceExchangeInfoSchema>['symbols'][number]): ExchangeInstrument {
  const lot = row.filters.find((filter) => filter.filterType === 'LOT_SIZE');
  const notional = row.filters.find((filter) => filter.filterType === 'MIN_NOTIONAL');
  const price = row.filters.find((filter) => filter.filterType === 'PRICE_FILTER');
  return {
    exchangeSymbol: row.symbol,
    smartExitSymbol: row.symbol,
    contractType: row.contractType === 'PERPETUAL' ? 'PERPETUAL' : 'OTHER',
    quoteAsset: row.quoteAsset,
    status: row.status,
    tickSize: price?.tickSize ?? '0',
    quantityStep: lot?.stepSize ?? '0',
    minimumQuantity: lot?.minQty ?? '0',
    maximumQuantity: lot?.maxQty ?? null,
    minimumNotional: notional?.notional ?? notional?.minNotional ?? null,
    contractSize: '1',
    maximumLeverage: null,
  };
}

export function createAdminDemoProviderService(dependencies: AdminDemoProviderServiceDependencies) {
  const transport = dependencies.transport ?? fetch;
  const lifecycleEnabledForTests = dependencies.bybitLifecycleEnabledForTests === true;
  if (lifecycleEnabledForTests && (!dependencies.createBybitAdapter || !dependencies.transport)) {
    throw new Error('Bybit lifecycle test enablement requires an injected adapter and transport.');
  }
  const defaultCreateBybit = createAdminBybitDemoExecutionPort as unknown as (
    credentials: ExchangeCredentials & { testAccountId: string; environment: 'DEMO' },
    options: { transport: AdminDemoProviderTransport; executionEnabled: boolean },
  ) => ReturnType<typeof createAdminBybitDemoExecutionPort>;
  const createBybit = dependencies.createBybitAdapter ?? defaultCreateBybit;
  const createOkx = dependencies.createOkxAdapter ??
    ((credentials: ExchangeCredentials) =>
      createOkxDemoAdapter(credentials) as InjectedExchangeAdapter);
  const createGate = dependencies.createGateAdapter ??
    ((credentials: ExchangeCredentials, environment: 'TESTNET') =>
      createGateTestnetAdapter(credentials, environment) as InjectedExchangeAdapter);

  function assertActor(actor: AdminDemoProviderActor) {
    assertAdminDemoProviderActor(actor);
  }

  async function getCredential(actor: AdminDemoProviderActor, provider: AdminDemoProvider) {
    assertActor(actor);
    const environment = assertProvider(provider);
    const credential = await dependencies.repository.getCredential(actor.id, provider);
    return {
      environment,
      credential: assertCredentialConfigured(credential, provider, environment, actor.id),
    };
  }

  function makeAdapter(
    provider: AdminDemoProvider,
    actor: AdminDemoProviderActor,
    credential: AdminDemoProviderCredential,
  ): ProviderAdapter {
    const fixedEnvironment = assertProvider(provider);
    const exchangeCredentials = credentialsFor(credential);
    if (provider === 'BITGET') throw new Error('BITGET Admin Demo is unsupported.');
    if (provider === 'BINANCE') {
      const client = createFixedBinanceDemoClient(exchangeCredentials, transport);
      if (client.environment !== 'DEMO' || client.baseUrl !== 'https://demo-fapi.binance.com') {
        throw new Error('Binance Admin Demo adapter is not pinned to the Demo endpoint.');
      }
      return {
        provider,
        environment: 'DEMO' as const,
        capabilities: binanceCapabilities,
        async testConnection() {
          const account = await client.request<unknown>('GET', '/fapi/v3/account');
          if (!z.object({ canTrade: z.boolean() }).safeParse(account).success) {
            throw new Error('Binance Demo returned invalid account connection data.');
          }
        },
        async getAccountBalance() {
          const parsed = binanceBalanceSchema.safeParse(
            await client.request<unknown>('GET', '/fapi/v3/account').then((value) =>
              z.object({ assets: z.array(z.unknown()) }).parse(value).assets),
          );
          if (!parsed.success) throw new Error('Binance Demo returned invalid account balance data.');
          return parsed.data.map((row) => ({
            asset: row.asset,
            walletBalance: row.crossWalletBalance,
            availableBalance: row.availableBalance,
            equity: row.marginBalance ?? row.balance,
            unrealizedPnl: row.crossUnPnl,
          }));
        },
        async getMarketInstruments() {
          const parsed = binanceExchangeInfoSchema.safeParse(
            await client.publicRequest<unknown>('/fapi/v1/exchangeInfo'),
          );
          if (!parsed.success) throw new Error('Binance Demo returned invalid futures market data.');
          return parsed.data.symbols.map(mapBinanceInstrument);
        },
        async getPositions() {
          const parsed = binancePositionSchema.safeParse(
            await client.request<unknown>('GET', '/fapi/v3/positionRisk'),
          );
          if (!parsed.success) throw new Error('Binance Demo returned invalid position data.');
          return parsed.data.flatMap((position) => {
            const amount = Number(position.positionAmt);
            if (!Number.isFinite(amount) || amount === 0) return [];
            return [{
              symbol: position.symbol,
              side: amount > 0 ? 'LONG' as const : 'SHORT' as const,
              quantity: String(Math.abs(amount)),
              entryPrice: position.entryPrice ?? '0',
              markPrice: position.markPrice ?? null,
              unrealizedPnl: position.unRealizedProfit ?? '0',
              leverage: position.leverage ? Number(position.leverage) : null,
            }];
          });
        },
        async preflight(input: AdminDemoProviderPreflightInput) {
          const execution = preflightExecution(input);
          const [accountRaw, infoRaw, positionsRaw] = await Promise.all([
            client.request<unknown>('GET', '/fapi/v3/account'),
            client.publicRequest<unknown>('/fapi/v1/exchangeInfo'),
            client.request<unknown>('GET', '/fapi/v3/positionRisk', { symbol: input.symbol }),
          ]);
          const account = z.object({ canTrade: z.boolean() }).safeParse(accountRaw);
          const info = binanceExchangeInfoSchema.safeParse(infoRaw);
          const positions = binancePositionSchema.safeParse(positionsRaw);
          const market = info.success ? info.data.symbols.find((row) =>
            row.symbol === execution.symbol && row.status === 'TRADING' &&
            row.contractType === 'PERPETUAL' && row.quoteAsset === 'USDT') : undefined;
          const lot = market?.filters.find((filter) => filter.filterType === 'LOT_SIZE');
          const quantityValid = Boolean(lot?.stepSize && lot.minQty &&
            Number(execution.quantity) >= Number(lot.minQty) &&
            isStepMultiple(execution.quantity, lot.stepSize));
          const flat = positions.success && positions.data.every((position) =>
            position.symbol !== input.symbol || Number(position.positionAmt) === 0);
          return {
            ready: Boolean(account.success && account.data.canTrade && market && quantityValid && flat),
            endpoint: client.baseUrl,
            environment: 'DEMO',
            accountReady: Boolean(account.success && account.data.canTrade),
            symbolValid: Boolean(market),
            quantityValid,
            flat: Boolean(flat),
          };
        },
      };
    }
    if (provider === 'BYBIT') {
      const adapter = createBybit({
        ...exchangeCredentials,
        testAccountId: String(actor.id),
        environment: 'DEMO',
      }, { transport, executionEnabled: lifecycleEnabledForTests });
      if (adapter.provider !== 'BYBIT' || adapter.environment !== 'DEMO' ||
          adapter.baseUrl !== 'https://api-demo.bybit.com') {
        throw new Error('Bybit Admin Demo adapter is not pinned to the Demo endpoint.');
      }
      const scope = sessionScope(actor, String(actor.id));
      return {
        provider,
        environment: 'DEMO' as const,
        capabilities: adapter.capabilities,
        testConnection: () => adapter.testConnection(scope),
        getAccountBalance: () => adapter.getAccountBalance(scope),
        getMarketInstruments: () => adapter.getMarketInstruments(scope),
        getPositions: () => adapter.getPositions(scope),
        preflight: async (input: AdminDemoProviderPreflightInput) =>
          adapter.preflight(scope, preflightExecution(input)),
      };
    }
    if (provider === 'OKX') {
      const adapter = createOkx(exchangeCredentials, transport);
      if (adapter.exchange !== 'OKX' || adapter.environment !== 'DEMO') {
        throw new Error('OKX Admin Demo adapter is not pinned to the Demo environment.');
      }
      return {
        provider,
        environment: 'DEMO' as const,
        capabilities: adapter.capabilities ?? unsupportedCapabilities,
        testConnection: () => adapter.testConnection(),
        getAccountBalance: () => adapter.getAccountBalance(),
        getMarketInstruments: () => adapter.getMarketInstruments(),
        getPositions: () => adapter.getPositions(),
      };
    }
    const adapter = createGate(exchangeCredentials, 'TESTNET', transport);
    if (adapter.exchange !== 'GATE' || adapter.environment !== 'TESTNET' ||
        fixedEnvironment !== 'TESTNET') {
      throw new Error('Gate Admin Demo adapter is not pinned to TESTNET.');
    }
    return {
      provider,
      environment: 'TESTNET' as const,
      capabilities: adapter.capabilities ?? unsupportedCapabilities,
      testConnection: () => adapter.testConnection(),
      getAccountBalance: () => adapter.getAccountBalance(),
      getMarketInstruments: () => adapter.getMarketInstruments(),
      getPositions: () => adapter.getPositions(),
    };
  }

  async function readAdapter(
    actor: AdminDemoProviderActor,
    provider: AdminDemoProvider,
    capability: 'connectionTest' | 'balance' | 'instruments' | 'positions' | 'entryPreflight',
  ) {
    if (provider === 'BITGET') throw new Error('BITGET Admin Demo is unsupported.');
    const { credential } = await getCredential(actor, provider);
    const adapter = makeAdapter(provider, actor, credential);
    assertCapability(adapter.capabilities, capability);
    return adapter;
  }

  function createLifecycle(
    actor: AdminDemoProviderActor,
    sessionId: string,
    authorizationId: string,
    adapter: ReturnType<typeof createAdminBybitDemoExecutionPort>,
    request: AdminDemoProviderExecutionInput,
    preclaimedLockToken?: string,
    recoveryOnly = false,
    initialReservation?: 'CREATED' | 'EXISTING',
  ) {
    const scope = {
      kind: 'ADMIN_DEMO_TEST' as const,
      adminUserId: actor.id,
      testAccountId: String(actor.id),
      sessionId,
      strategy: 'STANDARD' as const,
      environment: 'DEMO' as const,
      executionId: sessionId,
      authorizationId,
    };
    const execution: LifecycleExecution = {
      symbol: request.symbol,
      direction: request.direction,
      quantity: request.quantity,
      stopPrice: request.stopLoss,
      tp1Price: request.tp1Price,
      tp2Price: request.tp2Price,
      tp3Price: request.tp3Price,
      tickSize: request.tickSize,
    };
    const getStoredExecution = async (candidate: ExecutionScope): Promise<AdminDemoProviderExecution> => {
      if (
        candidate.kind !== 'ADMIN_DEMO_TEST' ||
        candidate.adminUserId !== actor.id ||
        candidate.environment !== 'DEMO' ||
        candidate.sessionId !== sessionId ||
        candidate.authorizationId !== authorizationId
      ) {
        throw new Error('Admin Demo execution scope is invalid.');
      }
      const saved = await dependencies.repository.getExecution(actor.id, 'BYBIT', sessionId);
      if (
        !saved ||
        saved.provider !== 'BYBIT' ||
        saved.environment !== 'DEMO' ||
        saved.adminUserId !== actor.id ||
        saved.authorizationId !== authorizationId
      ) {
        throw new Error('Admin Demo execution is unavailable in the requested scope.');
      }
      return saved;
    };
    const releaseTokens = new Map<string, string>();
    if (preclaimedLockToken) releaseTokens.set(scope.sessionId, preclaimedLockToken);
    let recoveredEntryOrder: EntryOrderResult | null = null;
    const eventTypes = {
      ENTRY_SUBMITTED: ['ENTRY_SUBMITTED', 'SUCCEEDED'],
      ENTRY_UNCERTAIN: ['ENTRY_RECONCILED', 'UNCERTAIN'],
      PROTECTION_VERIFIED: ['PROTECTION_VERIFIED', 'SUCCEEDED'],
      EXECUTION_CLOSED: ['POSITION_CLOSED', 'SUCCEEDED'],
      RECONCILIATION_UNCERTAIN: ['RECONCILIATION_REQUIRED', 'UNCERTAIN'],
    } as const;
    // The reservation consumes START_TEST; every subsequent mutation must still
    // have current, unrevoked RECONCILE authority, including during initial setup.
    async function assertMutationAuthorization() {
      assertActor(actor);
      if (preclaimedLockToken && !await dependencies.repository.verifyReconciliationLease(
        actor.id, 'BYBIT', sessionId, authorizationId, preclaimedLockToken,
      )) throw new Error('Admin Demo reconciliation lease expired or was replaced.');
      if (!await dependencies.repository.authorizeAction(
        actor.id, 'BYBIT', sessionId, authorizationId, 'RECONCILE',
      )) throw new Error('Current Admin Demo authorization is required before an exchange mutation.');
      // A 10s HTTP request must fit inside both authorization and lease budgets.
      // This final database observation checks both deadlines together.
      if (preclaimedLockToken && !await dependencies.repository.verifyReconciliationLease(
        actor.id, 'BYBIT', sessionId, authorizationId, preclaimedLockToken, 15,
      )) throw new Error('Admin Demo mutation requires sufficient current authorization and lease time.');
    }
    // The real adapter repeats this guard after its reads and at the client's
    // mutating HTTP boundary. Test adapters can still use the outer wrapper.
    adapter.bindMutationGuard?.(async (candidate) => {
      if (candidate.kind !== 'ADMIN_DEMO_TEST' || candidate.executionId !== scope.executionId ||
          candidate.authorizationId !== authorizationId) throw new Error('Mutation scope mismatch.');
      await assertMutationAuthorization();
    });
    const lifecycleExchange = {
      ...adapter,
      async lookupEntry(candidate: ExecutionScope, symbol: string, clientOrderId: string) {
        const order = await adapter.lookupEntry(candidate, symbol, clientOrderId);
        if (recoveryOnly) recoveredEntryOrder = order;
        return order;
      },
      async cancelEntry(candidate: ExecutionScope, symbol: string, orderId: string) {
        await assertMutationAuthorization();
        const order = await adapter.cancelEntry(candidate, symbol, orderId);
        if (recoveryOnly) recoveredEntryOrder = order;
        return order;
      },
      async getPosition(candidate: ExecutionScope, symbol: string) {
        const order = recoveredEntryOrder;
        if (
          recoveryOnly &&
          order &&
          ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(order.status) &&
          /^\d+(?:\.\d+)?$/.test(order.executedQuantity) &&
          Number.isFinite(Number(order.executedQuantity)) &&
          Number(order.executedQuantity) > 0 &&
          Number(order.executedQuantity) <= Number(execution.quantity) &&
          /^[A-Za-z0-9_-]{1,64}$/.test(order.orderId)
        ) {
          await getStoredExecution(candidate);
          await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
            executionStatus: 'ENTRY_FILLED',
            filledQuantity: order.executedQuantity,
            entryExchangeOrderId: order.orderId,
          }, authorizationId, preclaimedLockToken);
        }
        return adapter.getPosition(candidate, symbol);
      },
      async installProtection(candidate: ExecutionScope, plan: LifecycleExecution) {
        await assertMutationAuthorization();
        return adapter.installProtection(candidate, plan);
      },
      async closePositionAndVerify(candidate: ExecutionScope, plan: LifecycleExecution) {
        await assertMutationAuthorization();
        return adapter.closePositionAndVerify(candidate, plan);
      },
      async cancelObsoleteProtection(candidate: ExecutionScope, plan: LifecycleExecution, identifiers: ProtectionIdentifiers) {
        await assertMutationAuthorization();
        return adapter.cancelObsoleteProtection(candidate, plan, identifiers);
      },
      async submitEntry(candidate: ExecutionScope, entryRequest: EntryRequest) {
        if (recoveryOnly) {
          throw new Error('Bybit entry submission is forbidden during reconciliation recovery.');
        }
        await getStoredExecution(candidate);
        await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
          executionStatus: 'ENTRY_SUBMITTING',
        }, authorizationId, preclaimedLockToken);
        await assertMutationAuthorization();
        return adapter.submitEntry(candidate, entryRequest);
      },
    };
    const lifecycle = createAdminDemoExecutionLifecycle({
      authorization: {
        async assertAuthorized(candidate) {
          if (
            candidate.kind !== 'ADMIN_DEMO_TEST' ||
            candidate.adminUserId !== actor.id ||
            candidate.sessionId !== sessionId ||
            candidate.authorizationId !== authorizationId
          ) throw new Error('Admin Demo temporary authorization scope is invalid.');
        },
      },
      environment: {
        async assertEnvironment(candidate) {
          if (candidate.kind !== 'ADMIN_DEMO_TEST' || candidate.environment !== 'DEMO') {
            throw new Error('Admin Demo lifecycle is fixed to BYBIT DEMO.');
          }
        },
      },
      exchange: lifecycleExchange,
      executions: {
        async assertScope(candidate) {
          await getStoredExecution(candidate);
        },
        async markProtected(candidate, identifiers: ProtectionIdentifiers) {
          await getStoredExecution(candidate);
          await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
            executionStatus: 'PROTECTED',
            stopProtectionId: identifiers.stopAlgoId,
            tp3ProtectionId: identifiers.tp3AlgoId,
            trailingProtectionId: identifiers.trailingAlgoId,
          }, authorizationId, preclaimedLockToken);
        },
        async markClosed(candidate) {
          await getStoredExecution(candidate);
          await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
            executionStatus: 'CLOSED',
            protectionStatus: 'CLOSED',
          }, authorizationId, preclaimedLockToken);
        },
        async markUncertain(candidate) {
          await getStoredExecution(candidate);
          await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
            executionStatus: 'RECONCILIATION_REQUIRED',
          }, authorizationId, preclaimedLockToken);
        },
      },
      entries: {
        async reserveEntry(candidate, entryRequest: EntryRequest) {
          if (
            candidate.kind !== 'ADMIN_DEMO_TEST' ||
            candidate.sessionId !== sessionId ||
            candidate.authorizationId !== authorizationId ||
            entryRequest.clientOrderId !== request.entryClientOrderId
          ) return 'BUSY';
          if (initialReservation) {
            const reservation = initialReservation;
            initialReservation = undefined;
            return reservation;
          }
          if (recoveryOnly) {
            const saved = await getStoredExecution(candidate);
            return ['CREATED', 'ENTRY_SUBMITTING', 'ENTRY_UNKNOWN'].includes(saved.executionStatus)
              ? 'EXISTING'
              : 'BUSY';
          }
          return dependencies.repository.reserveExecution(actor.id, 'BYBIT', request);
        },
        async markEntryUncertain(candidate) {
          await getStoredExecution(candidate);
          await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
            executionStatus: 'ENTRY_UNKNOWN',
          }, authorizationId, preclaimedLockToken);
        },
        async markEntryFailed(candidate) {
          await getStoredExecution(candidate);
          await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
            executionStatus: 'FAILED',
            protectionStatus: 'FAILED',
          }, authorizationId, preclaimedLockToken);
        },
        async markEntryFilled(candidate, order: EntryOrderResult, quantity: string) {
          await getStoredExecution(candidate);
          await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
            executionStatus: 'ENTRY_FILLED',
            filledQuantity: quantity,
            entryExchangeOrderId: order.orderId,
          }, authorizationId, preclaimedLockToken);
        },
      },
      protections: {
        async loadProtectionIdentifiers(candidate) {
          const saved = await getStoredExecution(candidate);
          if (!saved.stopProtectionId || !saved.tp3ProtectionId || !saved.trailingProtectionId) {
            return null;
          }
          return {
            stopAlgoId: saved.stopProtectionId,
            tp3AlgoId: saved.tp3ProtectionId,
            trailingAlgoId: saved.trailingProtectionId,
          };
        },
        async markProtectionVerified(candidate, identifiers, progress) {
          await getStoredExecution(candidate);
          await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
            protectionStatus: progress.trailingActivated ? 'TRAILING' : 'PROTECTED',
            stopProtectionId: identifiers.stopAlgoId,
            tp3ProtectionId: identifiers.tp3AlgoId,
            trailingProtectionId: identifiers.trailingAlgoId,
            tp1Reached: progress.tp1Reached,
            tp2Reached: progress.tp2Reached,
          }, authorizationId, preclaimedLockToken);
        },
        async markProtectionFailed(candidate) {
          await getStoredExecution(candidate);
          await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
            executionStatus: 'RECONCILIATION_REQUIRED',
            protectionStatus: 'FAILED',
          }, authorizationId, preclaimedLockToken);
        },
      },
      reconciliation: {
        async claim(candidate) {
          if (candidate.kind !== 'ADMIN_DEMO_TEST' || candidate.sessionId !== sessionId) return false;
          if (preclaimedLockToken) return true;
          const token = randomUUID();
          const claimed = await dependencies.repository.claimReconciliation(
            actor.id, 'BYBIT', candidate.sessionId, authorizationId, token, 90,
          );
          if (claimed) releaseTokens.set(candidate.sessionId, token);
          return claimed;
        },
        async release(candidate) {
          if (candidate.kind !== 'ADMIN_DEMO_TEST' || candidate.sessionId !== sessionId) return;
          const token = releaseTokens.get(candidate.sessionId);
          if (token) {
            await dependencies.repository.releaseReconciliation(
              actor.id, 'BYBIT', candidate.sessionId, token,
            );
            releaseTokens.delete(candidate.sessionId);
          }
        },
      },
      events: {
        async publish(event) {
          const [eventType, eventStatus] = eventTypes[event.type];
          await dependencies.repository.appendAuditEvent({
            adminUserId: actor.id,
            provider: 'BYBIT',
            sessionId,
            authorizationId,
            eventType,
            eventStatus,
            safeDetails: { environment: 'DEMO', lifecycleEvent: event.type },
          });
        },
      },
    }, {
      async assertAdminRole(candidate) {
        assertActor(actor);
        if (candidate.adminUserId !== actor.id) throw new Error('Administrator scope mismatch.');
      },
      async assertTemporaryAuthorization(candidate) {
        if (
          candidate.sessionId !== sessionId ||
          candidate.authorizationId !== authorizationId ||
          candidate.environment !== 'DEMO'
        ) throw new Error('Admin Demo temporary authorization is invalid.');
        if (preclaimedLockToken && !await dependencies.repository.authorizeAction(
          actor.id, 'BYBIT', sessionId, authorizationId, 'RECONCILE',
        )) {
          throw new Error('A valid consumed Admin Demo reconciliation authorization is required.');
        }
      },
      async assertIsolatedDemoAccount(candidate) {
        if (candidate.testAccountId !== String(actor.id)) {
          throw new Error('Admin Demo credentials are not isolated to this administrator.');
        }
      },
    });
    return { scope, execution, lifecycle };
  }

  function safeStatus(
    provider: AdminDemoProvider,
    environment: AdminDemoProviderEnvironment,
    status: AdminDemoProviderCredentialStatus,
  ): AdminDemoProviderCredentialStatus {
    assertAdminDemoProviderEnvironment(provider, environment);
    if (status.provider !== provider || status.environment !== environment) {
      throw new Error('Stored Admin Demo credential status does not match the requested provider.');
    }
    return {
      provider,
      environment,
      configured: Boolean(status.configured),
      ownerConfirmed: Boolean(status.ownerConfirmed),
      enabled: Boolean(status.enabled),
      revokedAt: status.revokedAt,
      createdAt: status.createdAt,
      updatedAt: status.updatedAt,
    };
  }

  return {
    async listProviders(actor: AdminDemoProviderActor): Promise<AdminDemoProviderInfo[]> {
      assertActor(actor);
      const statuses = await dependencies.repository.listCredentialStatuses(actor.id);
      const byProvider = new Map(statuses.map((status) => [status.provider, status]));
      return (Object.keys(ADMIN_DEMO_PROVIDER_ENVIRONMENTS) as AdminDemoProvider[]).map((provider) => {
        const environment = assertProvider(provider);
        const status = byProvider.get(provider);
        return {
          provider,
          environment,
          capabilities: provider === 'BITGET' ? unsupportedCapabilities : capabilitiesForProvider(provider),
          credential: safeStatus(provider, environment, status ?? emptyStatus(provider, environment)),
        };
      });
    },

    async getCredentialStatus(actor: AdminDemoProviderActor, provider: AdminDemoProvider) {
      assertActor(actor);
      const environment = assertProvider(provider);
      const status = await dependencies.repository.getCredentialStatus(actor.id, provider);
      return safeStatus(provider, environment, status);
    },

    async saveCredential(
      actor: AdminDemoProviderActor,
      provider: AdminDemoProvider,
      input: AdminDemoProviderCredentialInput,
    ) {
      assertActor(actor);
      const environment = assertProvider(provider);
      if (provider === 'BITGET') throw new Error('BITGET Admin Demo is unsupported.');
      if (
        !input ||
        typeof input.apiKey !== 'string' || input.apiKey.trim() === '' ||
        typeof input.apiSecret !== 'string' || input.apiSecret.trim() === '' ||
        input.ownerConfirmed !== true ||
        (provider === 'OKX' && (typeof input.passphrase !== 'string' || input.passphrase.trim() === ''))
      ) {
        throw new Error('Valid credentials and explicit owner confirmation are required.');
      }
      const status = await dependencies.repository.saveCredential(actor.id, provider, input);
      return safeStatus(provider, environment, status);
    },

    async revokeCredential(actor: AdminDemoProviderActor, provider: AdminDemoProvider) {
      assertActor(actor);
      assertProvider(provider);
      return dependencies.repository.revokeCredential(actor.id, provider);
    },

    async testConnection(actor: AdminDemoProviderActor, provider: AdminDemoProvider) {
      const adapter = await readAdapter(actor, provider, 'connectionTest');
      await adapter.testConnection();
      return { provider, environment: adapter.environment, connected: true };
    },

    async getAccountSnapshot(actor: AdminDemoProviderActor, provider: AdminDemoProvider):
      Promise<AdminDemoProviderAccountSnapshot> {
      assertActor(actor);
      const environment = assertProvider(provider);
      const adapter = await readAdapter(actor, provider, 'connectionTest');
      for (const capability of ['balance', 'instruments', 'positions'] as const) {
        assertCapability(adapter.capabilities, capability);
      }
      await adapter.testConnection();
      const [balances, instruments, positions] = await Promise.all([
        adapter.getAccountBalance(),
        adapter.getMarketInstruments(),
        adapter.getPositions(),
      ]);
      return {
        provider,
        environment,
        connected: true,
        capabilities: adapter.capabilities ?? unsupportedCapabilities,
        balances,
        instruments,
        positions,
      };
    },

    async getBalance(actor: AdminDemoProviderActor, provider: AdminDemoProvider) {
      const adapter = await readAdapter(actor, provider, 'balance');
      return adapter.getAccountBalance();
    },

    async getInstruments(actor: AdminDemoProviderActor, provider: AdminDemoProvider) {
      const adapter = await readAdapter(actor, provider, 'instruments');
      return adapter.getMarketInstruments();
    },

    async getPositions(actor: AdminDemoProviderActor, provider: AdminDemoProvider) {
      const adapter = await readAdapter(actor, provider, 'positions');
      return adapter.getPositions();
    },

    async preflight(
      actor: AdminDemoProviderActor,
      provider: AdminDemoProvider,
      input: AdminDemoProviderPreflightInput,
    ): Promise<AdminDemoProviderPreflightResult> {
      validatePreflightInput(input);
      const adapter = await readAdapter(actor, provider, 'entryPreflight');
      if (!adapter.preflight) throw new Error(`${provider} does not support read-only preflight.`);
      const result = await adapter.preflight(input);
      return {
        kind: 'READ_ONLY_PREFLIGHT',
        provider,
        environment: ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider],
        executionReady: false,
        result: typeof result === 'object' && result !== null
          ? result as Record<string, unknown>
          : { value: result },
      };
    },

    async execute(
      actor: AdminDemoProviderActor,
      provider: AdminDemoProvider,
      input: AdminDemoProviderExecutionRequest,
    ) {
      assertActor(actor);
      assertProvider(provider);
      if (provider !== 'BYBIT') {
        throw new Error('Admin Demo execution is supported only for BYBIT DEMO.');
      }
      if (
        !/^[1-9]\d*$/.test(input.sessionId) ||
        !/^[1-9]\d*$/.test(input.authorizationId) ||
        !/^[A-Za-z0-9_-]{1,36}$/.test(input.idempotencyKey) ||
        input.entryOrderType !== 'LIMIT' ||
        input.confirmation !== 'PLACE_ADMIN_DEMO_ORDER' ||
        (input.executionMode !== undefined && input.executionMode !== 'CONFIRM')
      ) {
        throw new Error('Admin Demo execution confirmation or scope is invalid.');
      }
      validateExecutionInput(input);
      if (!lifecycleEnabledForTests) {
        assertCapability(capabilitiesForProvider(provider), 'adminLifecycle');
      }
      const { credential } = await getCredential(actor, provider);
      assertCredentialEnabled(credential);
      const adapter = createBybit({
        ...credentialsFor(credential),
        testAccountId: String(actor.id),
        environment: 'DEMO',
      }, { transport, executionEnabled: lifecycleEnabledForTests });
      if (
        adapter.provider !== 'BYBIT' ||
        adapter.environment !== 'DEMO' ||
        adapter.baseUrl !== 'https://api-demo.bybit.com'
      ) {
        throw new Error('Bybit Admin Demo adapter is not pinned to the Demo endpoint.');
      }
      for (const capability of [
        'adminLifecycle',
        'limitEntry',
        'stopLossProtection',
        'takeProfitProtection',
        'trailingProtection',
      ] as const) {
        assertCapability(adapter.capabilities, capability);
      }
      const persistedInput: AdminDemoProviderExecutionInput = {
        sessionId: input.sessionId,
        authorizationId: input.authorizationId,
        entryOrderType: 'LIMIT',
        limitEntryPrice: input.config.entryPrice,
        symbol: input.config.symbol,
        direction: input.config.direction,
        quantity: input.config.quantity,
        entryPrice: input.config.entryPrice,
        stopLoss: input.config.stopLoss!,
        tp1Price: input.config.tp1Price!,
        tp2Price: input.config.tp2Price!,
        tp3Price: input.config.tp3Price!,
        tickSize: input.config.tickSize!,
        entryClientOrderId: orderClientId(input.sessionId, input.idempotencyKey, 'E'),
        stopClientOrderId: orderClientId(input.sessionId, input.idempotencyKey, 'S'),
        tp3ClientOrderId: orderClientId(input.sessionId, input.idempotencyKey, 'T'),
        trailingClientOrderId: orderClientId(input.sessionId, input.idempotencyKey, 'R'),
      };
      const reservation = await dependencies.repository.reserveExecution(actor.id, 'BYBIT', persistedInput);
      if (reservation === 'BUSY') return { result: { status: 'BUSY' as const } };
      const lockToken = randomUUID();
      if (!await dependencies.repository.claimReconciliation(
        actor.id, 'BYBIT', input.sessionId, input.authorizationId, lockToken, 90,
      )) return { result: { status: 'BUSY' as const } };
      try {
        const { scope, execution, lifecycle } = createLifecycle(
          actor,
          input.sessionId,
          input.authorizationId,
          adapter,
          persistedInput,
          lockToken,
          false,
          reservation,
        );
        const result = await lifecycle.submitAndProtectEntry(scope, {
          clientOrderId: persistedInput.entryClientOrderId,
          execution,
          entryPrice: input.config.entryPrice,
        });
        return {
          provider: 'BYBIT',
          environment: 'DEMO',
          executionMode: 'CONFIRM',
          result,
          execution: await dependencies.repository.getExecution(actor.id, 'BYBIT', input.sessionId),
        };
      } finally {
        await dependencies.repository.releaseReconciliation(actor.id, 'BYBIT', input.sessionId, lockToken);
      }
    },

    async listSessions(actor: AdminDemoProviderActor, provider: AdminDemoProvider, limit = 50) {
      assertActor(actor);
      assertProvider(provider);
      const boundedLimit = normalizeLimit(limit);
      return dependencies.repository.listSessions(actor.id, provider, boundedLimit);
    },

    async createSession(
      actor: AdminDemoProviderActor,
      provider: AdminDemoProvider,
      input: AdminDemoProviderSessionInput,
    ) {
      assertActor(actor);
      assertProvider(provider);
      if (provider === 'BITGET') throw new Error('BITGET Admin Demo is unsupported.');
      assertCapability(capabilitiesForProvider(provider), 'adminLifecycle');
      const { credential } = await getCredential(actor, provider);
      assertCredentialEnabled(credential);
      return dependencies.repository.createSession(actor.id, provider, input);
    },

    async createAuthorization(
      actor: AdminDemoProviderActor,
      provider: AdminDemoProvider,
      sessionId: string,
      expiresInSeconds: number,
    ): Promise<AdminDemoProviderAuthorization> {
      assertActor(actor);
      assertProvider(provider);
      if (!lifecycleEnabledForTests) {
        assertCapability(capabilitiesForProvider(provider), 'adminLifecycle');
        assertCapability(capabilitiesForProvider(provider), 'marketEntry');
      }
      const { credential } = await getCredential(actor, provider);
      assertCredentialEnabled(credential);
      return dependencies.repository.createAuthorization(
        actor.id,
        provider,
        sessionId,
        expiresInSeconds,
        ['START_TEST', 'RECONCILE'],
      );
    },

    async renewReconciliationAuthorization(
      actor: AdminDemoProviderActor,
      provider: AdminDemoProvider,
      _sessionId: string,
      _authorizationId: string,
      expiresInSeconds: number,
    ): Promise<AdminDemoProviderAuthorization> {
      assertActor(actor);
      assertProvider(provider);
      if (!lifecycleEnabledForTests) {
        assertCapability(capabilitiesForProvider(provider), 'adminLifecycle');
        assertCapability(capabilitiesForProvider(provider), 'reconciliation');
      }
      const { credential } = await getCredential(actor, provider);
      assertCredentialEnabled(credential);
      return dependencies.repository.renewReconciliationAuthorization(
        actor.id,
        provider,
        _sessionId,
        _authorizationId,
        expiresInSeconds,
      );
    },

    async listHistory(actor: AdminDemoProviderActor, provider: AdminDemoProvider, limit = 50): Promise<{
      executions: AdminDemoProviderExecutionSummary[];
      auditEvents: AdminDemoProviderAuditEvent[];
    }> {
      assertActor(actor);
      assertProvider(provider);
      const boundedLimit = normalizeLimit(limit);
      const [executions, auditEvents] = await Promise.all([
        dependencies.repository.listExecutions(actor.id, provider, boundedLimit),
        dependencies.repository.listAuditEvents(actor.id, provider, boundedLimit),
      ]);
      return { executions, auditEvents };
    },

    async reconcile(
      actor: AdminDemoProviderActor,
      provider: AdminDemoProvider,
      sessionId: string,
      authorizationId: string,
    ) {
      assertActor(actor);
      assertProvider(provider);
      if (provider !== 'BYBIT') {
        throw new Error('Admin Demo reconciliation is supported only for BYBIT DEMO.');
      }
      if (!/^[1-9]\d*$/.test(sessionId) || !/^[1-9]\d*$/.test(authorizationId)) {
        throw new Error('Admin Demo reconciliation identifiers are invalid.');
      }
      if (!lifecycleEnabledForTests) {
        assertCapability(capabilitiesForProvider(provider), 'reconciliation');
      }
      const { credential } = await getCredential(actor, provider);
      assertCredentialEnabled(credential);
      const session = await dependencies.repository.getSession(actor.id, provider, sessionId);
      if (
        !session ||
        session.adminUserId !== actor.id ||
        session.provider !== 'BYBIT' ||
        session.environment !== 'DEMO' ||
        !['RUNNING', 'RECONCILIATION_REQUIRED'].includes(session.status)
      ) {
        throw new Error('Admin Demo session is unavailable in the requested provider scope.');
      }
      const stored = await dependencies.repository.getExecution(actor.id, 'BYBIT', sessionId);
      if (!stored || stored.authorizationId !== authorizationId) {
        throw new Error('Admin Demo execution is unavailable in the requested authorization scope.');
      }
      if (!await dependencies.repository.authorizeAction(
        actor.id, 'BYBIT', sessionId, authorizationId, 'RECONCILE',
      )) {
        throw new Error('A valid consumed Admin Demo reconciliation authorization is required.');
      }
      const adapter = createBybit({
        ...credentialsFor(credential),
        testAccountId: String(actor.id),
        environment: 'DEMO',
      }, { transport, executionEnabled: lifecycleEnabledForTests });
      if (
        adapter.provider !== 'BYBIT' ||
        adapter.environment !== 'DEMO' ||
        adapter.baseUrl !== 'https://api-demo.bybit.com'
      ) {
        throw new Error('Bybit Admin Demo adapter is not pinned to the Demo endpoint.');
      }
      for (const capability of [
        'adminLifecycle',
        'reconciliation',
        'limitEntry',
        'trailingProtection',
        'reduceOnlyClose',
      ] as const) {
        assertCapability(adapter.capabilities, capability);
      }
      const lockToken = randomUUID();
      const claimed = await dependencies.repository.claimReconciliation(
        actor.id, 'BYBIT', sessionId, authorizationId, lockToken, 90,
      );
      if (!claimed) return { status: 'BUSY' as const };
      try {
        const scope = {
          kind: 'ADMIN_DEMO_TEST' as const,
          adminUserId: actor.id,
          testAccountId: String(actor.id),
          sessionId,
          strategy: 'STANDARD' as const,
          environment: 'DEMO' as const,
          executionId: sessionId,
          authorizationId,
        };
        const persistedInput: AdminDemoProviderExecutionInput = {
          sessionId,
          authorizationId,
          entryOrderType: stored.entryOrderType,
          limitEntryPrice: stored.entryOrderType === 'LIMIT' ? stored.entryPrice : null,
          symbol: stored.symbol,
          direction: stored.direction,
          quantity: stored.quantity,
          entryPrice: stored.entryPrice,
          stopLoss: stored.stopLoss,
          tp1Price: stored.tp1Price,
          tp2Price: stored.tp2Price,
          tp3Price: stored.tp3Price,
          tickSize: stored.tickSize,
          entryClientOrderId: stored.entryClientOrderId,
          stopClientOrderId: stored.stopClientOrderId,
          tp3ClientOrderId: stored.tp3ClientOrderId,
          trailingClientOrderId: stored.trailingClientOrderId,
        };
        const lifecycleSet = createLifecycle(
          actor, sessionId, authorizationId, adapter, persistedInput, lockToken, true,
        );
        const lifecycleExecutionInput = lifecycleExecution(persistedInput);
        if (['CREATED', 'ENTRY_SUBMITTING', 'ENTRY_UNKNOWN'].includes(stored.executionStatus)) {
          const result = await lifecycleSet.lifecycle.submitAndProtectEntry(
            lifecycleSet.scope,
            {
              clientOrderId: stored.entryClientOrderId,
              execution: lifecycleExecutionInput,
              ...(persistedInput.entryOrderType === 'LIMIT'
                ? { entryPrice: persistedInput.limitEntryPrice! }
                : {}),
            },
          );
          return {
            provider: 'BYBIT',
            environment: 'DEMO',
            executionMode: 'CONFIRM',
            result,
            execution: await dependencies.repository.getExecution(actor.id, 'BYBIT', sessionId),
          };
        }
        if (!stored.stopProtectionId || !stored.tp3ProtectionId || !stored.trailingProtectionId) {
          // Missing bookkeeping is not proof of missing exchange protection.
          // Inspect/recover native coverage or close under the same fresh scoped
          // authority; never return before inspecting the actual position.
          if (!adapter.recoverProtection) throw new Error('Safe native protection recovery is unavailable.');
          const protection = await adapter.recoverProtection(scope, lifecycleExecutionInput);
          await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
            stopProtectionId: protection.stopAlgoId,
            tp3ProtectionId: protection.tp3AlgoId,
            trailingProtectionId: protection.trailingAlgoId,
          }, authorizationId, lockToken);
          stored.stopProtectionId = protection.stopAlgoId;
          stored.tp3ProtectionId = protection.tp3AlgoId;
          stored.trailingProtectionId = protection.trailingAlgoId;
        }
        const ticker = await adapter.getTicker(scope, stored.symbol);
        const currentPrice = ticker.markPrice ?? ticker.lastPrice;
        if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(currentPrice) || Number(currentPrice) <= 0) {
          throw new Error('Bybit Demo returned an invalid reconciliation price.');
        }
        const reached = (target: string) => stored.direction === 'LONG'
          ? Number(currentPrice) >= Number(target)
          : Number(currentPrice) <= Number(target);
        const tp1Reached = stored.tp1ReachedAt !== null || reached(stored.tp1Price);
        const tp2Reached = stored.tp2ReachedAt !== null || reached(stored.tp2Price);
        const targets = {
          tp1Reached,
          tp2Reached,
          tp3Reached: reached(stored.tp3Price),
          // A price crossing proves a milestone, not native trailing activation.
          trailingActivated: stored.protectionStatus === 'TRAILING',
        };
        // Native SL/TP3/trailing can close between polls. Let the shared lifecycle
        // confirm zero and clean up before requiring protection on an open position.
        const observedPosition = await adapter.getPosition(scope, stored.symbol);
        if (!/^-?\d+(?:\.\d+)?$/.test(observedPosition.amount) ||
            !Number.isFinite(Number(observedPosition.amount))) {
          throw new Error('Bybit Demo returned an invalid reconciliation position.');
        }
        const observedFlat = Number(observedPosition.amount) === 0;
        const coverageVerified = observedFlat || !stored.stopProtectionId ||
          !stored.tp3ProtectionId || !stored.trailingProtectionId
          ? false
          : await adapter.verifyProtection(scope, lifecycleExecutionInput, {
            stopAlgoId: stored.stopProtectionId,
            tp3AlgoId: stored.tp3ProtectionId,
            trailingAlgoId: stored.trailingProtectionId,
          });
        // Known missing coverage goes to the shared emergency-close path. A
        // failed coverage read throws into explicit recovery without a blind close.
        const stage = coverageVerified && !targets.tp3Reached && adapter.reconcileStagedProtection
          ? await adapter.reconcileStagedProtection(scope, lifecycleExecutionInput, targets)
          : null;
        if (stage) {
          targets.tp1Reached = stage.tp1Reached;
          targets.tp2Reached = stage.tp2Reached;
          targets.trailingActivated = stage.trailingActivated;
        }
        if (coverageVerified && !targets.tp3Reached && targets.tp2Reached &&
            (!stage || stage.tp2Update === 'UNSUPPORTED_RETAINED')) {
          // Fail closed on the unsupported *update*, retaining native full-position
          // SL/TP3 and the single existing trailing stop for disconnect safety.
          await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
            executionStatus: 'RECONCILIATION_REQUIRED',
            tp1Reached: targets.tp1Reached,
            tp2Reached: true,
          }, authorizationId, lockToken);
          await dependencies.repository.appendAuditEvent({
            adminUserId: actor.id, provider: 'BYBIT', sessionId, authorizationId,
            eventType: 'RECONCILIATION_REQUIRED', eventStatus: 'BLOCKED',
            safeDetails: {
              environment: 'DEMO', reason: 'TP2_TRAILING_UPDATE_UNSUPPORTED',
              existingProtectionRetained: true, partialExitSubmitted: false,
            },
          });
          return {
            provider: 'BYBIT', environment: 'DEMO', executionMode: 'CONFIRM',
            result: 'UNCERTAIN' as const,
            limitation: 'TP2_TRAILING_UPDATE_UNSUPPORTED',
            execution: await dependencies.repository.getExecution(actor.id, 'BYBIT', sessionId),
          };
        }
        const lifecycle = lifecycleSet.lifecycle;
        const result = await lifecycle.reconcile(
          scope,
          lifecycleExecutionInput,
          targets,
        );
        return {
          provider: 'BYBIT',
          environment: 'DEMO',
          executionMode: 'CONFIRM',
          result,
          execution: await dependencies.repository.getExecution(actor.id, 'BYBIT', sessionId),
        };
      } catch (error) {
        // Persist an explicit recovery state even when provider reads, native
        // protection verification, or cleanup time out; never infer safety.
        await dependencies.repository.updateExecutionProgress(actor.id, 'BYBIT', sessionId, {
          executionStatus: 'RECONCILIATION_REQUIRED',
        }, authorizationId, lockToken);
        await dependencies.repository.appendAuditEvent({
          adminUserId: actor.id, provider: 'BYBIT', sessionId, authorizationId,
          eventType: 'RECONCILIATION_REQUIRED', eventStatus: 'UNCERTAIN',
          safeDetails: { environment: 'DEMO', reason: 'LIFECYCLE_STATE_UNVERIFIED', protectionRemovalRequested: false },
        });
        throw error;
      } finally {
        await dependencies.repository.releaseReconciliation(actor.id, 'BYBIT', sessionId, lockToken);
      }
    },
  };
}

export async function createServerAdminDemoProviderService() {
  if (!isApprovedAdminDemoStagingTarget(process.env)) {
    throw new Error('Admin Demo provider state is unavailable outside an approved staging target.');
  }
  if (process.env.SMARTEXIT_ADMIN_DEMO_REMOTE_SERVICE_ENABLED !== 'true') {
    throw new Error('Admin Demo provider remote service is disabled.');
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Admin Demo provider state is unavailable.');
  }
  let supabaseUrl: URL;
  try {
    supabaseUrl = new URL(url);
  } catch {
    throw new Error('Admin Demo provider state is unavailable.');
  }
  if (
    !['https:', 'http:'].includes(supabaseUrl.protocol) ||
    (supabaseUrl.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(supabaseUrl.hostname))
  ) {
    throw new Error('Admin Demo provider state is unavailable.');
  }

  const serviceClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const repository = createAdminDemoProviderRepository({
    query: async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      const result = await pool().query<Row>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    async transaction<Result>(work: (query: AdminDemoProviderQuery) => Promise<Result>) {
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        const result = await work(async <Row extends Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ) => {
          const queryResult = await client.query<Row>(sql, values ? [...values] : []);
          return { rows: queryResult.rows, rowCount: queryResult.rowCount };
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async rpc(functionName, parameters) {
      const result = await serviceClient.rpc(functionName, parameters);
      return {
        data: result.data,
        error: result.error ? { code: result.error.code ?? undefined } : null,
      };
    },
  });
  return createAdminDemoProviderService({ repository, bybitLifecycleEnabledForTests: false });
}

function capabilitiesForProvider(provider: AdminDemoProvider): Readonly<AdminDemoProviderCapabilities> {
  if (provider === 'BINANCE') return binanceCapabilities;
  if (provider === 'BITGET') return unsupportedCapabilities;
  if (provider === 'BYBIT') {
    return Object.freeze({
      ...DISABLED_ADMIN_DEMO_CAPABILITIES,
      connectionTest: true,
      balance: true,
      instruments: true,
      positions: true,
      entryPreflight: true,
    });
  }
  if (provider === 'OKX' || provider === 'GATE') {
    return Object.freeze({
      ...DISABLED_ADMIN_DEMO_CAPABILITIES,
      connectionTest: true,
      balance: true,
      instruments: true,
      positions: true,
    });
  }
  return unsupportedCapabilities;
}

function emptyStatus(
  provider: AdminDemoProvider,
  environment: AdminDemoProviderEnvironment,
): AdminDemoProviderCredentialStatus {
  return {
    provider,
    environment,
    configured: false,
    ownerConfirmed: false,
    enabled: false,
    revokedAt: null,
    createdAt: null,
    updatedAt: null,
  };
}

function normalizeLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Admin Demo history limit must be between 1 and 100.');
  }
  return limit;
}
