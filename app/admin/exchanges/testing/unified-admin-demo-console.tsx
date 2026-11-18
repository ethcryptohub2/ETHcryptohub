'use client';

import { useCallback, useRef, useState, type FormEvent } from 'react';
import {
  ADMIN_DEMO_PROVIDERS,
  ADMIN_DEMO_PROVIDER_ENVIRONMENTS,
  isAdminDemoProvider,
  isAdminDemoProviderEnvironment,
  type AdminDemoProvider,
  type AdminDemoProviderCapabilities,
} from '../../../../lib/admin-demo-provider-contract';
import type {
  AdminDemoProviderAccountSnapshot,
  AdminDemoProviderCredentialStatus,
  AdminDemoProviderInfo,
  AdminDemoProviderSession,
} from '../../../../lib/admin-demo-provider-backend-contract';
import { BinanceDemoConsole } from './binance-demo-console';

const PROVIDER_NAMES: Record<AdminDemoProvider, string> = {
  BINANCE: 'Binance',
  BYBIT: 'Bybit',
  OKX: 'OKX',
  BITGET: 'Bitget',
  GATE: 'Gate',
};

const CAPABILITY_LABELS: Array<[keyof AdminDemoProviderCapabilities, string]> = [
  ['connectionTest', 'Connection test'],
  ['balance', 'Read balance'],
  ['positions', 'Read positions'],
  ['instruments', 'Read supported contracts'],
  ['entryPreflight', 'Read-only entry preflight'],
  ['adminLifecycle', 'Admin test sessions'],
  ['marketEntry', 'Market entry'],
  ['limitEntry', 'Limit entry'],
  ['stopLossProtection', 'Stop-loss protection'],
  ['takeProfitProtection', 'Take-profit protection'],
  ['trailingProtection', 'Trailing protection'],
  ['reduceOnlyClose', 'Reduce-only close'],
  ['reconciliation', 'Reconciliation'],
];

type JsonRecord = Record<string, unknown>;
type ProviderState = {
  info: AdminDemoProviderInfo;
  credential: AdminDemoProviderCredentialStatus | null;
  account: AdminDemoProviderAccountSnapshot | null;
  sessions: AdminDemoProviderSession[];
  history: JsonRecord[];
  warnings: string[];
};

const EMPTY_CAPABILITIES: Readonly<AdminDemoProviderCapabilities> = {
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

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function responseData(value: unknown): unknown {
  return isRecord(value) ? value.data : undefined;
}

function arrayFrom(value: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

function safeCapabilities(value: unknown): Readonly<AdminDemoProviderCapabilities> {
  const capabilities = isRecord(value) ? value : {};
  return Object.fromEntries(
    Object.keys(EMPTY_CAPABILITIES).map((key) => [
      key,
      capabilities[key] === true,
    ]),
  ) as AdminDemoProviderCapabilities;
}

function safeErrorMessage(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.error === 'string' ? value.error : fallback;
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: 'no-store' });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(safeErrorMessage(body, `Request failed (${response.status}).`));
  return body;
}

async function csrfToken(): Promise<string> {
  const body = await requestJson('/api/csrf');
  const data = responseData(body);
  if (!isRecord(data) || typeof data.csrfToken !== 'string') {
    throw new Error('Secure session unavailable.');
  }
  return data.csrfToken;
}

