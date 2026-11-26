'use client';

import { useEffect, useState, type FormEvent } from 'react';

type Environment = 'DEMO' | 'LIVE';

type DemoBalance = {
  walletBalance: string;
  availableBalance: string;
  unrealizedPnl: string;
  asset: string;
  lastUpdatedAt: string | null;
  synchronizedAt?: string;
};

export function BinanceForm({ onCredentialChange }: { onCredentialChange?: () => void } = {}) {
  const [environment, setEnvironment] = useState<Environment>('DEMO');
  const [configured, setConfigured] = useState(false);
  const [environmentConfirmationRequired, setEnvironmentConfirmationRequired] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [signedReadEnabled, setSignedReadEnabled] = useState(false);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<string | null>(null);
  const [demoBalance, setDemoBalance] = useState<DemoBalance | null>(null);
  const [balanceError, setBalanceError] = useState<string>('');
  const [openPositionsCount, setOpenPositionsCount] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/binance?environment=${environment}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as {
          data?: {
            configured: boolean;
            environmentConfirmationRequired?: boolean;
            signedReadEnabled?: boolean;
            updatedAt?: string | null;
            lastVerifiedAt?: string | null;
          };
          error?: string;
        };
        if (!response.ok || !body.data) throw new Error(body.error ?? 'Could not load Binance settings.');
        if (!controller.signal.aborted) {
          setConfigured(body.data.configured);
          setEnvironmentConfirmationRequired(body.data.environmentConfirmationRequired ?? false);
          setSignedReadEnabled(body.data.signedReadEnabled === true);
          setStorageReady(true);
          setLastVerifiedAt(body.data.lastVerifiedAt ?? null);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Could not load Binance settings.');
        }
      });
    return () => controller.abort();
  }, [environment]);

  // Fetch demo balance if configured in DEMO mode
  useEffect(() => {
    if (environment !== 'DEMO' || !configured) return;
    const controller = new AbortController();
    fetch('/api/binance/futures/balance?environment=DEMO', { cache: 'no-store', signal: controller.signal })
      .then(async (res) => {
        const json = (await res.json()) as { data?: DemoBalance; error?: string };
        if (!res.ok || !json.data) {
          throw new Error(json.error ?? 'Binance Demo balance snapshot unavailable.');
        }
        return json.data;
      })
      .then((data) => {
        if (!controller.signal.aborted && data) {
          setDemoBalance(data);
          setBalanceError('');
          setLastVerifiedAt((prev) => prev ?? data.synchronizedAt ?? new Date().toISOString());
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setBalanceError(err instanceof Error ? err.message : 'Balance unavailable');
        }
      });

    fetch('/api/trading/positions', { cache: 'no-store', signal: controller.signal })
      .then(async (res) => {
        const json = (await res.json()) as { data?: { positions?: unknown[] } };
        if (res.ok && json.data?.positions && !controller.signal.aborted) {
          setOpenPositionsCount(json.data.positions.length);
        }
      })
      .catch(() => {});

    return () => controller.abort();
  }, [environment, configured]);

  function selectEnvironment(next: Environment) {
    if (next === environment || busy) return;
    setEnvironment(next);
    setStorageReady(false);
    setSignedReadEnabled(false);
    setConfigured(false);
    setEnvironmentConfirmationRequired(false);
    setApiKey('');
    setApiSecret('');
    setConfirmed(false);
    setMessage('');
    setError('');
    setDemoBalance(null);
    setBalanceError('');
    setOpenPositionsCount(null);
  }

  async function submit(event: FormEvent, action: 'save' | 'test' | 'remove') {
    event.preventDefault();
    if (busy || (action === 'save' && !confirmed)) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = (await csrfResponse.json()) as { data?: { csrfToken: string } };
      if (!csrfResponse.ok || !csrfBody.data) throw new Error('Secure session unavailable.');
      const response = await fetch('/api/binance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfBody.data.csrfToken },
        body: JSON.stringify({
          action,
          environment,
          ...(action === 'save' ? { apiKey, apiSecret, confirmCredentialEnvironment: confirmed } : {}),
        }),
      });
      const body = (await response.json()) as {
        data?: { configured?: boolean; connected?: boolean; environment?: Environment };
        code?: string;
        error?: string;
      };
      if (!response.ok) {
        if (body.code === 'SIGNED_READ_BLOCKED') setSignedReadEnabled(false);
        if (
          body.code === 'SCHEMA_BLOCKED' ||
          body.code === 'ENCRYPTION_BLOCKED' ||
          body.code === 'ADMIN_APPROVAL_REQUIRED'
        ) {
          setStorageReady(false);
          setApiKey('');
          setApiSecret('');
          setConfirmed(false);
        }
        throw new Error(body.error ?? 'Binance request failed.');
      }
      if (action === 'remove') {
        setConfigured(false);
        setEnvironmentConfirmationRequired(false);
        setDemoBalance(null);
        setLastVerifiedAt(null);
      }
      if (action === 'save') {
        setConfigured(true);
        setEnvironmentConfirmationRequired(false);
        setApiKey('');
        setApiSecret('');
        setConfirmed(false);
        setLastVerifiedAt(null);
      }
      const label = environment === 'DEMO' ? 'Demo' : 'Live';
      if (action === 'test') {
        if (body.data?.connected !== true) throw new Error('Binance returned no account verification result.');
        setLastVerifiedAt(new Date().toISOString());
        setBalanceError('');
        setMessage(`✓ ${label} Binance account-read permission verified. Virtual balance accessible. No orders were placed.`);
        fetch('/api/binance/futures/balance?environment=DEMO', { cache: 'no-store' })
          .then(async (res) => {
            const bal = (await res.json()) as { data?: DemoBalance };
            if (res.ok && bal.data) setDemoBalance(bal.data);
          })
          .catch(() => {});
      } else if (action === 'remove') {
        setMessage(`${label} credentials removed.`);
      } else {
        setMessage(`${label} credentials encrypted and saved with AES-256-GCM.`);
      }
      onCredentialChange?.();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('smartexit-exchange-credential-synced'));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Binance request failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(event) => void submit(event, 'save')}>
      {/* Environment Selector Tabs */}
      <div className="links" role="tablist" aria-label="Binance API environment">
        <button
          type="button"
          role="tab"
          disabled={busy}
          aria-selected={environment === 'DEMO'}
          className={environment === 'DEMO' ? '' : 'button-secondary'}
          onClick={() => selectEnvironment('DEMO')}
        >
          ● Demo API (Virtual Funds)
        </button>
        <button
          type="button"
          role="tab"
          disabled={busy}
          aria-selected={environment === 'LIVE'}
          className={environment === 'LIVE' ? '' : 'button-secondary'}
          onClick={() => selectEnvironment('LIVE')}
        >
          🔒 Live API (Locked)
        </button>
      </div>

      {/* Prominent Demo Mode Banner */}
      {environment === 'DEMO' && (
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--surface-subtle)',
            borderRadius: 8,
            border: '1px solid var(--accent)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span className="mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
              BINANCE FUTURES DEMO &amp; TESTNET SANDBOX
            </span>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 99,
                fontSize: 11,
                fontWeight: 600,
                fontFamily: 'DM Mono',
                backgroundColor: configured ? '#f0fdf4' : 'var(--surface-raised)',
                color: configured ? '#166534' : 'var(--text-muted)',
              }}
            >
              {configured
                ? lastVerifiedAt
                  ? '✓ CONNECTED & VERIFIED'
                  : '● CONFIGURED'
                : '○ NOT CONFIGURED'}
            </span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Connects to Binance Futures Demo / Mock Trading with 100% virtual funds. Real funds are never involved or at risk.
          </p>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            💡 <strong>How to get keys:</strong> Log in to Binance → Futures → Mock Trading (or visit{' '}
            <a
              href="https://demo-fapi.binance.com"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent)', textDecoration: 'underline' }}
            >
              demo-fapi.binance.com
            </a>
            ) → Settings / API Keys → Generate virtual key. Keep withdrawal permissions disabled.
          </p>
        </div>
      )}

      {/* DEMO Balance Section */}
      {environment === 'DEMO' && (
        !configured ? (
          <div
            style={{
              padding: '12px 16px',
              background: 'var(--surface-raised)',
              borderRadius: 8,
              border: '1px dashed var(--surface-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              ○ <strong>Not Connected:</strong> No Binance Demo credentials are saved yet.
            </span>
            <small className="muted">Enter API key and secret below to connect virtual sandbox</small>
          </div>
        ) : demoBalance ? (
          <div
            style={{
              padding: '12px 16px',
              background: 'var(--surface-raised)',
              borderRadius: 8,
              border: '1px solid var(--accent)',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 12,
            }}
          >
            <div>
              <small className="muted" style={{ display: 'block', fontSize: 11 }}>DEMO WALLET BALANCE</small>
              <strong style={{ fontSize: 16, fontFamily: 'DM Mono', color: 'var(--accent)' }}>
                ${Number(demoBalance.walletBalance).toLocaleString(undefined, { minimumFractionDigits: 2 })} USDT
              </strong>
            </div>
            <div>
              <small className="muted" style={{ display: 'block', fontSize: 11 }}>AVAILABLE MARGIN</small>
              <strong style={{ fontSize: 16, fontFamily: 'DM Mono', color: '#10b981' }}>
                ${Number(demoBalance.availableBalance).toLocaleString(undefined, { minimumFractionDigits: 2 })} USDT
              </strong>
            </div>
            <div>
              <small className="muted" style={{ display: 'block', fontSize: 11 }}>UNREALIZED PNL</small>
              <strong style={{ fontSize: 16, fontFamily: 'DM Mono' }}>
                ${Number(demoBalance.unrealizedPnl).toLocaleString(undefined, { minimumFractionDigits: 2 })} USDT
              </strong>
            </div>
            <div>
              <small className="muted" style={{ display: 'block', fontSize: 11 }}>POSITIONS &amp; SYNC</small>
              <span style={{ fontSize: 12, fontFamily: 'DM Mono', color: 'var(--text-muted)' }}>
                {openPositionsCount !== null ? `${openPositionsCount} open · ` : ''}
                {demoBalance.lastUpdatedAt ? new Date(demoBalance.lastUpdatedAt).toLocaleTimeString() : 'Live'}
              </span>
            </div>
          </div>
        ) : (
          <div
            style={{
              padding: '12px 16px',
              background: 'var(--surface-raised)',
              borderRadius: 8,
              border: '1px solid var(--surface-border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <small className="muted" style={{ fontSize: 11, fontWeight: 600 }}>DEMO ACCOUNT SYNCHRONIZATION</small>
              <span style={{ fontSize: 11, fontFamily: 'DM Mono', color: 'var(--accent)' }}>● CONFIGURED</span>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {balanceError
                ? `Connection status: ${balanceError}`
                : 'Awaiting balance synchronization from Binance Demo API. Click "Test Demo Account Access" below to request an instant connection check.'}
            </p>
          </div>
        )
      )}

      {/* FAIL-CLOSED LIVE TRADING WARNING CARD (When LIVE is selected) */}
      {environment === 'LIVE' ? (
        <div
          className="card"
          style={{
            padding: '24px',
            border: '1px solid #ef4444',
            background: 'rgba(239, 68, 68, 0.05)',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ fontSize: 32 }}>🔒</div>
          <h3 style={{ margin: 0, color: '#ef4444' }}>
            Live Real-Money Trading is Locked Fail-Closed (HTTP 403)
          </h3>
          <p className="muted" style={{ maxWidth: 520, margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            Live trading execution and real-money credential inputs are locked by platform safety policy. Real capital
            is never at risk. SmartExit operates exclusively in high-fidelity authenticated exchange Demo & Testnet execution modes.
          </p>
          <button
            type="button"
            className="button"
            style={{ marginTop: 8 }}
            onClick={() => selectEnvironment('DEMO')}
          >
            ← Return to Demo API
          </button>
        </div>
      ) : (
        /* DEMO CREDENTIAL ENTRY FORM */
        <>
          <p
            className={environmentConfirmationRequired ? 'scanner-warning' : 'muted'}
            role={environmentConfirmationRequired ? 'status' : undefined}
          >
            {environmentConfirmationRequired
              ? 'A legacy credential exists for Demo, but its original environment cannot be verified. Re-enter the matching Demo credential before using it.'
              : configured
              ? 'Demo credentials are encrypted and stored; secret values cannot be viewed.'
              : 'Enter your Binance Futures Demo API key and secret below. Virtual funds only.'}
            {' Keep withdrawals disabled on the exchange API key.'}
          </p>

          {message && <p className="success" role="status">{message}</p>}
          {error && <p className="error" role="alert">{error}</p>}

          <label>
            Demo Binance API Key
            <input
              type="password"
              autoComplete="off"
              disabled={busy}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              minLength={20}
              maxLength={128}
              placeholder="Paste Binance Futures Demo / Testnet API Key"
              required
            />
          </label>
          <label>
            Demo Binance API Secret
            <input
              autoComplete="new-password"
              type="password"
              disabled={busy}
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              minLength={20}
              maxLength={128}
              placeholder="Paste Binance Futures Demo / Testnet API Secret"
              required
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{' '}
            I confirm these keys were issued for Binance Demo / Virtual Funds.
          </label>
          <div className="links">
            <button disabled={busy || !confirmed || !apiKey || !apiSecret}>Save Encrypted Keys</button>
            <button
              type="button"
              className="button-secondary"
              disabled={busy || !configured}
              onClick={(event) => void submit(event, 'test')}
            >
              Test Demo Account Access
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={busy || !storageReady || (!configured && !environmentConfirmationRequired)}
              onClick={(event) => void submit(event, 'remove')}
            >
              Remove Demo Keys
            </button>
          </div>
          {storageReady && !signedReadEnabled && (
            <p className="muted" style={{ fontSize: 12 }}>
              Account verification requires separate approval.
            </p>
          )}
          <p className="muted" style={{ fontSize: 12 }}>
            🔒 Fixed server-side endpoint (demo-fapi.binance.com). Credentials and connection checks are strictly isolated to virtual funds; no real orders are placed.
          </p>
        </>
      )}
    </form>
  );
}
