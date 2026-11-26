'use client';

import Link from 'next/link';
import { useEffect, useState, useRef } from 'react';
import {
  playAlarm,
  stopAlarm,
  unlockAudio,
  isAudioUnlocked,
  getAlarmVolume,
  setAlarmVolume,
  getAlarmDuration,
  setAlarmDuration,
  type AlarmDuration,
} from './notification-audio';

export type NotificationItem = {
  id: string | number;
  created_at: string;
  event_type: string;
  read_at: string | null;
  symbol: string;
  timeframe?: string;
  side?: 'LONG' | 'SHORT';
  setup_score?: number;
  entry_price?: string;
  initial_stop?: string;
  tp1?: string;
  tp2?: string;
  tp3?: string;
  strategy_name?: string;
  scanner_type?: 'STANDARD' | 'HIGH_RISK';
  repeated_scan_count?: number | string;
  payload?: {
    highConviction?: boolean;
    scannerType?: string;
    tradeId?: string;
    fillPrice?: number;
    fillQuantity?: number;
    exchange?: string;
    failureReason?: string;
  } | null;
};

export type NotificationPreferences = {
  master_enabled: boolean;
  sound_enabled: boolean;
  push_enabled: boolean;
  standard_strategy_enabled: boolean;
  high_risk_strategy_enabled: boolean;
  repeated_trade_enabled: boolean;
  trade_execution_enabled: boolean;
  take_profit_enabled: boolean;
  stop_loss_enabled: boolean;
  exchange_failure_enabled: boolean;
  volume: number; // 0 to 1
  duration: AlarmDuration; // 3, 5, 10, 'full'
};

const PREFERENCES_STORAGE_KEY = 'ethcryptohub-notification-preferences';

const DEFAULT_PREFERENCES: NotificationPreferences = {
  master_enabled: true,
  sound_enabled: true,
  push_enabled: false,
  standard_strategy_enabled: true,
  high_risk_strategy_enabled: true,
  repeated_trade_enabled: true,
  trade_execution_enabled: true,
  take_profit_enabled: true,
  stop_loss_enabled: true,
  exchange_failure_enabled: true,
  volume: 0.8,
  duration: 5,
};

function loadStoredPreferences(): NotificationPreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_PREFERENCES,
        ...parsed,
        volume: getAlarmVolume(),
        duration: getAlarmDuration(),
      };
    }
  } catch {}
  return DEFAULT_PREFERENCES;
}

function saveStoredPreferences(prefs: NotificationPreferences) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
    setAlarmVolume(prefs.volume);
    setAlarmDuration(prefs.duration);
  } catch {}
}

async function getCsrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = (await response.json()) as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

function eventBadge(event: NotificationItem) {
  const type = event.event_type;
  if (type === 'NEW_SIGNAL' || type === 'SIGNAL_GENERATED') {
    const isHighRisk = event.scanner_type === 'HIGH_RISK';
    return {
      label: isHighRisk ? 'HIGH-RISK SIGNAL' : `${event.side || 'TRADE'} SIGNAL`,
      color: event.side === 'LONG' ? 'var(--color-success, #10b981)' : 'var(--color-danger, #ef4444)',
      bg: event.side === 'LONG' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
      isSignal: true,
    };
  }
  if (type === 'SIGNAL_UPDATED') {
    return {
      label: 'REPEATED SETUP',
      color: 'var(--color-warning, #f59e0b)',
      bg: 'rgba(245, 158, 11, 0.12)',
      isSignal: true,
    };
  }
  if (type.includes('TP1') || type.includes('TP2') || type.includes('TP3') || type === 'PARTIAL_TARGET_HIT') {
    return {
      label: type.replaceAll('_', ' '),
      color: 'var(--color-success, #10b981)',
      bg: 'rgba(16, 185, 129, 0.15)',
      isExecution: true,
    };
  }
  if (type.includes('STOP_LOSS') || type.includes('INVALIDATED')) {
    return {
      label: type.replaceAll('_', ' '),
      color: 'var(--color-danger, #ef4444)',
      bg: 'rgba(239, 68, 68, 0.15)',
      isExecution: true,
    };
  }
  if (type.includes('ENTRY_MARKED') || type.includes('ENTERED') || type.includes('FILLED')) {
    return {
      label: 'CONFIRMED EXECUTION',
      color: '#3b82f6',
      bg: 'rgba(59, 130, 246, 0.15)',
      isExecution: true,
    };
  }
  if (type.includes('FAILURE') || type.includes('REJECTED') || type.includes('EMERGENCY')) {
    return {
      label: type.replaceAll('_', ' '),
      color: '#dc2626',
      bg: 'rgba(220, 38, 38, 0.2)',
      isExecution: true,
    };
  }
  return {
    label: type.replaceAll('_', ' '),
    color: 'var(--text-secondary)',
    bg: 'var(--surface-raised)',
    isSignal: false,
  };
}

