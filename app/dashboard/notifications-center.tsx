'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isWithinClientQuietHours, playSignalAlarm } from '../notification-audio';
import { SignalCountdown } from '../countdown';

type NotificationItem = {
  id: string;
  read_at: string | null;
  created_at: string;
  event_type: string;
  payload: { highConviction?: boolean } | null;
  signal_id: string;
  symbol: string;
  timeframe: string;
  side: 'LONG' | 'SHORT';
  setup_score: number;
  entry_price: string;
  initial_stop: string;
  tp1: string;
  tp2: string;
  tp3: string;
  generated_at: string;
  expires_at: string;
  status: string;
};

type ClientPreferences = {
  sound_enabled: boolean;
  alarm_volume: number;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_timezone: string;
  do_not_disturb: boolean;
};

async function getCsrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

function formatPrice(value: string) {
  const price = Number(value);
  return Number.isFinite(price)
    ? price.toLocaleString(undefined, { maximumSignificantDigits: 8 })
    : '—';
}

function eventLabel(event: NotificationItem) {
  if (event.event_type === 'NEW_SIGNAL') {
    return event.payload?.highConviction ? 'HIGH CONVICTION SIGNAL' : `${event.side} SIGNAL`;
  }
  return event.event_type.replaceAll('_', ' ');
}

