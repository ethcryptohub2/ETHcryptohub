'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getSelectedAlertRingtone,
  isAudioUnlocked,
  setAlarmDuration,
  setAlarmVolume,
  setSelectedAlertRingtone,
  unlockAudio,
  type AlarmDuration,
  type AlertRingtone,
} from './notification-audio';

export interface UnifiedAlarmPreferences {
  userId?: number;
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
  volume: number;
  duration: AlarmDuration;
  ringtone: AlertRingtone;
}

export const DEFAULT_UNIFIED_PREFERENCES: UnifiedAlarmPreferences = {
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
  ringtone: 'custom-mp3',
};

const PREFS_STORAGE_KEY = 'ethcryptohub-notification-preferences';
const PREFS_EVENT = 'smartexit:alarm-prefs-updated';
const PREFS_CHANNEL = 'smartexit-prefs-sync';

export function loadStoredAlarmPreferences(): UnifiedAlarmPreferences {
  if (typeof window === 'undefined') return DEFAULT_UNIFIED_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    const ringtone = getSelectedAlertRingtone();
    if (!raw) return { ...DEFAULT_UNIFIED_PREFERENCES, ringtone };
    const parsed = JSON.parse(raw) as Partial<UnifiedAlarmPreferences>;
    return { ...DEFAULT_UNIFIED_PREFERENCES, ringtone, ...parsed };
  } catch {
    return DEFAULT_UNIFIED_PREFERENCES;
  }
}

export function saveStoredAlarmPreferences(prefs: UnifiedAlarmPreferences) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    setAlarmVolume(prefs.volume);
    setAlarmDuration(prefs.duration);
    if (prefs.ringtone) setSelectedAlertRingtone(prefs.ringtone);
  } catch {
    // ignore storage quota errors
  }
}

function broadcastPrefs(prefs: UnifiedAlarmPreferences) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: prefs }));
  if ('BroadcastChannel' in window) {
    try {
      const ch = new BroadcastChannel(PREFS_CHANNEL);
      ch.postMessage(prefs);
      ch.close();
    } catch {
      // ignore
    }
  }
}

