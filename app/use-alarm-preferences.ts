'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  isAudioUnlocked,
  setAlarmDuration,
  setAlarmVolume,
  unlockAudio,
  type AlarmDuration,
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
};

const PREFS_STORAGE_KEY = 'ethcryptohub-notification-preferences';
const PREFS_EVENT = 'smartexit:alarm-prefs-updated';
const PREFS_CHANNEL = 'smartexit-prefs-sync';

export function loadStoredAlarmPreferences(): UnifiedAlarmPreferences {
  if (typeof window === 'undefined') return DEFAULT_UNIFIED_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_UNIFIED_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<UnifiedAlarmPreferences>;
    return { ...DEFAULT_UNIFIED_PREFERENCES, ...parsed };
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

  const updatePreferences = useCallback(async (patch: Partial<UnifiedAlarmPreferences>) => {
    setSaveError('');
    setSaving(true);
    let previous = loadStoredAlarmPreferences();
    let nextPrefs = previous;
    setPreferences((curr) => {
      previous = curr;
      nextPrefs = { ...curr, ...patch };
      saveStoredAlarmPreferences(nextPrefs);
      broadcastPrefs(nextPrefs);
      return nextPrefs;
    });

    try {
      const csrf = await fetchCsrfToken();
      const serverPatch: Record<string, unknown> = {};
      if (patch.sound_enabled !== undefined) serverPatch.sound_enabled = patch.sound_enabled;
      if (patch.push_enabled !== undefined) serverPatch.push_enabled = patch.push_enabled;
      if (patch.take_profit_enabled !== undefined) {
        serverPatch.tp1_enabled = patch.take_profit_enabled;
        serverPatch.tp2_enabled = patch.take_profit_enabled;
        serverPatch.tp3_enabled = patch.take_profit_enabled;
      }
      if (patch.stop_loss_enabled !== undefined) serverPatch.stop_loss_enabled = patch.stop_loss_enabled;
      if (patch.volume !== undefined) serverPatch.alarm_volume = patch.volume;
      if (patch.master_enabled !== undefined) {
        serverPatch.master_enabled = patch.master_enabled;
        serverPatch.do_not_disturb = !patch.master_enabled;
      }
      if (patch.duration !== undefined) serverPatch.duration = patch.duration;
      if (patch.standard_strategy_enabled !== undefined) serverPatch.standard_strategy_enabled = patch.standard_strategy_enabled;
      if (patch.high_risk_strategy_enabled !== undefined) serverPatch.high_risk_strategy_enabled = patch.high_risk_strategy_enabled;
      if (patch.repeated_trade_enabled !== undefined) serverPatch.repeated_trade_enabled = patch.repeated_trade_enabled;
      if (patch.trade_execution_enabled !== undefined) serverPatch.trade_execution_enabled = patch.trade_execution_enabled;
      if (patch.exchange_failure_enabled !== undefined) serverPatch.exchange_failure_enabled = patch.exchange_failure_enabled;

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
      if (json?.data) {
        const synced = mergeServerPayload(nextPrefs, json.data);
        setPreferences(synced);
        saveStoredAlarmPreferences(synced);
        broadcastPrefs(synced);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unable to save alarm preference.');
      // Revert only if server rejected
      setPreferences(previous);
      saveStoredAlarmPreferences(previous);
      broadcastPrefs(previous);
    } finally {
      setSaving(false);
    }
  }, []);

  const handleUnlockAudio = useCallback(async () => {
    const ok = await unlockAudio();
    if (ok) setAudioUnlocked(true);
    return ok;
  }, []);

  return {
    preferences,
    audioUnlocked,
    saving,
    saveError,
    hydrated,
    updatePreferences,
    unlockAudio: handleUnlockAudio,
  };
}
