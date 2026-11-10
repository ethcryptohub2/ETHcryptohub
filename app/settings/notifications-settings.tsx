'use client';

import { useEffect, useState } from 'react';
import {
  ALERT_RINGTONES,
  getSelectedAlertRingtone,
  playSignalAlarm,
  setSelectedAlertRingtone as persistAlertRingtone,
  type AlertRingtone,
} from '../notification-audio';

type Preferences = {
  push_enabled: boolean;
  sound_enabled: boolean;
  long_enabled: boolean;
  short_enabled: boolean;
  high_conviction_enabled: boolean;
  tp1_enabled: boolean;
  tp2_enabled: boolean;
  tp3_enabled: boolean;
  stop_loss_enabled: boolean;
  expiry_enabled: boolean;
  minimum_setup_score: number;
  alarm_volume: number;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_timezone: string;
  do_not_disturb: boolean;
};

const defaultPreferences: Preferences = {
  push_enabled: false,
  sound_enabled: false,
  long_enabled: true,
  short_enabled: true,
  high_conviction_enabled: true,
  tp1_enabled: true,
  tp2_enabled: true,
  tp3_enabled: true,
  stop_loss_enabled: true,
  expiry_enabled: true,
  minimum_setup_score: 60,
  alarm_volume: 0.7,
  quiet_hours_enabled: false,
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  quiet_hours_timezone: 'UTC',
  do_not_disturb: false,
};

async function csrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