async function secureJson(path: string, method: 'POST' | 'DELETE', payload?: JsonRecord): Promise<unknown> {
  const token = await csrfToken();
  return requestJson(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
}

function firstRecord(value: unknown): JsonRecord | null {
  if (isRecord(value)) return value;
  return null;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function dateValue(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function validatePreflightPlan(plan: {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: string;
  entryPrice: string;
  stopLoss: string;
  tp1Price: string;
  tp2Price: string;
  tp3Price: string;
  tickSize: string;
}): string | null {
  if (!/^[A-Z0-9:_-]{2,40}$/.test(plan.symbol)) {
    return 'Enter a valid contract symbol (2–40 uppercase letters, digits, colon, underscore, or hyphen).';
  }
  const decimalFields = [
    ['Quantity', plan.quantity],
    ['Entry price', plan.entryPrice],
    ['Stop-loss price', plan.stopLoss],
    ['TP1 price', plan.tp1Price],
    ['TP2 price', plan.tp2Price],
    ['TP3 price', plan.tp3Price],
    ['Tick size', plan.tickSize],
  ] as const;
  for (const [label, value] of decimalFields) {
    if (
      !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ||
      !Number.isFinite(Number(value)) ||
      Number(value) <= 0
    ) {
      return `${label} must be a positive decimal number.`;
    }
  }

  const entry = Number(plan.entryPrice);
  const stop = Number(plan.stopLoss);
  const targets = [plan.tp1Price, plan.tp2Price, plan.tp3Price].map(Number);
  const orderedPlan = plan.direction === 'LONG'
    ? stop < entry && entry < targets[0] && targets[0] < targets[1] && targets[1] < targets[2]
    : stop > entry && entry > targets[0] && targets[0] > targets[1] && targets[1] > targets[2];
  return orderedPlan
    ? null
    : 'Prices must be ordered consistently with the selected direction.';
}

function readProviderInfo(data: unknown, provider: AdminDemoProvider): AdminDemoProviderInfo {
  const providers = arrayFrom(data, 'providers', 'items');
  const found = providers.find((item) => isRecord(item) && item.provider === provider);
  const candidate = firstRecord(found) ?? (isRecord(data) && data.provider === provider ? data : null);
  if (
    !candidate ||
    candidate.provider !== provider ||
    !isAdminDemoProviderEnvironment(provider, candidate.environment)
  ) {
    throw new Error('Provider status is unavailable or does not match its fixed environment.');
  }
  return {
    provider,
    environment: ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider],
    capabilities: safeCapabilities(candidate.capabilities),
    credential: isRecord(candidate.credential)
      ? candidate.credential as unknown as AdminDemoProviderCredentialStatus
      : {
          provider,
          environment: ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider],
          configured: false,
          ownerConfirmed: false,
          enabled: false,
          revokedAt: null,
          createdAt: null,
          updatedAt: null,
        },
  };
}

function readCredential(data: unknown, provider: AdminDemoProvider): AdminDemoProviderCredentialStatus | null {
  const record = isRecord(data) && isRecord(data.credential) ? data.credential : data;
  if (!isRecord(record) || record.provider !== provider) return null;
  if (!isAdminDemoProviderEnvironment(provider, record.environment)) return null;
  return record as unknown as AdminDemoProviderCredentialStatus;
}

function readAccount(data: unknown, provider: AdminDemoProvider): AdminDemoProviderAccountSnapshot | null {
  if (!isRecord(data) || data.provider !== provider) return null;
  if (!isAdminDemoProviderEnvironment(provider, data.environment)) return null;
  return {
    provider,
    environment: ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider],
    connected: data.connected === true,
    capabilities: safeCapabilities(data.capabilities),
    balances: Array.isArray(data.balances) ? data.balances as AdminDemoProviderAccountSnapshot['balances'] : [],
    instruments: Array.isArray(data.instruments) ? data.instruments as AdminDemoProviderAccountSnapshot['instruments'] : [],
    positions: Array.isArray(data.positions) ? data.positions as AdminDemoProviderAccountSnapshot['positions'] : [],
  };
}

function readSessions(data: unknown): AdminDemoProviderSession[] {
  return arrayFrom(data, 'sessions', 'items').filter(isRecord) as unknown as AdminDemoProviderSession[];
}

function historyItems(data: unknown): JsonRecord[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];
  return [
    ...arrayFrom(data, 'executions', 'items'),
    ...arrayFrom(data, 'auditEvents', 'events'),
  ].filter(isRecord);
}

