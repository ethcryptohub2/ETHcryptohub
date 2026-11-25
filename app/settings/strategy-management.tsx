'use client';

import { useEffect, useState, type FormEvent } from 'react';

type Strategy = 'STANDARD' | 'HIGH_RISK_SCALPING';
type Exchange = 'BINANCE' | 'BYBIT' | 'OKX' | 'BITGET' | 'GATE';
type Environment = 'DEMO' | 'TESTNET' | 'LIVE';
type Profile = {
  strategy: Strategy;
  exchange: Exchange;
  environment: Environment;
  enabled: boolean;
  execution_mode: 'CONFIRM' | 'AUTOMATIC';
  risk_percentage: string;
  order_size_mode: 'FIXED' | 'RISK_BASED';
  fixed_notional_usdt: string;
  leverage: number;
  max_open_positions: number | null;
  max_daily_loss_percent: string | null;
  auto_execution_enabled: boolean;
  emergency_stop_enabled: boolean;
  updated_at: string;
};

const exchangeNames: Record<Exchange, string> = {
  BINANCE: 'Binance',
  BYBIT: 'Bybit',
  OKX: 'OKX',
  BITGET: 'Bitget',
  GATE: 'Gate.io',
};

async function csrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

function isStrategy(value: Profile['strategy']) {
  return value === 'STANDARD' ? 'Standard' : 'High-Risk Scalping';
}

function status(profile: Profile) {
  if (profile.emergency_stop_enabled) return 'Emergency stop';
  if (!profile.max_open_positions || !profile.max_daily_loss_percent) return 'Limits required';
  if (!profile.enabled) return 'Disabled';
  return 'Enabled';
}