function applicationServerKey(value: string) {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function NotificationsSettings() {
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [soundUnlocked, setSoundUnlocked] = useState(false);
  const [selectedRingtone, setSelectedRingtone] = useState<AlertRingtone>('coin-drop');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void fetch('/api/notifications/preferences', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { data?: Preferences; error?: string };
        if (!response.ok || !body.data) throw new Error(body.error ?? 'Notification preferences unavailable.');
        if (active) {
          setPreferences(body.data);
          setSelectedRingtone(getSelectedAlertRingtone());
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Notification preferences unavailable.');
      })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences((current) => ({ ...current, [key]: value }));
  }

  async function save(nextPreferences = preferences, nextRingtone = selectedRingtone) {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const csrf = await csrfToken();
      const response = await fetch('/api/notifications/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(nextPreferences),
      });
      const body = await response.json() as { data?: Preferences; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Notification preferences could not be saved.');
      setPreferences(body.data);
      setSelectedRingtone(nextRingtone);
      persistAlertRingtone(nextRingtone);
      setMessage('Notification preferences saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Notification preferences could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function enablePush() {
    setError('');
    setMessage('');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        throw new Error('This browser does not support Web Push notifications.');
      }
      const permission = Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== 'granted') throw new Error('Browser or operating-system notification permission is not enabled.');
      const registration = await navigator.serviceWorker.register('/service-worker.js');
      const keyResponse = await fetch('/api/notifications/push', { cache: 'no-store' });
      const keyBody = await keyResponse.json() as { data?: { publicKey: string }; error?: string };
      if (!keyResponse.ok || !keyBody.data) throw new Error(keyBody.error ?? 'Web Push is not configured.');
      const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(keyBody.data.publicKey),
        });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
        throw new Error('The browser returned an incomplete push subscription.');
      }
      const csrf = await csrfToken();
      const saveResponse = await fetch('/api/notifications/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          deviceType: window.matchMedia('(display-mode: standalone)').matches ? 'pwa' : 'browser',
        }),
      });
      const saveBody = await saveResponse.json() as { error?: string };
      if (!saveResponse.ok) throw new Error(saveBody.error ?? 'Push subscription could not be saved.');
      setPreferences((current) => ({ ...current, push_enabled: true }));
      setMessage('Push notifications enabled for this account.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Push notifications could not be enabled.');
    }
  }

  async function disablePush() {
    setError('');
    setMessage('');
    try {
      const csrf = await csrfToken();
      const response = await fetch('/api/notifications/push', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ disableAll: true }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Push notifications could not be disabled.');
      const registration = await navigator.serviceWorker.getRegistration('/service-worker.js');
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      setPreferences((current) => ({ ...current, push_enabled: false }));
      setMessage('Push notifications disabled on all devices for this account.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Push notifications could not be disabled.');
    }
  }

  async function enableSound() {
    setError('');
    try {
      await playSignalAlarm(preferences.alarm_volume, selectedRingtone);
      setSoundUnlocked(true);
      await save({ ...preferences, sound_enabled: true }, selectedRingtone);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sound could not be enabled.');
    }
  }

  async function previewRingtone() {
    setError('');
    try {
      await playSignalAlarm(preferences.alarm_volume, selectedRingtone);
      setSoundUnlocked(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ringtone preview failed.');
    }
  }

  async function testNotification() {
    setError('');
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator)) {
        throw new Error('This browser does not support system notifications.');
      }
      const permission = Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== 'granted') throw new Error('Browser or operating-system notification permission is not enabled.');
      const registration = await navigator.serviceWorker.register('/service-worker.js');
      await registration.showNotification('ETHcryptohub test alert', {
        body: 'Notifications are enabled on this browser.',
        icon: '/icon.svg',
        data: { url: '/dashboard' },
      });
      setMessage('Test notification displayed.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Test notification failed.');
    }
  }

  if (busy) return <section className="card"><p className="muted">Loading notification preferences…</p></section>;

  return <section className="card stack notification-settings">
    <div><p className="mono">USER DASHBOARD · SETTINGS</p><h2>Notifications & alerts</h2><p className="muted">System delivery depends on browser permission, operating-system settings, and deployment push configuration.</p></div>
    <div className="notification-action-row">
      <div><strong>Push notifications</strong><p className="muted">{preferences.push_enabled ? 'Enabled for this account.' : 'Disabled until you grant browser permission.'}</p></div>
      {preferences.push_enabled
        ? <button type="button" className="button-secondary" onClick={() => void disablePush()}>Disable Notifications</button>
        : <button type="button" onClick={() => void enablePush()}>Enable Notifications</button>}
      <button type="button" className="button-secondary" onClick={() => void testNotification()}>Test Notification</button>
    </div>
    <div className="notification-action-row">
      <div><strong>Sound alarm</strong><p className="muted">{preferences.sound_enabled ? 'Enabled after browser interaction.' : 'Sound remains off until explicitly enabled.'}</p></div>
      <label className="notification-toggle"><input type="checkbox" checked={preferences.sound_enabled} onChange={(event) => update('sound_enabled', event.target.checked)} /> Sound ON/OFF</label>
      {!soundUnlocked && <button type="button" className="button-secondary" onClick={() => void enableSound()}>Enable Sound</button>}
      <div className="alert-ringtone-control">
        <label htmlFor="alert-ringtone">Alert Ringtone</label>
        <select id="alert-ringtone" value={selectedRingtone} onChange={(event) => {
          const ringtone = ALERT_RINGTONES.find((option) => option.value === event.target.value);
          if (ringtone) setSelectedRingtone(ringtone.value);
        }}>
          {ALERT_RINGTONES.map((ringtone) => <option key={ringtone.value} value={ringtone.value}>{ringtone.label}</option>)}
        </select>
        <button type="button" className="button-secondary" onClick={() => void previewRingtone()} aria-label={`Preview ${ALERT_RINGTONES.find((ringtone) => ringtone.value === selectedRingtone)?.label ?? 'selected'} ringtone`}>▶ Preview</button>
      </div>
      <button type="button" className="button-secondary" onClick={() => void previewRingtone()}>Test Alarm</button>
    </div>
    <div className="notification-preference-grid">
      {([
        ['long_enabled', 'LONG signals'],
        ['short_enabled', 'SHORT signals'],
        ['high_conviction_enabled', 'High conviction'],
        ['tp1_enabled', 'TP1 hit'],
        ['tp2_enabled', 'TP2 hit'],
        ['tp3_enabled', 'TP3 hit'],
        ['stop_loss_enabled', 'Stop Loss hit'],
        ['expiry_enabled', 'Expiry / entry invalidated'],
      ] as const).map(([key, label]) => <label className="notification-toggle" key={key}>
        <input type="checkbox" checked={preferences[key]} onChange={(event) => update(key, event.target.checked)} /> {label}
      </label>)}
    </div>
    <div className="notification-control-grid">
      <label>Minimum setup score <input type="number" min="0" max="100" value={preferences.minimum_setup_score} onChange={(event) => update('minimum_setup_score', Number(event.target.value))} /></label>
      <label>Alarm volume · {Math.round(preferences.alarm_volume * 100)}% <input type="range" min="0" max="1" step="0.05" value={preferences.alarm_volume} onChange={(event) => update('alarm_volume', Number(event.target.value))} /></label>
    </div>
    <div className="notification-action-row">
      <label className="notification-toggle"><input type="checkbox" checked={preferences.quiet_hours_enabled} onChange={(event) => update('quiet_hours_enabled', event.target.checked)} /> Quiet hours</label>
      <label className="notification-toggle"><input type="checkbox" checked={preferences.do_not_disturb} onChange={(event) => update('do_not_disturb', event.target.checked)} /> Do Not Disturb</label>
    </div>
    <div className="notification-control-grid">
      <label>Quiet hours start <input type="time" value={preferences.quiet_hours_start} onChange={(event) => update('quiet_hours_start', event.target.value)} /></label>
      <label>Quiet hours end <input type="time" value={preferences.quiet_hours_end} onChange={(event) => update('quiet_hours_end', event.target.value)} /></label>
      <label>Quiet hours time zone <input value={preferences.quiet_hours_timezone} onChange={(event) => update('quiet_hours_timezone', event.target.value)} maxLength={64} placeholder="Asia/Kolkata" /></label>
      <button type="button" className="button-secondary" onClick={() => update('quiet_hours_timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}>Use device timezone</button>
    </div>
    {message && <p className="success" role="status">{message}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div><button type="button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save Preferences'}</button></div>
    <details className="pwa-help"><summary>Install the app on Android or desktop</summary><p className="muted">On Android, use the browser menu and choose Install app or Add to Home screen. On desktop Chrome or Edge, use the install icon in the address bar or the browser menu. iOS notifications require an installed Home Screen web app and supported iOS version. Push may not work in private browsing or when OS notifications are disabled.</p></details>
  </section>;
}