async function loadProvider(provider: AdminDemoProvider): Promise<ProviderState> {
  const providersBody = await requestJson('/api/admin/demo/providers');
  const info = readProviderInfo(responseData(providersBody), provider);

  if (provider === 'BITGET') {
    return { info, credential: info.credential, account: null, sessions: [], history: [], warnings: [] };
  }

  const prefix = `/api/admin/demo/providers/${provider}`;
  const canReadAccount =
    info.capabilities.connectionTest &&
    info.capabilities.balance &&
    info.capabilities.positions &&
    info.capabilities.instruments;
  const [credentialsResult, accountResult, sessionsResult, historyResult] = await Promise.allSettled([
    requestJson(`${prefix}/credentials`),
    canReadAccount
      ? requestJson(`${prefix}/account`)
      : Promise.resolve(null),
    requestJson(`${prefix}/sessions`),
    requestJson(`${prefix}/history`),
  ]);
  const credentialData = credentialsResult.status === 'fulfilled'
    ? responseData(credentialsResult.value)
    : null;
  const accountData = accountResult.status === 'fulfilled' && accountResult.value
    ? responseData(accountResult.value)
    : null;
  const warnings = [
    ...(credentialsResult.status === 'rejected'
      ? [`Credential status: ${credentialsResult.reason instanceof Error ? credentialsResult.reason.message : 'unavailable'}`]
      : []),
    ...(accountResult.status === 'rejected'
      ? [`Account status: ${accountResult.reason instanceof Error ? accountResult.reason.message : 'unavailable'}`]
      : []),
    ...(sessionsResult.status === 'rejected'
      ? [`Sessions: ${sessionsResult.reason instanceof Error ? sessionsResult.reason.message : 'unavailable'}`]
      : []),
    ...(historyResult.status === 'rejected'
      ? [`History: ${historyResult.reason instanceof Error ? historyResult.reason.message : 'unavailable'}`]
      : []),
  ];
  return {
    info,
    credential: readCredential(credentialData, provider) ?? info.credential,
    account: accountData ? readAccount(accountData, provider) : null,
    sessions: sessionsResult.status === 'fulfilled'
      ? readSessions(responseData(sessionsResult.value))
      : [],
    history: historyResult.status === 'fulfilled'
      ? historyItems(responseData(historyResult.value))
      : [],
    warnings,
  };
}

function ProviderAccount({ account }: { account: AdminDemoProviderAccountSnapshot }) {
  return (
    <article className="card stack">
      <h3>Read-only account</h3>
      <p className="muted" role="status">{account.connected ? 'Connection verified.' : 'Connection not verified.'}</p>
      {account.capabilities.balance && (
        <section className="stack" aria-labelledby="admin-demo-balances-heading">
          <h4 id="admin-demo-balances-heading">Balances</h4>
          {account.balances.length === 0 ? <p className="muted">No balances returned.</p> : (
            <div className="notification-control-grid">
              {account.balances.map((balance, index) => (
                <p className="muted" key={`${balance.asset}-${index}`}>
                  <strong>{balance.asset}</strong> · Wallet {balance.walletBalance} · Available {balance.availableBalance}
                  {balance.equity ? ` · Equity ${balance.equity}` : ''}
                  {` · Unrealized PnL ${balance.unrealizedPnl}`}
                </p>
              ))}
            </div>
          )}
        </section>
      )}
      {account.capabilities.positions && (
        <section className="stack" aria-labelledby="admin-demo-positions-heading">
          <h4 id="admin-demo-positions-heading">Positions</h4>
          {account.positions.length === 0 ? <p className="muted">No open positions returned.</p> : (
            <div className="notification-control-grid">
              {account.positions.map((position, index) => (
                <p className="muted" key={`${position.symbol}-${position.side}-${index}`}>
                  <strong>{position.symbol}</strong> · {position.side} · Quantity {position.quantity}
                  {` · Entry ${position.entryPrice} · Mark ${position.markPrice ?? '—'} · Unrealized PnL ${position.unrealizedPnl}`}
                </p>
              ))}
            </div>
          )}
        </section>
      )}
      {account.capabilities.instruments && (
        <section className="stack" aria-labelledby="admin-demo-contracts-heading">
          <h4 id="admin-demo-contracts-heading">Supported contracts</h4>
          {account.instruments.length === 0 ? <p className="muted">No supported contracts returned.</p> : (
            <div className="notification-control-grid">
              {account.instruments.map((instrument) => (
                <p className="muted" key={instrument.exchangeSymbol}>
                  <strong>{instrument.exchangeSymbol}</strong> · {instrument.contractType} · {instrument.status}
                  {` · Tick ${instrument.tickSize} · Quantity step ${instrument.quantityStep}`}
                </p>
              ))}
            </div>
          )}
        </section>
      )}
    </article>
  );
}

