'use client';

import { useEffect, useState, type FormEvent } from 'react';

type DemoConsoleState = {
  credentialStatus: {
    configured: boolean;
    ownerConfirmed: boolean;
    createdAt: string | null;
    updatedAt: string | null;
    revokedAt: string | null;
  };
  sessions: Array<{
    id: string;
    session_status: string;
    symbol: string | null;
    direction: string | null;
    created_at: string;
    started_at: string | null;
    ended_at: string | null;
  }>;
  credentialEvents: Array<{ event_type: string; created_at: string }>;
  remoteLifecycle: string;
};

type TradeConfig = {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: string;
  entryPrice: string;
  stopPrice: string;
  tp1Price: string;
  tp2Price: string;
  tp3Price: string;
  tickSize: string;
};

async function csrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

async function loadStatus() {
  const response = await fetch('/api/admin/binance/demo-testing', { cache: 'no-store' });
  const body = await response.json() as { data?: DemoConsoleState; error?: string };
  if (!response.ok || !body.data) throw new Error(body.error ?? 'Admin Demo status is unavailable.');
  return body.data;
}

export function BinanceDemoConsole() {
  const [state, setState] = useState<DemoConsoleState | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [sessionId, setSessionId] = useState('');
  const [authorizationId, setAuthorizationId] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [confirmation, setConfirmation] = useState(false);
  const [preflight, setPreflight] = useState<{ ready: boolean; details: string } | null>(null);
  const [executionStatus, setExecutionStatus] = useState('');
  const [history, setHistory] = useState<Array<{ event_type: string; event_status: string; created_at: string }>>([]);
  const [config, setConfig] = useState<TradeConfig>({
    symbol: 'BTCUSDT',
    direction: 'LONG',
    quantity: '',
    entryPrice: '',
    stopPrice: '',
    tp1Price: '',
    tp2Price: '',
    tp3Price: '',
    tickSize: '',
  });

  useEffect(() => {
    let active = true;
    void loadStatus()
      .then((status) => { if (active) setState(status); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Admin Demo status is unavailable.');
      });
    return () => { active = false; };
  }, []);

  async function submit(action: 'saveCredentials' | 'revokeCredentials', event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const token = await csrfToken();
      const payload = action === 'saveCredentials'
        ? { action, apiKey, apiSecret, confirmDemoIssued: confirmed }
        : { action };
      const response = await fetch('/api/admin/binance/demo-testing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { data?: DemoConsoleState; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Admin Demo account update failed.');
      setState(body.data);
      setApiKey('');
      setApiSecret('');
      setConfirmed(false);
      setMessage(action === 'saveCredentials'
        ? 'Dedicated Demo credentials were encrypted and saved. They have not been tested against Binance.'
        : 'Dedicated Demo credentials were revoked for future use.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Admin Demo account update failed.');
    } finally {
      setBusy(false);
    }
  }

  async function postJson<T>(url: string, payload: unknown): Promise<T> {
    const token = await csrfToken();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify(payload),
    });
    const body = await response.json() as { data?: T; error?: string };
    if (!response.ok || body.data === undefined) throw new Error(body.error ?? 'Admin Demo action is blocked.');
    return body.data;
  }

  function withConfirmation() {
    if (!confirmation) throw new Error('Explicit Demo-test confirmation is required.');
    return 'RUN_BINANCE_DEMO_LIFECYCLE';
  }

  async function createSession() {
    setBusy(true); setError(''); setMessage(''); setPreflight(null);
    try {
      const created = await postJson<{ id: string }>('/api/admin/binance/demo-testing/sessions', { symbol, direction });
      setSessionId(created.id);
      setAuthorizationId('');
      setIdempotencyKey('');
      setExecutionStatus('');
      setMessage(`Isolated Demo test session ${created.id} created. No exchange request was made.`);
      setState(await loadStatus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Admin Demo session creation failed.');
    } finally { setBusy(false); }
  }

  async function createAuthorization() {
    setBusy(true); setError(''); setMessage(''); setPreflight(null);
    try {
      const created = await postJson<{ id: string; expiresAt: string }>(
        '/api/admin/binance/demo-testing/authorization',
        { action: 'create', sessionId, expiresInSeconds: 600 },
      );
      setAuthorizationId(created.id);
      setMessage(`Temporary authorization ${created.id} expires ${new Date(created.expiresAt).toLocaleString()}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Authorization creation failed.');
    } finally { setBusy(false); }
  }

  async function renewReconciliationAuthorization() {
    setBusy(true); setError(''); setMessage(''); setPreflight(null);
    try {
      const renewed = await postJson<{ id: string; expiresAt: string }>(
        '/api/admin/binance/demo-testing/authorization',
        { action: 'renewReconciliation', sessionId, authorizationId, expiresInSeconds: 600 },
      );
      setAuthorizationId(renewed.id);
      setMessage(
        `Reconciliation-only authorization ${renewed.id} expires ${new Date(renewed.expiresAt).toLocaleString()}. It cannot start a new test.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Reconciliation authorization renewal failed.');
    } finally { setBusy(false); }
  }

  async function runPreflight() {
    setBusy(true); setError(''); setMessage(''); setPreflight(null);
    try {
      const confirmationValue = withConfirmation();
      const result = await postJson<{ ready: boolean; environment: string; endpoint: string; oneWayMode: boolean; symbolValid: boolean; quantityValid: boolean }>(
        '/api/admin/binance/demo-testing/preflight',
        { sessionId, authorizationId, confirmation: confirmationValue, config },
      );
      setPreflight({
        ready: result.ready && result.environment === 'DEMO' && result.endpoint === 'https://demo-fapi.binance.com',
        details: `Environment ${result.environment}; One-way ${result.oneWayMode ? 'confirmed' : 'blocked'}; symbol ${result.symbolValid ? 'valid' : 'blocked'}; quantity ${result.quantityValid ? 'valid' : 'blocked'}.`,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Demo preflight failed.');
    } finally { setBusy(false); }
  }

  async function startTest() {
    setBusy(true); setError(''); setMessage('');
    try {
      const confirmationValue = withConfirmation();
      const requestId = idempotencyKey ||
        `ad${sessionId}${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`.slice(0, 36);
      setIdempotencyKey(requestId);
      const result = await postJson<{ result: { status: string }; sessionId: string }>(
        '/api/admin/binance/demo-testing/executions',
        {
          sessionId, authorizationId,
          idempotencyKey: requestId,
          confirmation: confirmationValue,
          config,
        },
      );
      setExecutionStatus(result.result.status);
      setMessage(`Demo execution status: ${result.result.status}.`);
      await refreshSession();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Demo test execution failed.');
    } finally { setBusy(false); }
  }

  async function refreshSession() {
    if (!sessionId) return;
    const response = await fetch(`/api/admin/binance/demo-testing/sessions?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    const body = await response.json() as { data?: { execution?: { execution_status?: string } | null }; error?: string };
    if (!response.ok || !body.data) throw new Error(body.error ?? 'Admin Demo status is unavailable.');
    setExecutionStatus(body.data.execution?.execution_status ?? 'NO_EXECUTION');
  }

  async function reconcile() {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await postJson<{ result: string }>(
        '/api/admin/binance/demo-testing/reconcile',
        { sessionId, authorizationId, confirmation: withConfirmation() },
      );
      setExecutionStatus(result.result);
      setMessage(`Reconciliation state: ${result.result}.`);
      await refreshHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Admin Demo reconciliation failed.');
    } finally { setBusy(false); }
  }

  async function refreshHistory() {
    if (!sessionId) return;
    const response = await fetch(`/api/admin/binance/demo-testing/history?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    const body = await response.json() as { data?: typeof history; error?: string };
    if (!response.ok || !body.data) throw new Error(body.error ?? 'Admin Demo history is unavailable.');
    setHistory(body.data);
  }

  function updateConfig<K extends keyof TradeConfig>(key: K, value: TradeConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
    setPreflight(null);
  }

  return <section className="card stack" aria-labelledby="admin-binance-demo-title">
    <p className="mono">BINANCE · ADMIN DEMO · ISOLATED ACCOUNT</p>
    <h2 id="admin-binance-demo-title">Admin Demo test console</h2>
    <p className="muted">
      Credential storage is separate from customer credentials and uses the server encryption key. The confirmation below is an operator attestation, not proof of Binance key origin. Saving or viewing this page makes no Binance request.
    </p>
    {state ? <>
      <dl className="signal-detail-grid">
        <div><dt>Environment</dt><dd>DEMO · fixed endpoint only</dd></div>
        <div><dt>Dedicated credentials</dt><dd>{state.credentialStatus.configured && state.credentialStatus.ownerConfirmed ? 'Configured · owner-confirmed' : 'Not configured or revoked'}</dd></div>
        <div><dt>Last credential update</dt><dd>{state.credentialStatus.updatedAt ? new Date(state.credentialStatus.updatedAt).toLocaleString() : '—'}</dd></div>
        <div><dt>Remote lifecycle</dt><dd>{state.remoteLifecycle} · requires verified Preview, schema, credentials, authorization, preflight, and operator approval.</dd></div>
      </dl>
      <form className="notification-control-grid" onSubmit={(event) => void submit('saveCredentials', event)}>
        <label>Dedicated Binance Demo API Key
          <input autoComplete="off" maxLength={256} value={apiKey} onChange={(event) => setApiKey(event.target.value)} required />
        </label>
        <label>Dedicated Binance Demo API Secret
          <input type="password" autoComplete="new-password" maxLength={512} value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} required />
        </label>
        <div className="strategy-actions">
          <label className="notification-toggle">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required />
          I confirm these are dedicated Binance Futures Demo credentials for an isolated test account, with no withdrawal or transfer permissions.
          </label>
        </div>
        <div className="links">
          <button disabled={busy || !confirmed}>Save encrypted Demo credentials</button>
          <button type="button" className="button-secondary" disabled={busy || !state.credentialStatus.configured} onClick={() => void submit('revokeCredentials')}>Revoke credentials</button>
        </div>
      </form>
      <h3>Isolated test session</h3>
      <div className="notification-control-grid">
        <label>Symbol
          <input value={symbol} onChange={(event) => { setSymbol(event.target.value.toUpperCase()); updateConfig('symbol', event.target.value.toUpperCase()); }} maxLength={30} />
        </label>
        <label>Direction
          <select value={direction} onChange={(event) => {
            const value = event.target.value as 'LONG' | 'SHORT';
            setDirection(value); updateConfig('direction', value);
          }}>
            <option value="LONG">LONG</option><option value="SHORT">SHORT</option>
          </select>
        </label>
        <div className="links">
          <button type="button" disabled={busy || !state.credentialStatus.configured} onClick={() => void createSession()}>Create isolated session</button>
        </div>
        <label>Session ID
          <input value={sessionId} onChange={(event) => { setSessionId(event.target.value); setPreflight(null); setIdempotencyKey(''); }} inputMode="numeric" />
        </label>
        <div className="links">
          <button type="button" className="button-secondary" disabled={busy || !sessionId} onClick={() => void createAuthorization()}>Create 10-minute authorization</button>
          <button
            type="button"
            className="button-secondary"
            disabled={busy || !sessionId || !authorizationId || ![
              'ENTRY_SUBMITTING', 'ENTRY_UNKNOWN', 'ENTRY_FILLED', 'PROTECTED', 'RECONCILIATION_REQUIRED',
            ].includes(executionStatus)}
            onClick={() => void renewReconciliationAuthorization()}
          >
            Renew expired authorization for reconciliation only
          </button>
        </div>
        <label>Authorization ID
          <input value={authorizationId} onChange={(event) => { setAuthorizationId(event.target.value); setPreflight(null); }} inputMode="numeric" />
        </label>
      </div>
      <h3>Test configuration</h3>
      <div className="notification-control-grid">
        {([
          ['quantity', 'Quantity'], ['entryPrice', 'Reference entry price'], ['stopPrice', 'Initial Stop Loss'],
          ['tp1Price', 'TP1'], ['tp2Price', 'TP2'], ['tp3Price', 'TP3'], ['tickSize', 'Symbol tick size'],
        ] as const).map(([key, title]) => <label key={key}>{title}
          <input inputMode="decimal" value={config[key]} onChange={(event) => updateConfig(key, event.target.value)} />
        </label>)}
      </div>
      <label className="notification-toggle">
        <input type="checkbox" checked={confirmation} onChange={(event) => { setConfirmation(event.target.checked); setPreflight(null); }} />
        I explicitly authorize a Binance Demo preflight and, only after it passes, a test order for this isolated session.
      </label>
      <div className="links">
        <button type="button" className="button-secondary" disabled={busy || !confirmation || !sessionId || !authorizationId} onClick={() => void runPreflight()}>Run read-only Demo preflight</button>
        <button type="button" disabled={busy || !confirmation || !preflight?.ready || !sessionId || !authorizationId} onClick={() => void startTest()}>Start Demo Test</button>
        <button type="button" className="button-secondary" disabled={busy || !confirmation || !sessionId || !authorizationId || !executionStatus} onClick={() => void reconcile()}>Reconcile test</button>
        <button type="button" className="button-secondary" disabled={busy || !sessionId} onClick={() => void Promise.all([refreshSession(), refreshHistory()]).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Session refresh failed.'))}>Refresh session status</button>
      </div>
      {preflight && <p className={preflight.ready ? 'success' : 'error'} role="status">{preflight.ready ? 'PREFLIGHT READY' : 'PREFLIGHT BLOCKED'} · {preflight.details}</p>}
      {executionStatus && <p className="muted" role="status">Execution / reconciliation state: <strong>{executionStatus}</strong></p>}
      {history.length > 0 && <div><h3>Sanitized audit history</h3><ul className="stack">{history.map((event, index) =>
        <li key={`${event.event_type}-${event.created_at}-${index}`}><strong>{event.event_type} · {event.event_status}</strong><span className="muted"> {new Date(event.created_at).toLocaleString()}</span></li>,
      )}</ul></div>}
      <h3>Test session history</h3>
      {state.sessions.length
        ? <ul className="stack">{state.sessions.map((session) => <li key={session.id}>
          <strong>#{session.id} · {session.session_status}</strong>
          <span className="muted"> {session.symbol ?? 'No symbol'} {session.direction ?? ''} · {new Date(session.created_at).toLocaleString()}</span>
        </li>)}</ul>
        : <p className="muted">No isolated Admin Binance Demo sessions are recorded.</p>}
      <p className="muted">Controls make no exchange request unless explicitly invoked. Starting a test requires the approved Staging target, owner-confirmed dedicated credentials, the single-use temporary session authorization, the fixed Demo endpoint, and explicit operator confirmation. A persistent remote-test environment flag is rejected.</p>
    </> : <p className={error ? 'error' : 'muted'} role={error ? 'alert' : 'status'}>{error || 'Loading Admin Demo status…'}</p>}
    {message && <p className="success" role="status">{message}</p>}
    {error && state && <p className="error" role="alert">{error}</p>}
  </section>;
}