export function NotificationsCenter() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [serverNow, setServerNow] = useState(new Date().toISOString());
  const [error, setError] = useState('');
  const [toast, setToast] = useState<NotificationItem | null>(null);
  const [loaded, setLoaded] = useState(false);
  const preferences = useRef<ClientPreferences | null>(null);
  const seen = useRef(new Set<string>());
  const initialized = useRef(false);

  const refresh = useCallback(async () => {
    const [notificationResponse, preferencesResponse] = await Promise.all([
      fetch('/api/notifications', { cache: 'no-store' }),
      preferences.current ? Promise.resolve(null) : fetch('/api/notifications/preferences', { cache: 'no-store' }),
    ]);
    const notificationBody = await notificationResponse.json() as {
      data?: { notifications: NotificationItem[]; unreadCount: number; serverNow: string };
      error?: string;
    };
    if (!notificationResponse.ok || !notificationBody.data) {
      throw new Error(notificationBody.error ?? 'Notification center is unavailable.');
    }
    if (preferencesResponse) {
      const preferenceBody = await preferencesResponse.json() as { data?: ClientPreferences; error?: string };
      if (!preferencesResponse.ok || !preferenceBody.data) {
        throw new Error(preferenceBody.error ?? 'Notification preferences are unavailable.');
      }
      preferences.current = preferenceBody.data;
    }

    const current = notificationBody.data.notifications;
    if (initialized.current) {
      const newNotifications = current.filter((notification) => !seen.current.has(notification.id));
      if (newNotifications[0]) {
        const toastKey = `ethcryptohub-notification-toast:${newNotifications[0].id}`;
        if (!localStorage.getItem(toastKey)) {
          localStorage.setItem(toastKey, '1');
          setToast(newNotifications[0]);
        }
      }
      for (const notification of current) {
        if (seen.current.has(notification.id)) continue;
        const key = `ethcryptohub-notification-played:${notification.id}`;
        if (notification.read_at === null && !localStorage.getItem(key)) {
          localStorage.setItem(key, '1');
          const prefs = preferences.current;
          if (
            prefs?.sound_enabled &&
            !prefs.do_not_disturb &&
            !isWithinClientQuietHours(
              prefs.quiet_hours_start,
              prefs.quiet_hours_end,
              prefs.quiet_hours_timezone,
              prefs.quiet_hours_enabled,
            )
          ) {
            try {
              const kind = notification.event_type === 'NEW_SIGNAL' && notification.payload?.highConviction
                ? 'HIGH'
                : notification.side;
              void playSignalAlarm(kind, prefs.alarm_volume)
                .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Signal sound could not be played.'));
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : 'Signal sound could not be played.');
            }
          }
        }
      }
    }
    for (const notification of current) seen.current.add(notification.id);
    initialized.current = true;
    setNotifications(current);
    setUnreadCount(notificationBody.data.unreadCount);
    setServerNow(notificationBody.data.serverNow);
    setError('');
  }, []);

  useEffect(() => {
    let active = true;
    const onServiceWorkerMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === 'SIGNAL_NOTIFICATION') void refresh();
    };
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);
    const run = async () => {
      try {
        await refresh();
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Notification center is unavailable.');
      } finally {
        if (active) setLoaded(true);
      }
    };
    void run();
    const timer = window.setInterval(() => { void run(); }, 12_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
    };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function markRead(id: string) {
    try {
      const csrf = await getCsrfToken();
      const response = await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ action: 'mark_read', id }),
      });
      if (!response.ok) throw new Error('Could not mark notification as read.');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not mark notification as read.');
    }
  }

  function openSignal(notification: NotificationItem) {
    if (notification.read_at) {
      router.push(`/signals/${notification.signal_id}`);
      return;
    }
    void markRead(notification.id).then(() => router.push(`/signals/${notification.signal_id}`));
  }

  async function markAllRead() {
    try {
      const csrf = await getCsrfToken();
      const response = await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ action: 'mark_all_read' }),
      });
      if (!response.ok) throw new Error('Could not mark notifications as read.');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not mark notifications as read.');
    }
  }

  return <section id="notifications" className="card stack notification-center">
    {toast && <div className="notification-toast" role="status">
      <div><strong>{eventLabel(toast)} · {toast.symbol}</strong><span>Score {toast.setup_score} · {toast.timeframe}</span></div>
      <Link href={`/signals/${toast.signal_id}`} onClick={(event) => {
        if (!toast.read_at) {
          event.preventDefault();
          openSignal(toast);
        }
      }}>View signal</Link>
      <button type="button" className="text-button" onClick={() => setToast(null)} aria-label="Dismiss notification">Dismiss</button>
    </div>}
    <div className="notification-center-heading">
      <div><p className="mono">LIVE ALERTS</p><h2><svg className="notification-bell" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg> Notification Center <span className="notification-count">{unreadCount}</span></h2></div>
      <button type="button" className="button-secondary" disabled={!unreadCount} onClick={() => void markAllRead()}>Mark All as Read</button>
    </div>
    <p className="muted">Server-saved signal events · synchronized at {new Date(serverNow).toLocaleTimeString()}</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!loaded && <p className="muted">Loading notifications…</p>}
    {loaded && notifications.length === 0 && <p className="notification-empty">No signal notifications yet. Your history will appear here.</p>}
    <div className="notification-list">
      {notifications.map((notification) => <article className={`notification-item${notification.read_at ? '' : ' is-unread'}`} key={notification.id}>
        <div className="notification-item-top">
          <div><span className={`scanner-signal-badge ${notification.side === 'LONG' ? 'is-long' : 'is-short'}`}>{eventLabel(notification)}</span><strong>{notification.symbol} · {notification.timeframe}</strong></div>
          <time dateTime={notification.created_at}>{new Date(notification.created_at).toLocaleString()}</time>
        </div>
        <div className="notification-details">
          <span>Score <strong>{notification.setup_score}/100</strong></span>
          <span>Entry <strong>{formatPrice(notification.entry_price)}</strong></span>
          <span>Stop <strong>{formatPrice(notification.initial_stop)}</strong></span>
          <span>TP1 <strong>{formatPrice(notification.tp1)}</strong></span>
          <span>TP2 <strong>{formatPrice(notification.tp2)}</strong></span>
          <span>TP3 <strong>{formatPrice(notification.tp3)}</strong></span>
        </div>
        <div className="notification-item-bottom">
          <span className="muted">{notification.status.replaceAll('_', ' ')}</span>
          {['ACTIVE', 'TP1_HIT', 'TP2_HIT'].includes(notification.status)
            ? <SignalCountdown expiresAt={notification.expires_at} serverNow={serverNow} status={notification.status} />
            : <span className="signal-countdown is-expired">{notification.status.replaceAll('_', ' ')}</span>}
          <Link href={`/signals/${notification.signal_id}`} onClick={(event) => {
            if (!notification.read_at) {
              event.preventDefault();
              openSignal(notification);
            }
          }}>Open signal</Link>
          {!notification.read_at && <button type="button" className="text-button" onClick={() => void markRead(notification.id)}>Mark as Read</button>}
        </div>
      </article>)}
    </div>
  </section>;
}