async function fetchCsrfToken(): Promise<string> {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = (await response.json()) as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

type ServerPrefsPayload = {
  userId?: number;
  push_enabled?: boolean;
  sound_enabled?: boolean;
  tp1_enabled?: boolean;
  stop_loss_enabled?: boolean;
  alarm_volume?: number;
  do_not_disturb?: boolean;
  duration?: AlarmDuration;
  ringtone?: AlertRingtone;
  master_enabled?: boolean;
  standard_strategy_enabled?: boolean;
  high_risk_strategy_enabled?: boolean;
  repeated_trade_enabled?: boolean;
  trade_execution_enabled?: boolean;
  exchange_failure_enabled?: boolean;
};

function mergeServerPayload(
  current: UnifiedAlarmPreferences,
  server: ServerPrefsPayload,
): UnifiedAlarmPreferences {
  const next: UnifiedAlarmPreferences = {
    ...current,
    userId: server.userId ?? current.userId,
    sound_enabled: typeof server.sound_enabled === 'boolean' ? server.sound_enabled : current.sound_enabled,
    push_enabled: typeof server.push_enabled === 'boolean' ? server.push_enabled : current.push_enabled,
    take_profit_enabled: typeof server.tp1_enabled === 'boolean' ? server.tp1_enabled : current.take_profit_enabled,
    stop_loss_enabled: typeof server.stop_loss_enabled === 'boolean' ? server.stop_loss_enabled : current.stop_loss_enabled,
    volume: typeof server.alarm_volume === 'number' && Number.isFinite(server.alarm_volume) ? server.alarm_volume : current.volume,
    master_enabled:
      typeof server.master_enabled === 'boolean'
        ? server.master_enabled
        : typeof server.do_not_disturb === 'boolean'
          ? !server.do_not_disturb
          : current.master_enabled,
    duration:
      server.duration === 3 || server.duration === 5 || server.duration === 10 || server.duration === 'full'
        ? server.duration
        : current.duration,
    ringtone:
      server.ringtone && ['coin-drop', 'sharp-bell', 'digital-beep', 'high-conviction-siren', 'custom-mp3'].includes(server.ringtone)
        ? server.ringtone
        : current.ringtone,
    standard_strategy_enabled:
      typeof server.standard_strategy_enabled === 'boolean' ? server.standard_strategy_enabled : current.standard_strategy_enabled,
    high_risk_strategy_enabled:
      typeof server.high_risk_strategy_enabled === 'boolean' ? server.high_risk_strategy_enabled : current.high_risk_strategy_enabled,
    repeated_trade_enabled:
      typeof server.repeated_trade_enabled === 'boolean' ? server.repeated_trade_enabled : current.repeated_trade_enabled,
    trade_execution_enabled:
      typeof server.trade_execution_enabled === 'boolean' ? server.trade_execution_enabled : current.trade_execution_enabled,
    exchange_failure_enabled:
      typeof server.exchange_failure_enabled === 'boolean' ? server.exchange_failure_enabled : current.exchange_failure_enabled,
  };
  return next;
}

export function useAlarmPreferences() {
  const [preferences, setPreferences] = useState<UnifiedAlarmPreferences>(() => loadStoredAlarmPreferences());
  const [audioUnlocked, setAudioUnlocked] = useState(() => (typeof window !== 'undefined' ? isAudioUnlocked() : false));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from server source-of-truth on mount
  useEffect(() => {
    let active = true;
    fetch('/api/notifications/preferences', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return null;
        const json = (await res.json()) as { data?: ServerPrefsPayload };
        return json?.data ?? null;
      })
      .then((serverData) => {
        if (!active || !serverData) return;
        setPreferences((prev) => {
          // If localStorage belonged to another user, start from defaults
          const base = prev.userId && serverData.userId && prev.userId !== serverData.userId
            ? DEFAULT_UNIFIED_PREFERENCES
            : prev;
          const merged = mergeServerPayload(base, serverData);
          saveStoredAlarmPreferences(merged);
          return merged;
        });
        setHydrated(true);
      })
      .catch(() => {
        if (active) setHydrated(true);
      });

    return () => {
      active = false;
    };
  }, []);

  // Listen for cross-component and cross-tab updates
  useEffect(() => {
    const onLocalEvent = (e: Event) => {
      const detail = (e as CustomEvent<UnifiedAlarmPreferences>).detail;
      if (detail) setPreferences(detail);
    };
    window.addEventListener(PREFS_EVENT, onLocalEvent);

    let channel: BroadcastChannel | null = null;
    if ('BroadcastChannel' in window) {
      try {
        channel = new BroadcastChannel(PREFS_CHANNEL);
        channel.onmessage = (e) => {
          if (e.data) {
            setPreferences(e.data as UnifiedAlarmPreferences);
            saveStoredAlarmPreferences(e.data as UnifiedAlarmPreferences);
          }
        };
      } catch {
        // ignore
      }
    }

    return () => {
      window.removeEventListener(PREFS_EVENT, onLocalEvent);
      channel?.close();
    };
  }, []);

  // Unlock audio automatically on first interaction anywhere on page
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const unlockOnGesture = () => {
      void unlockAudio().then((unlocked) => {
        if (unlocked) {
          setAudioUnlocked(true);
          window.removeEventListener('pointerdown', unlockOnGesture);
          window.removeEventListener('keydown', unlockOnGesture);
        }
      });
    };
    window.addEventListener('pointerdown', unlockOnGesture, { passive: true });
    window.addEventListener('keydown', unlockOnGesture, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlockOnGesture);
      window.removeEventListener('keydown', unlockOnGesture);
    };
  }, []);

  const savePreferences = useCallback(async (targetPrefs?: Partial<UnifiedAlarmPreferences>) => {
    setSaveError('');
    setSaving(true);
    let previous = loadStoredAlarmPreferences();
    let nextPrefs = previous;

    const snapshot = targetPrefs ? { ...preferences, ...targetPrefs } : preferences;
    previous = preferences;
    nextPrefs = snapshot;

    try {
      const csrf = await fetchCsrfToken();
      const serverPatch: Record<string, unknown> = {
        sound_enabled: nextPrefs.sound_enabled,
        push_enabled: nextPrefs.push_enabled,
        tp1_enabled: nextPrefs.take_profit_enabled,
        tp2_enabled: nextPrefs.take_profit_enabled,
        tp3_enabled: nextPrefs.take_profit_enabled,
        stop_loss_enabled: nextPrefs.stop_loss_enabled,
        alarm_volume: nextPrefs.volume,
        master_enabled: nextPrefs.master_enabled,
        do_not_disturb: !nextPrefs.master_enabled,
        duration: nextPrefs.duration,
        ringtone: nextPrefs.ringtone,
        standard_strategy_enabled: nextPrefs.standard_strategy_enabled,
        high_risk_strategy_enabled: nextPrefs.high_risk_strategy_enabled,
        repeated_trade_enabled: nextPrefs.repeated_trade_enabled,
        trade_execution_enabled: nextPrefs.trade_execution_enabled,
        exchange_failure_enabled: nextPrefs.exchange_failure_enabled,
      };

      const resp = await fetch('/api/notifications/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(serverPatch),
      });

      if (!resp.ok) {
        const errBody = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errBody?.error ?? `Failed to save alarm settings (${resp.status}).`);
      }

      const json = (await resp.json().catch(() => null)) as { data?: ServerPrefsPayload } | null;
      if (!json?.data) {
        throw new Error('Server returned empty preferences response.');
      }

      const synced = mergeServerPayload(nextPrefs, json.data);
      setPreferences(synced);
      saveStoredAlarmPreferences(synced);
      broadcastPrefs(synced);
      return { ok: true, data: synced };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to save alarm preferences.';
      setSaveError(msg);
      // Revert if server rejected
      setPreferences(previous);
      saveStoredAlarmPreferences(previous);
      broadcastPrefs(previous);
      throw new Error(msg);
    } finally {
      setSaving(false);
    }
  }, [preferences]);

  const updatePreferences = useCallback(async (patch: Partial<UnifiedAlarmPreferences>) => {
    return savePreferences(patch);
  }, [savePreferences]);

  const handleUnlockAudio = useCallback(async () => {
    const ok = await unlockAudio();
    if (ok) setAudioUnlocked(true);
    return ok;
  }, []);

  return {
    preferences,
    setPreferences,
    audioUnlocked,
    saving,
    saveError,
    hydrated,
    savePreferences,
    updatePreferences,
    unlockAudio: handleUnlockAudio,
  };
}
