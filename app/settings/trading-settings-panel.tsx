'use client';

import { useEffect, useState, type FormEvent } from 'react';

type Settings = {
  active_environment: 'DEMO' | 'LIVE';
  order_size_mode: 'FIXED' | 'RISK_BASED';
  fixed_notional_usdt: string;
  risk_percentage: string;
  default_leverage: number;
  execution_mode: 'CONFIRM' | 'AUTOMATIC';
  auto_trade_enabled: boolean;
  kill_switch_enabled: boolean;
  demo_auto_trade_enabled: boolean;
  live_auto_trade_enabled: boolean;
  demo_kill_switch_enabled: boolean;
  live_kill_switch_enabled: boolean;
};

const initialSettings: Settings = {
  active_environment: 'DEMO',
  order_size_mode: 'FIXED',
  fixed_notional_usdt: '100',
  risk_percentage: '1',
  default_leverage: 1,
  execution_mode: 'CONFIRM',
  auto_trade_enabled: false,
  kill_switch_enabled: false,
  demo_auto_trade_enabled: false,
  live_auto_trade_enabled: false,
  demo_kill_switch_enabled: false,
  live_kill_switch_enabled: false,
};

async function csrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

export function TradingSettingsPanel() {
  const [settings, setSettings] = useState(initialSettings);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void fetch('/api/trading/settings', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { data?: Settings; error?: string };
        if (!response.ok || !body.data) throw new Error(body.error ?? 'Trading settings unavailable.');
        if (active) setSettings(body.data);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Trading settings unavailable.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/trading/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({
          environment: settings.active_environment,
          order_size_mode: settings.order_size_mode,
          fixed_notional_usdt: settings.fixed_notional_usdt,
          risk_percentage: settings.risk_percentage,
          default_leverage: Number(settings.default_leverage),
          execution_mode: settings.execution_mode,
        }),
      });
      const body = await response.json() as { data?: Settings; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Trading settings could not be saved.');
      setSettings(body.data);
      setMessage('Trading settings saved. Automatic trading remains off until explicitly enabled.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Trading settings could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function setAutoTrade(enabled: boolean) {
    const environment = settings.active_environment;
    if (enabled && !window.confirm(environment === 'DEMO'
      ? 'Enable automatic Demo orders using virtual funds only? This uses Demo credentials only and will never switch to Live.'
      : 'Enable automatic LIVE orders using real funds? Real financial losses can occur. This requires separate Live credentials, explicit deployment approval, and can never fall back to Demo.')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/trading/auto-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({
          environment,
          enabled,
          ...(enabled && environment === 'DEMO' ? { confirmDemoRisk: true } : {}),
          ...(enabled && environment === 'LIVE' ? { confirmLiveRisk: true } : {}),
        }),
      });
      const body = await response.json() as { data?: Settings; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Auto-trade could not be updated.');
      setSettings(body.data);
      setMessage(enabled ? `${environment === 'DEMO' ? 'Demo' : 'Live'} automatic trading enabled.` : `${environment === 'DEMO' ? 'Demo' : 'Live'} automatic trading disabled.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Auto-trade could not be updated.');
    } finally {
      setBusy(false);
    }
  }

  async function switchEnvironment(environment: 'DEMO' | 'LIVE') {
    if (environment === settings.active_environment) return;
    if (environment === 'LIVE' && !window.confirm('Switch the active trading environment to LIVE / REAL FUNDS? This changes the account shown on balance, signal previews, positions, and history filters. No orders will be placed.')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/trading/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ environment, ...(environment === 'LIVE' ? { confirmLive: true } : {}) }),
      });
      const body = await response.json() as { data?: Settings; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Trading environment could not be changed.');
      setSettings(body.data);
      setMessage(`Active environment is now ${environment === 'DEMO' ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Trading environment could not be changed.');
    } finally {
      setBusy(false);
    }
  }

  async function emergencyStop(environment: 'DEMO' | 'LIVE', action: 'STOP' | 'RESET') {
    if (action === 'RESET' && !window.confirm(`Reset the ${environment} emergency stop? Confirm only after manually checking that environment’s Binance positions and open orders.`)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/trading/emergency-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ environment, action, ...(action === 'RESET' ? { confirmReset: true } : {}) }),
      });
      const body = await response.json() as { data?: Settings; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Emergency stop could not be enabled.');
      setSettings(body.data);
      setMessage(action === 'STOP'
        ? `${environment === 'DEMO' ? 'Demo' : 'Live'} emergency stop enabled; exchange positions are unchanged.`
        : `${environment === 'DEMO' ? 'Demo' : 'Live'} emergency stop reset; automatic trading remains off until separately enabled.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Emergency stop could not be enabled.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <section className="card"><p className="muted">Loading trading settings…</p></section>;

  return <section className="card stack">
    <div><p className="mono">SMARTEXIT · BINANCE USDⓈ-M FUTURES</p><h2>Trading settings</h2>
      <p className="muted">Confirm mode, 1% risk and automatic trading off are the defaults. Never enable withdrawal permission for exchange API keys.</p>
    </div>
    <div className="notification-control-grid">
      <label>Active trading environment<select value={settings.active_environment} disabled={busy} onChange={(event) => void switchEnvironment(event.target.value as Settings['active_environment'])}>
        <option value="DEMO">Demo Trading · Virtual Funds</option><option value="LIVE">Live Trading · Real Funds</option>
      </select></label>
      <div><p className="mono">{settings.active_environment === 'DEMO' ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'}</p>
        <p className="muted">Demo Auto-Trade: {settings.demo_auto_trade_enabled ? 'ON' : 'OFF'} · Live Auto-Trade: {settings.live_auto_trade_enabled ? 'ON' : 'OFF'}</p>
      </div>
    </div>
    <form className="stack" onSubmit={(event) => void save(event)}>
      <div className="notification-control-grid">
        <label>Order size mode<select value={settings.order_size_mode} onChange={(event) => setSettings({ ...settings, order_size_mode: event.target.value as Settings['order_size_mode'] })}>
          <option value="FIXED">Fixed USDT notional</option><option value="RISK_BASED">Risk-based sizing</option>
        </select></label>
        <label>Fixed notional · USDT<input type="number" min="1" step="0.01" value={settings.fixed_notional_usdt} disabled={settings.order_size_mode !== 'FIXED'} onChange={(event) => setSettings({ ...settings, fixed_notional_usdt: event.target.value })} /></label>
        <label>Risk per trade · %<input type="number" min="0.01" max="5" step="0.01" value={settings.risk_percentage} disabled={settings.order_size_mode !== 'RISK_BASED'} onChange={(event) => setSettings({ ...settings, risk_percentage: event.target.value })} /></label>
        <label>Default leverage<input type="number" min="1" max="125" step="1" value={settings.default_leverage} onChange={(event) => setSettings({ ...settings, default_leverage: Number(event.target.value) })} /></label>
        <label>Execution mode<select value={settings.execution_mode} onChange={(event) => setSettings({ ...settings, execution_mode: event.target.value as Settings['execution_mode'] })}>
          <option value="CONFIRM">Confirm each trade</option><option value="AUTOMATIC">Automatic (requires separate opt-in)</option>
        </select></label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="success" role="status">{message}</p>}
      <div className="links">
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save trading settings'}</button>
        {settings.active_environment === 'DEMO' && settings.execution_mode === 'AUTOMATIC' && (settings.demo_auto_trade_enabled
          ? <button type="button" className="button-secondary" disabled={busy} onClick={() => void setAutoTrade(false)}>Disable Demo Auto-Trade</button>
          : <button type="button" className="button-secondary" disabled={busy || settings.demo_kill_switch_enabled} onClick={() => void setAutoTrade(true)}>Enable Demo Auto-Trade</button>)}
        {settings.active_environment === 'LIVE' && settings.execution_mode === 'AUTOMATIC' && (settings.live_auto_trade_enabled
          ? <button type="button" className="button-secondary" disabled={busy} onClick={() => void setAutoTrade(false)}>Disable Live Auto-Trade</button>
          : <button type="button" className="button-secondary" disabled={busy || settings.live_kill_switch_enabled} onClick={() => void setAutoTrade(true)}>Enable Live Auto-Trade</button>)}
        {settings.demo_kill_switch_enabled
          ? <button type="button" className="button-secondary" disabled={busy} onClick={() => void emergencyStop('DEMO', 'RESET')}>Reset Demo emergency stop</button>
          : <button type="button" className="button-secondary" disabled={busy} onClick={() => void emergencyStop('DEMO', 'STOP')}>Demo emergency stop</button>}
        {settings.live_kill_switch_enabled
          ? <button type="button" className="button-secondary" disabled={busy} onClick={() => void emergencyStop('LIVE', 'RESET')}>Reset Live emergency stop</button>
          : <button type="button" className="button-secondary" disabled={busy} onClick={() => void emergencyStop('LIVE', 'STOP')}>Live emergency stop</button>}
      </div>
      <p className="muted">The environment selector never changes credentials. Confirm-mode orders remain explicitly gated. Each emergency stop affects only its named environment and leaves exchange positions unchanged.</p>
    </form>
  </section>;
}
