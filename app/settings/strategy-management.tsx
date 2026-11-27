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
  max_notional_usdt?: string;
  sl_mode?: 'BASELINE' | 'ATR' | 'MARKET_STRUCTURE' | 'ADAPTIVE_SMART';
  adaptive_protection_enabled?: boolean;
  trailing_protection_enabled?: boolean;
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
  const body = (await response.json()) as { data?: { csrfToken: string } };
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

function LeverageSliderControl({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (val: number) => void;
  disabled?: boolean;
}) {
  const quickOptions = [1, 5, 10, 15, 20, 25, 50];
  const isHighRisk = value > 20;

  return (
    <div className="leverage-control-card" style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      width: '100%',
      gridColumn: '1 / -1',
      background: 'var(--surface-raised)',
      padding: '12px 14px',
      borderRadius: 8,
      border: isHighRisk ? '1px solid rgba(239, 68, 68, 0.4)' : '1px solid var(--surface-border)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Leverage Configuration</span>
          <p className="muted" style={{ margin: 0, fontSize: 11 }}>
            Integer increments (1x-125x). Margin requirement is notional / leverage.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="number"
            min={1}
            max={125}
            step={1}
            value={value}
            disabled={disabled}
            onChange={(e) => {
              const num = parseInt(e.target.value, 10);
              if (!isNaN(num) && num >= 1 && num <= 125) {
                onChange(num);
              }
            }}
            style={{
              width: 60,
              padding: '4px 6px',
              fontSize: 14,
              fontWeight: 700,
              textAlign: 'center',
              borderRadius: 6,
              border: '1px solid var(--surface-border)',
              background: 'var(--surface)',
            }}
          />
          <span style={{
            fontSize: 14,
            fontWeight: 800,
            padding: '3px 8px',
            borderRadius: 6,
            background: isHighRisk ? '#fef2f2' : 'rgba(99, 102, 241, 0.1)',
            color: isHighRisk ? '#dc2626' : 'var(--color-primary, #6366f1)',
          }}>
            {value}x
          </span>
        </div>
      </div>

      {/* Slider */}
      <div style={{ width: '100%' }}>
        <input
          type="range"
          min={1}
          max={50}
          step={1}
          value={Math.min(value, 50)}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ width: '100%', cursor: disabled ? 'not-allowed' : 'pointer' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          <span>1x</span>
          <span>10x</span>
          <span>25x</span>
          <span>50x</span>
        </div>
      </div>

      {/* Quick selection buttons */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {quickOptions.map((opt) => (
          <button
            key={opt}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt)}
            style={{
              flex: '1 1 auto',
              padding: '5px 8px',
              fontSize: 11,
              fontWeight: value === opt ? 700 : 500,
              borderRadius: 6,
              border: value === opt ? '1px solid var(--color-primary, #6366f1)' : '1px solid var(--surface-border)',
              background: value === opt ? 'rgba(99, 102, 241, 0.15)' : 'var(--surface)',
              color: value === opt ? 'var(--color-primary, #6366f1)' : 'inherit',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {opt}x
          </button>
        ))}
      </div>

      {isHighRisk && (
        <div style={{
          fontSize: 11,
          color: '#b91c1c',
          background: '#fef2f2',
          border: '1px solid #fecaca',
          padding: '6px 10px',
          borderRadius: 6,
          lineHeight: 1.4,
        }}>
          ⚠️ <strong>High Leverage Warning:</strong> Trading with &gt;20x leverage significantly increases liquidation risk. Ensure your stop loss and margin buffers are strictly configured.
        </div>
      )}
    </div>
  );
}

export function StrategyManagement() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [savedProfiles, setSavedProfiles] = useState<Profile[]>([]);
  const [autoConfirmChecked, setAutoConfirmChecked] = useState<Record<string, boolean>>({
    STANDARD: true,
    HIGH_RISK_SCALPING: true,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void fetch('/api/trading/strategies', { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json()) as { data?: Profile[]; error?: string };
        if (!response.ok || !body.data) throw new Error(body.error ?? 'Strategy profiles unavailable.');
        if (active) {
          setProfiles(body.data);
          setSavedProfiles(body.data);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Strategy profiles unavailable.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function update(strategy: Strategy, changes: Partial<Profile>) {
    setProfiles((current) =>
      current.map((profile) => (profile.strategy === strategy ? { ...profile, ...changes } : profile)),
    );
  }

  async function save(event: FormEvent, profile: Profile) {
    event.preventDefault();
    const current =
      savedProfiles.find((item) => item.strategy === profile.strategy) ??
      profiles.find((item) => item.strategy === profile.strategy);
    if (!current) return;

    const enabling = current.enabled && !profile.enabled ? false : !current.enabled && profile.enabled;
    if (
      current.enabled &&
      !profile.enabled &&
      !window.confirm(`Disable ${isStrategy(profile.strategy)}? No new signals will be routed to this strategy.`)
    ) {
      return;
    }
    if (
      enabling &&
      !window.confirm(
        `Enable ${isStrategy(profile.strategy)} on ${exchangeNames[profile.exchange]} ${profile.environment}? Only this strategy and destination will be used. No order is placed by saving.`,
      )
    ) {
      return;
    }

    const enablingAuto = !current.auto_execution_enabled && profile.auto_execution_enabled;
    if (
      enablingAuto &&
      !window.confirm(
        `Enable automatic execution for ${isStrategy(profile.strategy)}? Orders will be automatically placed on Binance Demo when high-conviction signals match your configured risk and leverage.`,
      )
    ) {
      return;
    }
    if (
      current.emergency_stop_enabled &&
      !profile.emergency_stop_enabled &&
      !window.confirm(
        'Reset this strategy emergency stop? Confirm only after reviewing all exchange positions and open orders.',
      )
    ) {
      return;
    }

    const hasConfirmedAuto = profile.auto_execution_enabled
      ? (autoConfirmChecked[profile.strategy] ?? true)
      : false;
    if (profile.auto_execution_enabled && !hasConfirmedAuto) {
      setError('Please check the explicit authorization box before saving automatic execution.');
      return;
    }

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
        max_notional_usdt: profile.max_notional_usdt ?? '500.00',
        sl_mode: profile.sl_mode ?? 'ADAPTIVE_SMART',
        adaptive_protection_enabled: profile.adaptive_protection_enabled ?? true,
        trailing_protection_enabled: profile.trailing_protection_enabled ?? true,
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
          confirmEnable: enabling || profile.enabled,
          confirmAutomatic: hasConfirmedAuto || enablingAuto || current.auto_execution_enabled,
          confirmEmergencyStopReset: current.emergency_stop_enabled && !profile.emergency_stop_enabled,
        }),
      });
      const body = (await response.json()) as { data?: Profile[]; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Strategy profile could not be saved.');
      setProfiles(body.data);
      setSavedProfiles(body.data);
      setMessage(
        `${isStrategy(profile.strategy)} profile saved with ${profile.leverage}x leverage and ${profile.max_open_positions ?? 10} max positions. Execution remains subject to exchange readiness and deployment safety gates.`,
      );
    } catch (reason) {
      setProfiles(savedProfiles);
      setError(reason instanceof Error ? reason.message : 'Strategy profile could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <section className="card"><p className="muted">Loading strategy profiles…</p></section>;

  return (
    <section className="card stack strategy-management">
      <header>
        <p className="mono">SMARTEXIT · INDEPENDENT ROUTING</p>
        <h2>Strategy management</h2>
        <p className="muted">
          Each signal routes to one selected strategy, exchange, and environment. Standard and High-Risk profiles are independently configured and persisted.
        </p>
      </header>

      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="success" role="status">{message}</p>}

      {profiles.length > 0 && (
        <div className="strategy-table-wrap">
          <table className="strategy-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Status</th>
                <th>Exchange</th>
                <th>Environment</th>
                <th>Execution Mode</th>
                <th>Risk</th>
                <th>Leverage</th>
                <th>Max Positions</th>
                <th>Daily Loss Limit</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) => (
                <tr key={profile.strategy}>
                  <td data-label="Strategy">{isStrategy(profile.strategy)}</td>
                  <td data-label="Status">{status(profile)}</td>
                  <td data-label="Exchange">{exchangeNames[profile.exchange]}</td>
                  <td data-label="Environment">{profile.environment}</td>
                  <td data-label="Execution Mode">{profile.execution_mode}</td>
                  <td data-label="Risk">{profile.risk_percentage}%</td>
                  <td data-label="Leverage">
                    <strong style={{ color: 'var(--color-primary, #6366f1)' }}>{profile.leverage}x</strong>
                  </td>
                  <td data-label="Max Positions">{profile.max_open_positions ?? 'Not set'}</td>
                  <td data-label="Daily Loss Limit">
                    {profile.max_daily_loss_percent ? `${profile.max_daily_loss_percent}%` : 'Not set'}
                  </td>
                  <td data-label="Actions">
                    <a href={`#strategy-${profile.strategy}`}>Configure</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="strategy-profile-list">
        {profiles.map((profile) => {
          const environmentOptions: Environment[] =
            profile.exchange === 'GATE' ? ['TESTNET', 'LIVE'] : ['DEMO', 'LIVE'];
          return (
            <form
              id={`strategy-${profile.strategy}`}
              className="strategy-profile stack"
              key={profile.strategy}
              onSubmit={(event) => void save(event, profile)}
            >
              <div className="signal-detail-heading">
                <div>
                  <h3>{isStrategy(profile.strategy)}</h3>
                  <p className="muted">Profile settings are isolated from the other strategy.</p>
                </div>
                <span className="scanner-signal-badge">{status(profile)}</span>
              </div>

              <div className="strategy-fields">
                <label>
                  Exchange
                  <select
                    value={profile.exchange}
                    onChange={(event) => {
                      const exchange = event.target.value as Exchange;
                      update(profile.strategy, {
                        exchange,
                        environment: exchange === 'GATE' ? 'TESTNET' : 'DEMO',
                        enabled: false,
                        auto_execution_enabled: false,
                      });
                    }}
                  >
                    {Object.entries(exchangeNames).map(([id, name]) => (
                      <option value={id} key={id}>
                        {name}
                        {id !== 'BINANCE' ? ' · adapter not ready' : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Environment
                  <select
                    value={profile.environment}
                    onChange={(event) =>
                      update(profile.strategy, {
                        environment: event.target.value as Environment,
                        enabled: false,
                        auto_execution_enabled: false,
                      })
                    }
                  >
                    {environmentOptions.map((environment) => (
                      <option value={environment} key={environment}>
                        {environment === 'DEMO' ? 'Demo' : environment === 'TESTNET' ? 'Testnet' : 'Live · locked'}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Execution mode
                  <select
                    value={profile.execution_mode}
                    onChange={(event) =>
                      update(profile.strategy, {
                        execution_mode: event.target.value as Profile['execution_mode'],
                        auto_execution_enabled: false,
                      })
                    }
                  >
                    <option value="CONFIRM">Confirm</option>
                    <option value="AUTOMATIC">Automatic</option>
                  </select>
                </label>

                <label>
                  Risk per trade (%)
                  <input
                    inputMode="decimal"
                    value={profile.risk_percentage}
                    onChange={(event) => update(profile.strategy, { risk_percentage: event.target.value })}
                  />
                </label>

                {/* Professional Leverage Slider */}
                <LeverageSliderControl
                  value={profile.leverage}
                  onChange={(val) => update(profile.strategy, { leverage: val })}
                  disabled={busy}
                />

                <label>
                  Position sizing
                  <select
                    value={profile.order_size_mode}
                    onChange={(event) =>
                      update(profile.strategy, {
                        order_size_mode: event.target.value as Profile['order_size_mode'],
                      })
                    }
                  >
                    <option value="FIXED">Fixed USDT</option>
                    <option value="RISK_BASED">Risk-based</option>
                  </select>
                </label>

                {profile.order_size_mode === 'FIXED' && (
                  <label>
                    Fixed order size (USDT)
                    <input
                      inputMode="decimal"
                      value={profile.fixed_notional_usdt}
                      onChange={(event) => update(profile.strategy, { fixed_notional_usdt: event.target.value })}
                    />
                  </label>
                )}

                <label>
                  Maximum concurrent positions
                  <input
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                    value={profile.max_open_positions ?? ''}
                    onChange={(event) =>
                      update(profile.strategy, {
                        max_open_positions: event.target.value ? Number(event.target.value) : null,
                      })
                    }
                  />
                </label>

                <label>
                  Maximum daily loss (% of account equity)
                  <input
                    inputMode="decimal"
                    value={profile.max_daily_loss_percent ?? ''}
                    onChange={(event) =>
                      update(profile.strategy, { max_daily_loss_percent: event.target.value || null })
                    }
                  />
                </label>

                <label>
                  Protection SL/TP Mode
                  <select
                    value={profile.sl_mode ?? 'ADAPTIVE_SMART'}
                    onChange={(event) =>
                      update(profile.strategy, { sl_mode: event.target.value as Profile['sl_mode'] })
                    }
                  >
                    <option value="ADAPTIVE_SMART">Adaptive Smart (Structure + ATR)</option>
                    <option value="MARKET_STRUCTURE">Market Structure (Swing High/Low)</option>
                    <option value="ATR">ATR Volatility Band</option>
                    <option value="BASELINE">Signal Baseline</option>
                  </select>
                </label>

                <label>
                  Max Position Notional Cap (USDT)
                  <input
                    inputMode="decimal"
                    value={profile.max_notional_usdt ?? '500.00'}
                    onChange={(event) => update(profile.strategy, { max_notional_usdt: event.target.value })}
                  />
                </label>
              </div>

              <div className="strategy-actions">
                <label className="notification-toggle">
                  <input
                    type="checkbox"
                    checked={profile.adaptive_protection_enabled ?? true}
                    onChange={(event) =>
                      update(profile.strategy, { adaptive_protection_enabled: event.target.checked })
                    }
                  />
                  Adaptive Smart SL/TP
                </label>
                <label className="notification-toggle">
                  <input
                    type="checkbox"
                    checked={profile.trailing_protection_enabled ?? true}
                    onChange={(event) =>
                      update(profile.strategy, { trailing_protection_enabled: event.target.checked })
                    }
                  />
                  Trailing SL
                </label>
                <label className="notification-toggle">
                  <input
                    type="checkbox"
                    checked={profile.auto_execution_enabled}
                    disabled={
                      !profile.enabled ||
                      profile.execution_mode !== 'AUTOMATIC' ||
                      profile.environment === 'LIVE' ||
                      profile.emergency_stop_enabled
                    }
                    onChange={(event) =>
                      update(profile.strategy, { auto_execution_enabled: event.target.checked })
                    }
                  />
                  Automatic execution
                </label>
                <label className="notification-toggle">
                  <input
                    type="checkbox"
                    checked={profile.emergency_stop_enabled}
                    onChange={(event) =>
                      update(profile.strategy, {
                        emergency_stop_enabled: event.target.checked,
                        auto_execution_enabled: event.target.checked ? false : profile.auto_execution_enabled,
                      })
                    }
                  />
                  Emergency stop
                </label>
                <label className="notification-toggle">
                  <input
                    type="checkbox"
                    checked={profile.enabled}
                    disabled={
                      profile.emergency_stop_enabled ||
                      profile.environment === 'LIVE' ||
                      (profile.exchange !== 'BINANCE' && !profile.enabled)
                    }
                    onChange={(event) =>
                      update(profile.strategy, {
                        enabled: event.target.checked,
                        auto_execution_enabled: event.target.checked ? profile.auto_execution_enabled : false,
                      })
                    }
                  />
                  Strategy enabled
                </label>
              </div>

              {profile.auto_execution_enabled && (
                <div style={{
                  background: 'rgba(99, 102, 241, 0.08)',
                  border: '1px solid rgba(99, 102, 241, 0.3)',
                  padding: '12px 14px',
                  borderRadius: 8,
                  margin: '8px 0',
                }}>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: 12, lineHeight: 1.5 }}>
                    <input
                      type="checkbox"
                      checked={autoConfirmChecked[profile.strategy] ?? true}
                      onChange={(e) =>
                        setAutoConfirmChecked((prev) => ({ ...prev, [profile.strategy]: e.target.checked }))
                      }
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      <strong>Explicit Customer Authorization:</strong> I authorize SmartExit to automatically execute Demo orders on Binance Demo for {isStrategy(profile.strategy)} at <strong>{profile.leverage}x leverage</strong> (max {profile.max_open_positions ?? 10} positions, max {profile.max_daily_loss_percent ? `${profile.max_daily_loss_percent}%` : '5%'} daily loss) without per-order confirmation.
                    </span>
                  </label>
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  type="submit"
                  className="button-primary"
                  disabled={busy}
                  style={{
                    minWidth: 220,
                    padding: '10px 20px',
                    fontWeight: 700,
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  {busy ? 'Saving…' : '💾 Save & Apply Strategy Settings'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    update(profile.strategy, {
                      sl_mode: 'ADAPTIVE_SMART',
                      adaptive_protection_enabled: true,
                      trailing_protection_enabled: true,
                      max_notional_usdt: '500.00',
                      leverage: 10,
                      risk_percentage: '1.0',
                    })
                  }
                >
                  Reset Defaults
                </button>
              </div>

              <p className="muted strategy-note">
                Connection status:{' '}
                {profile.exchange === 'BINANCE'
                  ? 'Active on Binance Demo derivatives'
                  : `${exchangeNames[profile.exchange]} customer adapter not ready`}
                . Live order execution is locked.
              </p>
            </form>
          );
        })}
      </div>
    </section>
  );
}