export function PanelNotifications({
  access,
  newsUnread,
  onUnreadCount,
  onNavigate,
}: {
  access: 'available' | 'pending' | 'restricted' | 'unavailable';
  newsUnread: number;
  onUnreadCount: (count: number) => void;
  onNavigate: () => void;
}) {
  const [tab, setTab] = useState<'feed' | 'settings'>('feed');
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(access === 'available');
  const [error, setError] = useState('');
  const [audioUnlocked, setAudioUnlocked] = useState(() => (typeof window !== 'undefined' ? isAudioUnlocked() : false));
  const [soundPlaying, setSoundPlaying] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences>(() =>
    typeof window !== 'undefined' ? loadStoredPreferences() : DEFAULT_PREFERENCES,
  );
  const sseRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let active = true;

    if (access === 'available') {
      fetch('/api/notifications', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Feed error'))))
        .then((json) => {
          if (!active) return;
          if (json?.data) {
            setNotifications(json.data.notifications || []);
            const unread = json.data.unreadCount ?? 0;
            setUnreadCount(unread);
            onUnreadCount(unread);
          }
        })
        .catch(() => {
          if (active) setError('Unable to load notifications.');
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }

    // Connect real-time SSE stream with auto reconnect
    if (access === 'available' && typeof window !== 'undefined' && 'EventSource' in window) {
      const sse = new EventSource('/api/notifications/stream');
      sseRef.current = sse;

      sse.addEventListener('notification', (e) => {
        try {
          const item: NotificationItem = JSON.parse(e.data);
          setNotifications((prev) => [item, ...prev.filter((n) => n.id !== item.id)]);
          setUnreadCount((count) => {
            const next = count + 1;
            onUnreadCount(next);
            return next;
          });

          // Play alarm if enabled
          const currentPrefs = loadStoredPreferences();
          if (currentPrefs.master_enabled && currentPrefs.sound_enabled) {
            const badge = eventBadge(item);
            if (badge.isExecution && currentPrefs.trade_execution_enabled) {
              void playAlarm('execution', { volume: currentPrefs.volume, duration: currentPrefs.duration });
            } else if (badge.isSignal) {
              const isHighRisk = item.scanner_type === 'HIGH_RISK';
              if (
                (isHighRisk && currentPrefs.high_risk_strategy_enabled) ||
                (!isHighRisk && currentPrefs.standard_strategy_enabled)
              ) {
                void playAlarm('signal', { volume: currentPrefs.volume, duration: currentPrefs.duration });
              }
            }
          }
        } catch {}
      });

      sse.onerror = () => {
        // SSE automatically attempts reconnection
      };

      return () => {
        active = false;
        sse.close();
        sseRef.current = null;
      };
    }

    return () => {
      active = false;
    };
  }, [access, onUnreadCount]);

  const handleUnlockAudio = async () => {
    const ok = await unlockAudio();
    if (ok) setAudioUnlocked(true);
  };

  const handleTestSignalSound = async () => {
    await handleUnlockAudio();
    setSoundPlaying(true);
    await playAlarm('signal', { volume: preferences.volume, duration: preferences.duration, force: true });
    setTimeout(() => setSoundPlaying(false), (preferences.duration === 'full' ? 10 : preferences.duration) * 1000);
  };

  const handleTestExecutionSound = async () => {
    await handleUnlockAudio();
    setSoundPlaying(true);
    await playAlarm('execution', { volume: preferences.volume, duration: preferences.duration, force: true });
    setTimeout(() => setSoundPlaying(false), (preferences.duration === 'full' ? 10 : preferences.duration) * 1000);
  };

  const handleStopAlarm = () => {
    stopAlarm();
    setSoundPlaying(false);
  };

  const handleMarkRead = async (id: string | number) => {
    try {
      const csrf = await getCsrfToken();
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ action: 'mark_read', id }),
      });
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)),
      );
      setUnreadCount((c) => {
        const next = Math.max(0, c - 1);
        onUnreadCount(next);
        return next;
      });
    } catch {}
  };

  const handleMarkAllRead = async () => {
    setBusyAction(true);
    try {
      const csrf = await getCsrfToken();
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ action: 'mark_all_read' }),
      });
      setNotifications((prev) => prev.map((n) => ({ ...n, read_at: new Date().toISOString() })));
      setUnreadCount(0);
      onUnreadCount(0);
    } catch {}
    finally {
      setBusyAction(false);
    }
  };

  const handleClearAll = async () => {
    setBusyAction(true);
    try {
      const csrf = await getCsrfToken();
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ action: 'clear_all' }),
      });
      setNotifications([]);
      setUnreadCount(0);
      onUnreadCount(0);
      setConfirmClear(false);
    } catch {}
    finally {
      setBusyAction(false);
    }
  };

  const updatePreference = <K extends keyof NotificationPreferences>(key: K, val: NotificationPreferences[K]) => {
    const next = { ...preferences, [key]: val };
    setPreferences(next);
    saveStoredPreferences(next);

    // Sync with backend preferences API
    void getCsrfToken()
      .then((csrf) =>
        fetch('/api/notifications/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({
            push_enabled: next.push_enabled,
            sound_enabled: next.sound_enabled,
            long_enabled: true,
            short_enabled: true,
            high_conviction_enabled: true,
            tp1_enabled: next.take_profit_enabled,
            tp2_enabled: next.take_profit_enabled,
            tp3_enabled: next.take_profit_enabled,
            stop_loss_enabled: next.stop_loss_enabled,
            expiry_enabled: true,
            minimum_setup_score: 60,
            alarm_volume: next.volume,
            quiet_hours_enabled: false,
            quiet_hours_start: '22:00',
            quiet_hours_end: '07:00',
            quiet_hours_timezone: 'UTC',
            do_not_disturb: !next.master_enabled,
          }),
        }),
      )
      .catch(() => {});
  };

  return (
    <div className="notification-center-dropdown" style={{ width: '100%', minWidth: 320, maxWidth: 440 }}>
      {/* Header bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid var(--surface-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Notifications</h2>
          {unreadCount > 0 && (
            <span style={{ background: 'var(--color-primary, #6366f1)', color: '#fff', fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 99 }}>
              {unreadCount}
            </span>
          )}
        </div>

        {/* Tab switcher */}
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-raised)', padding: 3, borderRadius: 8 }}>
          <button
            type="button"
            onClick={() => setTab('feed')}
            style={{
              border: 'none',
              background: tab === 'feed' ? 'var(--surface)' : 'transparent',
              color: tab === 'feed' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              padding: '4px 10px',
              borderRadius: 6,
              cursor: 'pointer',
              boxShadow: tab === 'feed' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            Alerts
          </button>
          <button
            type="button"
            onClick={() => setTab('settings')}
            style={{
              border: 'none',
              background: tab === 'settings' ? 'var(--surface)' : 'transparent',
              color: tab === 'settings' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              padding: '4px 10px',
              borderRadius: 6,
              cursor: 'pointer',
              boxShadow: tab === 'settings' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            Alarms & Settings
          </button>
        </div>
      </div>

      {/* Autoplay unlock warning banner if not yet clicked */}
      {!audioUnlocked && preferences.sound_enabled && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'rgba(99, 102, 241, 0.12)',
            border: '1px solid var(--color-primary, #6366f1)',
            borderRadius: 8,
            padding: '8px 12px',
            marginBottom: 12,
            fontSize: 12,
          }}
        >
          <span>Enable sound to hear live alarms.</span>
          <button
            type="button"
            onClick={handleUnlockAudio}
            style={{
              background: 'var(--color-primary, #6366f1)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Enable Sound
          </button>
        </div>
      )}

      {/* Feed Tab */}
      {tab === 'feed' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {notifications.length} {notifications.length === 1 ? 'alert' : 'alerts'} logged
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              {unreadCount > 0 && (
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busyAction}
                  onClick={handleMarkAllRead}
                  style={{ fontSize: 11, padding: '3px 8px' }}
                >
                  Mark all read
                </button>
              )}
              {notifications.length > 0 && !confirmClear && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setConfirmClear(true)}
                  style={{ fontSize: 11, padding: '3px 8px', color: 'var(--color-danger, #ef4444)' }}
                >
                  Clear history
                </button>
              )}
              {confirmClear && (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={handleClearAll}
                    disabled={busyAction}
                    style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}
                  >
                    Confirm Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(false)}
                    style={{ background: 'transparent', border: '1px solid var(--surface-border)', borderRadius: 4, padding: '3px 6px', fontSize: 11, cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div style={{ padding: '8px 12px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderRadius: 6, fontSize: 12, marginBottom: 8 }}>
              {error}
            </div>
          )}

          {loading ? (
            <p className="muted" style={{ fontSize: 13 }}>Loading recent notifications…</p>
          ) : notifications.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-secondary)' }}>
              <p style={{ margin: 0, fontSize: 13 }}>No alerts yet.</p>
              <p style={{ margin: '4px 0 0', fontSize: 11 }}>Active scanner and execution events will stream here live.</p>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {notifications.map((item) => {
                const badge = eventBadge(item);
                const isUnread = item.read_at === null;
                return (
                  <li
                    key={item.id}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      border: isUnread ? '1px solid rgba(99, 102, 241, 0.4)' : '1px solid var(--surface-border)',
                      background: isUnread ? 'rgba(99, 102, 241, 0.04)' : 'var(--surface)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      position: 'relative',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: 0.5,
                          padding: '2px 6px',
                          borderRadius: 4,
                          color: badge.color,
                          background: badge.bg,
                        }}
                      >
                        {badge.label}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                          {new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        {isUnread && (
                          <button
                            type="button"
                            title="Mark as read"
                            onClick={() => handleMarkRead(item.id)}
                            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, color: 'var(--color-primary, #6366f1)', padding: 0 }}
                          >
                            ✓
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 2 }}>
                      <strong style={{ fontSize: 14 }}>{item.symbol}</strong>
                      {item.entry_price && (
                        <span style={{ fontSize: 12, fontFamily: 'monospace' }}>
                          Entry: ${Number(item.entry_price).toLocaleString()}
                        </span>
                      )}
                    </div>

                    {(item.tp1 || item.initial_stop) && (
                      <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                        {item.initial_stop && <span>SL: ${Number(item.initial_stop).toLocaleString()}</span>}
                        {item.tp1 && <span>TP1: ${Number(item.tp1).toLocaleString()}</span>}
                        {item.tp2 && <span>TP2: ${Number(item.tp2).toLocaleString()}</span>}
                      </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                        {item.strategy_name || item.scanner_type || 'SYSTEM'}
                      </span>
                      <Link
                        href={`/scanner?symbol=${item.symbol}`}
                        onClick={onNavigate}
                        style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-primary, #6366f1)', textDecoration: 'none' }}
                      >
                        View Signal →
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Settings Tab */}
      {tab === 'settings' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 }}>
          {/* Quick Sound Control Buttons */}
          <div style={{ background: 'var(--surface-raised)', padding: 12, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)' }}>
              Alarm Audio Verification
            </span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="button-secondary"
                onClick={handleTestSignalSound}
                style={{ flex: '1 1 auto', fontSize: 11, padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <span>🔔</span> Test Signal Sound
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={handleTestExecutionSound}
                style={{ flex: '1 1 auto', fontSize: 11, padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <span>⚡</span> Test Execution Sound
              </button>
              <button
                type="button"
                onClick={handleStopAlarm}
                style={{
                  background: soundPlaying ? '#dc2626' : '#ef4444',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  padding: '6px 12px',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: soundPlaying ? '0 0 8px rgba(239, 68, 68, 0.6)' : 'none',
                }}
              >
                {soundPlaying ? '⏹ Stop Alarm (Playing)' : '⏹ Stop Alarm'}
              </button>
            </div>

            {/* Volume Slider */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}>
                <span>Alarm Volume:</span>
                <strong>{Math.round(preferences.volume * 100)}%</strong>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={Math.round(preferences.volume * 100)}
                onChange={(e) => updatePreference('volume', Number(e.target.value) / 100)}
                style={{ width: '100%', cursor: 'pointer' }}
              />
            </div>

            {/* Duration Selector */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                <span>Playback Duration:</span>
                <strong>{preferences.duration === 'full' ? 'Full Audio' : `${preferences.duration} seconds`}</strong>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {([3, 5, 10, 'full'] as AlarmDuration[]).map((dur) => (
                  <button
                    key={dur}
                    type="button"
                    onClick={() => updatePreference('duration', dur)}
                    style={{
                      flex: 1,
                      border: preferences.duration === dur ? '1px solid var(--color-primary, #6366f1)' : '1px solid var(--surface-border)',
                      background: preferences.duration === dur ? 'rgba(99, 102, 241, 0.15)' : 'var(--surface)',
                      color: preferences.duration === dur ? 'var(--color-primary, #6366f1)' : 'var(--text-secondary)',
                      fontWeight: preferences.duration === dur ? 700 : 500,
                      borderRadius: 6,
                      padding: '4px 0',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    {dur === 'full' ? 'Full' : `${dur}s`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Master Toggles */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <span>Master Notifications</span>
              <input
                type="checkbox"
                checked={preferences.master_enabled}
                onChange={(e) => updatePreference('master_enabled', e.target.checked)}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <span>Audio Sound Alarms</span>
              <input
                type="checkbox"
                checked={preferences.sound_enabled}
                onChange={(e) => updatePreference('sound_enabled', e.target.checked)}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <span>Desktop & Mobile Push</span>
              <input
                type="checkbox"
                checked={preferences.push_enabled}
                onChange={(e) => updatePreference('push_enabled', e.target.checked)}
              />
            </label>
          </div>

          <div style={{ height: 1, background: 'var(--surface-border)' }} />

          {/* Trigger Alert Categories */}
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)' }}>
            Alert Triggers
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <span>Standard Strategy Signals</span>
              <input
                type="checkbox"
                checked={preferences.standard_strategy_enabled}
                onChange={(e) => updatePreference('standard_strategy_enabled', e.target.checked)}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <span>High-Risk Scalping Signals</span>
              <input
                type="checkbox"
                checked={preferences.high_risk_strategy_enabled}
                onChange={(e) => updatePreference('high_risk_strategy_enabled', e.target.checked)}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <span>Repeated Trade Setups</span>
              <input
                type="checkbox"
                checked={preferences.repeated_trade_enabled}
                onChange={(e) => updatePreference('repeated_trade_enabled', e.target.checked)}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <span>Trade Execution & Fills</span>
              <input
                type="checkbox"
                checked={preferences.trade_execution_enabled}
                onChange={(e) => updatePreference('trade_execution_enabled', e.target.checked)}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <span>Take Profit Targets (TP1/2/3)</span>
              <input
                type="checkbox"
                checked={preferences.take_profit_enabled}
                onChange={(e) => updatePreference('take_profit_enabled', e.target.checked)}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <span>Stop Loss & Invalidation</span>
              <input
                type="checkbox"
                checked={preferences.stop_loss_enabled}
                onChange={(e) => updatePreference('stop_loss_enabled', e.target.checked)}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <span>Exchange Failure & Emergency</span>
              <input
                type="checkbox"
                checked={preferences.exchange_failure_enabled}
                onChange={(e) => updatePreference('exchange_failure_enabled', e.target.checked)}
              />
            </label>
          </div>
        </div>
      )}

      {/* Footer links */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--surface-border)', fontSize: 12 }}>
        <Link href="/dashboard" onClick={onNavigate}>
          Dashboard
        </Link>
        <Link href="/scanner" onClick={onNavigate}>
          Live Scanner
        </Link>
        <Link href="/news" onClick={onNavigate}>
          News {newsUnread > 0 ? `(${newsUnread})` : ''}
        </Link>
      </div>
    </div>
  );
}