export function UnifiedAdminDemoConsole() {
  const [provider, setProvider] = useState<AdminDemoProvider>('BINANCE');
  const refreshSequence = useRef(0);
  const [providerState, setProviderState] = useState<ProviderState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [quantity, setQuantity] = useState('0.001');
  const [entryPrice, setEntryPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [tp1Price, setTp1Price] = useState('');
  const [tp2Price, setTp2Price] = useState('');
  const [tp3Price, setTp3Price] = useState('');
  const [tickSize, setTickSize] = useState('');
  const [preflightMessage, setPreflightMessage] = useState('');
  const [authorizationIds, setAuthorizationIds] = useState<Record<string, string>>({});
  const environment = ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider];
  const isBinance = provider === 'BINANCE';

  const refresh = useCallback(async (selectedProvider: AdminDemoProvider): Promise<boolean> => {
    const sequence = ++refreshSequence.current;
    setLoading(true);
    setError('');
    setProviderState(null);
    try {
      const state = await loadProvider(selectedProvider);
      if (sequence !== refreshSequence.current) return false;
      setProviderState(state);
      return true;
    } catch (reason) {
      if (sequence === refreshSequence.current) {
        setError(reason instanceof Error ? reason.message : 'Provider status is unavailable.');
      }
      return false;
    } finally {
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }, []);

  async function saveCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ownerConfirmed) {
      setError('Confirm that these credentials belong to the selected Admin Demo/Testnet environment.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    const payload: JsonRecord = {
      apiKey,
      apiSecret,
      ownerConfirmed: true,
      environment: ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider],
    };
    if (passphrase) payload.passphrase = passphrase;
    try {
      await secureJson(`/api/admin/demo/providers/${provider}/credentials`, 'POST', payload);
      setApiKey('');
      setApiSecret('');
      setPassphrase('');
      setMessage('Credentials saved. The secret fields have been cleared.');
      setOwnerConfirmed(false);
      await refresh(provider);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Credential save failed.');
    } finally {
      setApiKey('');
      setApiSecret('');
      setPassphrase('');
      setBusy(false);
    }
  }

  async function revokeCredentials() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await secureJson(`/api/admin/demo/providers/${provider}/credentials`, 'DELETE', {
        environment: ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider],
      });
      setMessage('Credentials revoked.');
      await refresh(provider);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Credential revocation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const body = await requestJson(`/api/admin/demo/providers/${provider}/account`);
      const account = readAccount(responseData(body), provider);
      if (!account) throw new Error('Provider account response did not match its fixed environment.');
      setProviderState((current) => current ? { ...current, account } : current);
      setMessage(account.connected
        ? 'Connection verified; read-only account data refreshed.'
        : 'Account data refreshed, but the backend did not verify the connection.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Connection test failed.');
    } finally {
      setBusy(false);
    }
  }

  async function runPreflight() {
    const config = {
      symbol: symbol.trim().toUpperCase(),
      direction,
      quantity: quantity.trim(),
      entryPrice: entryPrice.trim(),
      stopLoss: stopLoss.trim(),
      tp1Price: tp1Price.trim(),
      tp2Price: tp2Price.trim(),
      tp3Price: tp3Price.trim(),
      tickSize: tickSize.trim(),
    };
    const validationError = validatePreflightPlan(config);
    if (validationError) {
      setError(validationError);
      setPreflightMessage('');
      return;
    }
    setBusy(true);
    setError('');
    setPreflightMessage('');
    try {
      const body = await secureJson(
        `/api/admin/demo/providers/${provider}/preflight`,
        'POST',
        {
          config,
          environment: ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider],
        },
      );
      const data = responseData(body);
      const readiness = isRecord(data) && isRecord(data.result) && typeof data.result.ready === 'boolean'
        ? data.result.ready
        : null;
      const outcome = readiness === true
        ? 'checks passed; execution remains disabled'
        : readiness === false
          ? 'not ready'
          : 'completed without a readiness result';
      setPreflightMessage(`Read-only preflight ${outcome}. No order was submitted.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Read-only preflight failed.');
    } finally {
      setBusy(false);
    }
  }

  async function createSession() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await secureJson(`/api/admin/demo/providers/${provider}/sessions`, 'POST', {
        environment: ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider],
      });
      setMessage('Admin test session created.');
      await refresh(provider);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Session creation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function authorizeSession(sessionId: string) {
    setBusy(true);
    setError('');
    try {
      const body = await secureJson(
        `/api/admin/demo/providers/${provider}/authorization`,
        'POST',
        { action: 'create', sessionId, environment: ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider] },
      );
      const data = responseData(body);
      const authorization = isRecord(data) && isRecord(data.authorization) ? data.authorization : data;
      if (isRecord(authorization) && typeof authorization.id === 'string') {
        setAuthorizationIds((current) => ({ ...current, [sessionId]: authorization.id as string }));
      }
      setMessage('Authorization request completed. No order was submitted.');
      await refresh(provider);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Session authorization failed.');
    } finally {
      setBusy(false);
    }
  }

  async function reconcileSession(sessionId: string) {
    const authorizationId = authorizationIds[sessionId];
    if (!authorizationId) return;
    setBusy(true);
    setError('');
    try {
      await secureJson(
        `/api/admin/demo/providers/${provider}/reconcile`,
        'POST',
        { sessionId, authorizationId, environment: ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider] },
      );
      setMessage('Reconciliation request completed.');
      await refresh(provider);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Session reconciliation failed.');
    } finally {
      setBusy(false);
    }
  }

  const capabilities = providerState?.info.capabilities ?? EMPTY_CAPABILITIES;
  const credential = providerState?.credential ?? null;
  const validStatus = Boolean(
    providerState &&
    providerState.info.provider === provider &&
    providerState.info.environment === environment,
  );
  const hasReadAccountCapability =
    capabilities.connectionTest &&
    capabilities.balance &&
    capabilities.positions &&
    capabilities.instruments;
  const canAuthorize = capabilities.adminLifecycle && (capabilities.marketEntry || capabilities.limitEntry);

  return (
    <section className="stack" aria-labelledby="admin-demo-provider-heading">
      <article className="card stack">
        <p className="mono">UNIFIED ADMIN DEMO · FIXED PROVIDER ENVIRONMENTS</p>
        <h2 id="admin-demo-provider-heading">Provider availability</h2>
        <label htmlFor="admin-demo-provider">Exchange provider</label>
        <select
          id="admin-demo-provider"
          value={provider}
          onChange={(event) => {
            const selectedProvider = event.currentTarget.value;
            if (!isAdminDemoProvider(selectedProvider)) return;
            refreshSequence.current += 1;
            setProvider(selectedProvider);
            setProviderState(null);
            setLoading(false);
            setError('');
            setMessage('');
            setApiKey('');
            setApiSecret('');
            setPassphrase('');
            setOwnerConfirmed(false);
            setAuthorizationIds({});
            setPreflightMessage('');
            if (selectedProvider !== 'BINANCE') void refresh(selectedProvider);
          }}
          aria-describedby="admin-demo-provider-status admin-demo-provider-capabilities"
        >
          {ADMIN_DEMO_PROVIDERS.map((id) => (
            <option key={id} value={id}>{PROVIDER_NAMES[id]}</option>
          ))}
        </select>

        <div id="admin-demo-provider-status" role="status" className="stack">
          <p>
            <strong>{PROVIDER_NAMES[provider]} · {environment}</strong>
            {' · '}
            {isBinance ? 'Integrated Binance Admin lifecycle' : loading
              ? 'Loading backend status…'
              : validStatus
                ? (providerState?.info.capabilities.adminLifecycle
                    ? 'Admin lifecycle enabled by backend'
                    : Object.values(providerState?.info.capabilities ?? {}).some(Boolean)
                      ? 'Read-only capabilities enabled by backend'
                      : 'No capabilities enabled by backend')
                : 'Backend status unavailable'}
          </p>
          <p className="muted">
            {provider === 'GATE'
              ? 'Gate uses TESTNET. It is not labeled or treated as DEMO.'
              : `${PROVIDER_NAMES[provider]} uses its fixed DEMO environment.`}
          </p>
        </div>

        <div id="admin-demo-provider-capabilities">
          <h3>Lifecycle capabilities</h3>
          {isBinance ? (
            <ul className="stack">
              <li>Dedicated Demo credential status and management</li>
              <li>Isolated Admin test sessions and temporary authorization</li>
              <li>Read-only preflight, explicitly confirmed Demo test, and reconciliation</li>
              <li>Session and test history</li>
            </ul>
          ) : loading ? (
            <p className="muted">Loading capabilities from the Admin provider API…</p>
          ) : providerState ? (
            <ul className="stack">
              {CAPABILITY_LABELS.map(([key, label]) => (
                <li key={key}>{label}: {capabilities[key] ? 'enabled' : 'disabled'}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">Capabilities remain disabled until backend status is available.</p>
          )}
        </div>
      </article>

      {isBinance ? <BinanceDemoConsole /> : (
        <>
          {loading && <article className="card" role="status"><p className="muted">Loading {PROVIDER_NAMES[provider]} Admin status…</p></article>}
          {error && <p className="error" role="alert">{error}</p>}
          {message && <p className="success" role="status">{message}</p>}

          {provider === 'BITGET' ? (
            <article className="card stack">
              <h2>Bitget Admin Demo unavailable</h2>
              <p className="muted">
                Bitget is unsupported. No credential, account, session, or history API requests are made for this provider.
              </p>
            </article>
          ) : providerState && validStatus && (
            <>
              <article className="card stack">
                <p className="mono">{PROVIDER_NAMES[provider]} · {environment} · ADMIN CREDENTIALS</p>
                <h2>Credential status</h2>
                <p className="muted">
                  {credential?.configured
                    ? `Server status: configured${credential.ownerConfirmed ? ' · owner confirmed' : ''}${credential.updatedAt ? ` · updated ${dateValue(credential.updatedAt)}` : ''}`
                    : 'Server status: no active credentials.'}
                </p>
                <p className="muted">
                  Credentials are sent only to the Admin API, are never stored in browser storage, and are not displayed after submission.
                </p>
                <form className="notification-control-grid" onSubmit={(event) => void saveCredentials(event)}>
                  <label htmlFor="admin-demo-api-key">API key
                    <input
                      id="admin-demo-api-key"
                      type="password"
                      autoComplete="new-password"
                      value={apiKey}
                      maxLength={256}
                      onChange={(event) => setApiKey(event.currentTarget.value)}
                      required
                    />
                  </label>
                  <label htmlFor="admin-demo-api-secret">API secret
                    <input
                      id="admin-demo-api-secret"
                      type="password"
                      autoComplete="new-password"
                      value={apiSecret}
                      maxLength={512}
                      onChange={(event) => setApiSecret(event.currentTarget.value)}
                      required
                    />
                  </label>
                  {provider === 'OKX' && (
                    <label htmlFor="admin-demo-passphrase">API passphrase
                      <input
                        id="admin-demo-passphrase"
                        type="password"
                        autoComplete="new-password"
                        value={passphrase}
                        maxLength={256}
                        onChange={(event) => setPassphrase(event.currentTarget.value)}
                        required
                      />
                    </label>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={ownerConfirmed}
                      onChange={(event) => setOwnerConfirmed(event.currentTarget.checked)}
                    />
                    I confirm these credentials belong to my {environment} {PROVIDER_NAMES[provider]} account.
                  </label>
                  <div className="links">
                    <button type="submit" disabled={busy || !ownerConfirmed || !apiKey || !apiSecret || (provider === 'OKX' && !passphrase)}>
                      Save {environment} credentials
                    </button>
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={busy || !credential?.configured}
                      onClick={() => void revokeCredentials()}
                    >
                      Revoke credentials
                    </button>
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={busy || !credential?.configured || !hasReadAccountCapability}
                      onClick={() => void testConnection()}
                    >
                      Test connection / refresh account
                    </button>
                  </div>
                </form>
              </article>

              {providerState.account && <ProviderAccount account={providerState.account} />}
              {providerState.warnings.map((warning) => (
                <p className="error" role="alert" key={warning}>{warning}</p>
              ))}
              {!hasReadAccountCapability && (
                <article className="card stack">
                  <h2>Read-only account</h2>
                  <p className="muted">Balance, positions, and supported-contract reads are disabled by backend capabilities.</p>
                </article>
              )}

              {capabilities.entryPreflight && (
                <article className="card stack">
                  <h2>Read-only preflight</h2>
                  <p className="muted">Preflight does not submit orders or change the exchange account. All plan values are validated locally before the read-only request.</p>
                  <div className="notification-control-grid">
                    <label htmlFor="admin-demo-preflight-symbol">Contract symbol
                      <input
                        id="admin-demo-preflight-symbol"
                        value={symbol}
                        maxLength={40}
                        onChange={(event) => setSymbol(event.currentTarget.value.toUpperCase())}
                      />
                    </label>
                    <label htmlFor="admin-demo-preflight-direction">Direction
                      <select id="admin-demo-preflight-direction" value={direction} onChange={(event) => setDirection(event.currentTarget.value as 'LONG' | 'SHORT')}>
                        <option value="LONG">Long</option>
                        <option value="SHORT">Short</option>
                      </select>
                    </label>
                    <label htmlFor="admin-demo-preflight-quantity">Quantity
                      <input
                        id="admin-demo-preflight-quantity"
                        inputMode="decimal"
                        value={quantity}
                        maxLength={30}
                        onChange={(event) => setQuantity(event.currentTarget.value)}
                      />
                    </label>
                    <label htmlFor="admin-demo-preflight-entry">Entry price
                      <input id="admin-demo-preflight-entry" inputMode="decimal" value={entryPrice} maxLength={40} onChange={(event) => setEntryPrice(event.currentTarget.value)} />
                    </label>
                    <label htmlFor="admin-demo-preflight-stop">Stop-loss price
                      <input id="admin-demo-preflight-stop" inputMode="decimal" value={stopLoss} maxLength={40} onChange={(event) => setStopLoss(event.currentTarget.value)} />
                    </label>
                    <label htmlFor="admin-demo-preflight-tp1">TP1 price
                      <input id="admin-demo-preflight-tp1" inputMode="decimal" value={tp1Price} maxLength={40} onChange={(event) => setTp1Price(event.currentTarget.value)} />
                    </label>
                    <label htmlFor="admin-demo-preflight-tp2">TP2 price
                      <input id="admin-demo-preflight-tp2" inputMode="decimal" value={tp2Price} maxLength={40} onChange={(event) => setTp2Price(event.currentTarget.value)} />
                    </label>
                    <label htmlFor="admin-demo-preflight-tp3">TP3 price
                      <input id="admin-demo-preflight-tp3" inputMode="decimal" value={tp3Price} maxLength={40} onChange={(event) => setTp3Price(event.currentTarget.value)} />
                    </label>
                    <label htmlFor="admin-demo-preflight-tick-size">Tick size
                      <input id="admin-demo-preflight-tick-size" inputMode="decimal" value={tickSize} maxLength={40} onChange={(event) => setTickSize(event.currentTarget.value)} />
                    </label>
                  </div>
                  <button
                    type="button"
                    disabled={busy || !credential?.configured || Boolean(validatePreflightPlan({
                      symbol: symbol.trim().toUpperCase(),
                      direction,
                      quantity: quantity.trim(),
                      entryPrice: entryPrice.trim(),
                      stopLoss: stopLoss.trim(),
                      tp1Price: tp1Price.trim(),
                      tp2Price: tp2Price.trim(),
                      tp3Price: tp3Price.trim(),
                      tickSize: tickSize.trim(),
                    }))}
                    onClick={() => void runPreflight()}
                  >
                    Run read-only preflight
                  </button>
                  {preflightMessage && <p className="success" role="status">{preflightMessage}</p>}
                </article>
              )}

              <article className="card stack">
                <h2>Admin test sessions</h2>
                <p className="muted">Session state and history are returned by the Admin backend. This console has no order submission control.</p>
                <button type="button" disabled={busy || !capabilities.adminLifecycle || !credential?.configured} onClick={() => void createSession()}>
                  Create Admin test session
                </button>
                {providerState.sessions.length === 0 ? <p className="muted">No Admin test sessions returned.</p> : (
                  providerState.sessions.map((session) => (
                    <article className="card stack" key={session.id}>
                      <h3>Session {session.id}</h3>
                      <p className="muted">
                        Status: {session.status} · Environment: {session.environment} · Symbol: {session.symbol ?? '—'}
                        {` · Direction: ${session.direction ?? '—'} · Created: ${dateValue(session.createdAt)}`}
                      </p>
                      <div className="links">
                        <button
                          type="button"
                          disabled={busy || !canAuthorize || !credential?.configured}
                          onClick={() => void authorizeSession(session.id)}
                        >
                          Request test authorization
                        </button>
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={busy || !capabilities.reconciliation || !authorizationIds[session.id]}
                          onClick={() => void reconcileSession(session.id)}
                        >
                          Reconcile session
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </article>

              <article className="card stack">
                <h2>Session and test history</h2>
                {providerState.history.length === 0 ? <p className="muted">No provider history returned.</p> : (
                  providerState.history.map((item, index) => (
                    <p className="muted" key={typeof item.id === 'string' ? item.id : `history-${index}`}>
                      {formatValue(item.createdAt ?? item.created_at)} · {formatValue(item.eventType ?? item.event_type ?? item.executionStatus ?? item.execution_status)}
                      {` · ${formatValue(item.eventStatus ?? item.event_status ?? item.status)}`}
                      {item.sessionId || item.session_id ? ` · session ${formatValue(item.sessionId ?? item.session_id)}` : ''}
                    </p>
                  ))
                )}
              </article>
            </>
          )}
        </>
      )}
    </section>
  );
}