export function StrategyManagement() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [savedProfiles, setSavedProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void fetch('/api/trading/strategies', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { data?: Profile[]; error?: string };
        if (!response.ok || !body.data) throw new Error(body.error ?? 'Strategy profiles unavailable.');
        if (active) {
          setProfiles(body.data);
          setSavedProfiles(body.data);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Strategy profiles unavailable.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  function update(strategy: Strategy, changes: Partial<Profile>) {
    setProfiles((current) => current.map((profile) =>
      profile.strategy === strategy ? { ...profile, ...changes } : profile,
    ));
  }

  async function save(event: FormEvent, profile: Profile) {
    event.preventDefault();
    const current = savedProfiles.find((item) => item.strategy === profile.strategy) ?? profiles.find((item) => item.strategy === profile.strategy);
    if (!current) return;
    const enabling = current.enabled && !profile.enabled ? false : !current.enabled && profile.enabled;
    if (current.enabled && !profile.enabled &&
      !window.confirm(`Disable ${isStrategy(profile.strategy)}? No new signals will be routed to this strategy.`)) return;
    if (enabling && !window.confirm(`Enable ${isStrategy(profile.strategy)} on ${exchangeNames[profile.exchange]} ${profile.environment}? Only this strategy and destination will be used. No order is placed by saving.`)) return;
    const enablingAuto = !current.auto_execution_enabled && profile.auto_execution_enabled;
    if (enablingAuto && !window.confirm('Enable automatic execution for this strategy? Orders can be submitted without per-order confirmation.')) return;
    if (current.emergency_stop_enabled && !profile.emergency_stop_enabled &&
      !window.confirm('Reset this strategy emergency stop? Confirm only after reviewing all exchange positions and open orders.')) return;

    setBusy(true);
    setError('');
    setMessage('');
    try {
      const token = await csrfToken();
      const cleanProfile = {
        strategy: profile.strategy,
        exchange: profile.exchange,
        environment: profile.environment,
        enabled: profile.enabled,
        execution_mode: profile.execution_mode,
        risk_percentage: profile.risk_percentage,
        order_size_mode: profile.order_size_mode,
        fixed_notional_usdt: profile.fixed_notional_usdt,
        leverage: profile.leverage,
        max_open_positions: profile.max_open_positions,
        max_daily_loss_percent: profile.max_daily_loss_percent,
        auto_execution_enabled: profile.auto_execution_enabled,
        emergency_stop_enabled: profile.emergency_stop_enabled,
      };
      const response = await fetch('/api/trading/strategies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({
          ...cleanProfile,
          confirmEnable: enabling,
          confirmAutomatic: enablingAuto,
          confirmEmergencyStopReset: current.emergency_stop_enabled && !profile.emergency_stop_enabled,
        }),
      });
      const body = await response.json() as { data?: Profile[]; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Strategy profile could not be saved.');
      setProfiles(body.data);
      setSavedProfiles(body.data);
      setMessage(`${isStrategy(profile.strategy)} profile saved. Execution remains subject to exchange readiness and deployment safety gates.`);
    } catch (reason) {
      setProfiles(savedProfiles);
      setError(reason instanceof Error ? reason.message : 'Strategy profile could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <section className="card"><p className="muted">Loading strategy profiles…</p></section>;

  return <section className="card stack strategy-management">
    <header>
      <p className="mono">SMARTEXIT · INDEPENDENT ROUTING</p>
      <h2>Strategy management</h2>
      <p className="muted">Each signal routes to one selected strategy, exchange, and environment. New strategies stay disabled until both position and daily-loss limits are configured.</p>
    </header>

    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="success" role="status">{message}</p>}

    {profiles.length > 0 && <div className="strategy-table-wrap">
      <table className="strategy-table">
        <thead><tr>
          <th>Strategy</th><th>Status</th><th>Exchange</th><th>Environment</th><th>Execution Mode</th>
          <th>Risk</th><th>Leverage</th><th>Max Positions</th><th>Daily Loss Limit</th><th>Actions</th>
        </tr></thead>
        <tbody>{profiles.map((profile) => <tr key={profile.strategy}>
          <td data-label="Strategy">{isStrategy(profile.strategy)}</td>
          <td data-label="Status">{status(profile)}</td>
          <td data-label="Exchange">{exchangeNames[profile.exchange]}</td>
          <td data-label="Environment">{profile.environment}</td>
          <td data-label="Execution Mode">{profile.execution_mode}</td>
          <td data-label="Risk">{profile.risk_percentage}%</td>
          <td data-label="Leverage">{profile.leverage}x</td>
          <td data-label="Max Positions">{profile.max_open_positions ?? 'Not set'}</td>
          <td data-label="Daily Loss Limit">{profile.max_daily_loss_percent ? `${profile.max_daily_loss_percent}%` : 'Not set'}</td>
          <td data-label="Actions"><a href={`#strategy-${profile.strategy}`}>Configure</a></td>
        </tr>)}</tbody>
      </table>
    </div>}

    <div className="strategy-profile-list">
      {profiles.map((profile) => {
        const environmentOptions: Environment[] = profile.exchange === 'GATE' ? ['TESTNET', 'LIVE'] : ['DEMO', 'LIVE'];
        return <form id={`strategy-${profile.strategy}`} className="strategy-profile stack" key={profile.strategy} onSubmit={(event) => void save(event, profile)}>
          <div className="signal-detail-heading">
            <div><h3>{isStrategy(profile.strategy)}</h3><p className="muted">Profile settings are isolated from the other strategy.</p></div>
            <span className="scanner-signal-badge">{status(profile)}</span>
          </div>
          <div className="strategy-fields">
            <label>Exchange
              <select value={profile.exchange} onChange={(event) => {
                const exchange = event.target.value as Exchange;
                update(profile.strategy, { exchange, environment: exchange === 'GATE' ? 'TESTNET' : 'DEMO', enabled: false, auto_execution_enabled: false });
              }}>
                {Object.entries(exchangeNames).map(([id, name]) => <option value={id} key={id}>{name}{id !== 'BINANCE' ? ' · adapter not ready' : ''}</option>)}
              </select>
            </label>
            <label>Environment
              <select value={profile.environment} onChange={(event) => update(profile.strategy, { environment: event.target.value as Environment, enabled: false, auto_execution_enabled: false })}>
                {environmentOptions.map((environment) => <option value={environment} key={environment}>{environment === 'DEMO' ? 'Demo' : environment === 'TESTNET' ? 'Testnet' : 'Live · locked'}</option>)}
              </select>
            </label>
            <label>Execution mode
              <select value={profile.execution_mode} onChange={(event) => update(profile.strategy, { execution_mode: event.target.value as Profile['execution_mode'], auto_execution_enabled: false })}>
                <option value="CONFIRM">Confirm</option><option value="AUTOMATIC">Automatic</option>
              </select>
            </label>
            <label>Risk per trade (%)
              <input inputMode="decimal" value={profile.risk_percentage} onChange={(event) => update(profile.strategy, { risk_percentage: event.target.value })} />
            </label>
            <label>Leverage
              <select value={profile.leverage} onChange={(event) => update(profile.strategy, { leverage: Number(event.target.value) })}>
                {[1, 2, 3, 5, 10, 20, 50, 100, 125].map((value) => <option value={value} key={value}>{value}x</option>)}
              </select>
            </label>
            <label>Position sizing
              <select value={profile.order_size_mode} onChange={(event) => update(profile.strategy, { order_size_mode: event.target.value as Profile['order_size_mode'] })}>
                <option value="FIXED">Fixed USDT</option><option value="RISK_BASED">Risk-based</option>
              </select>
            </label>
            {profile.order_size_mode === 'FIXED' && <label>Fixed order size (USDT)
              <input inputMode="decimal" value={profile.fixed_notional_usdt} onChange={(event) => update(profile.strategy, { fixed_notional_usdt: event.target.value })} />
            </label>}
            <label>Maximum concurrent positions
              <input type="number" min="1" max="100" step="1" value={profile.max_open_positions ?? ''} onChange={(event) => update(profile.strategy, { max_open_positions: event.target.value ? Number(event.target.value) : null })} />
            </label>
            <label>Maximum daily loss (% of account equity)
              <input inputMode="decimal" value={profile.max_daily_loss_percent ?? ''} onChange={(event) => update(profile.strategy, { max_daily_loss_percent: event.target.value || null })} />
            </label>
          </div>

          <div className="strategy-actions">
            <label className="notification-toggle"><input type="checkbox" checked={profile.auto_execution_enabled} disabled={!profile.enabled || profile.execution_mode !== 'AUTOMATIC' || profile.environment === 'LIVE' || profile.emergency_stop_enabled} onChange={(event) => update(profile.strategy, { auto_execution_enabled: event.target.checked })} /> Automatic execution</label>
            <label className="notification-toggle"><input type="checkbox" checked={profile.emergency_stop_enabled} onChange={(event) => update(profile.strategy, { emergency_stop_enabled: event.target.checked, auto_execution_enabled: event.target.checked ? false : profile.auto_execution_enabled })} /> Emergency stop</label>
            <label className="notification-toggle"><input type="checkbox" checked={profile.enabled} disabled={profile.emergency_stop_enabled || profile.environment === 'LIVE' || (profile.exchange !== 'BINANCE' && !profile.enabled)} onChange={(event) => update(profile.strategy, { enabled: event.target.checked, auto_execution_enabled: event.target.checked ? profile.auto_execution_enabled : false })} /> Strategy enabled</label>
            <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save strategy'}</button>
          </div>
          <p className="muted strategy-note">Connection status: {profile.exchange === 'BINANCE' ? 'subject to Binance Demo provider and deployment verification gates' : `${exchangeNames[profile.exchange]} customer adapter not ready`}. Live order execution is locked. Execution remains locked pending approved remote Demo lifecycle verification and staging identity checks.</p>
        </form>;
      })}
    </div>
  </section>;
}
