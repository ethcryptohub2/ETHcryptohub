'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Notification = {
  id: string | number;
  created_at: string;
  event_type: string;
  read_at: string | null;
  symbol: string;
};

type NotificationFeed =
  | { state: 'loading' | 'error' }
  | { state: 'ready'; unreadCount: number; notifications: Notification[] };

export function PanelNotifications({ access, newsUnread, onUnreadCount, onNavigate }: {
  access: 'available' | 'pending' | 'restricted' | 'unavailable';
  newsUnread: number;
  onUnreadCount: (count: number) => void;
  onNavigate: () => void;
}) {
  const [feed, setFeed] = useState<NotificationFeed>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (access !== 'available') return;
    const controller = new AbortController();
    void fetch('/api/notifications', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Notification feed unavailable.');
        const { data } = await response.json() as { data?: { unreadCount: number; notifications: Notification[] } };
        if (!data || !Number.isSafeInteger(data.unreadCount) || data.unreadCount < 0 || !Array.isArray(data.notifications)) {
          throw new Error('Invalid notification feed.');
        }
        const recent = data.notifications.slice(0, 5);
        if (recent.some((event) => !event || typeof event.symbol !== 'string' || typeof event.event_type !== 'string' ||
            !Number.isFinite(Date.parse(event.created_at)) || !['string', 'number'].includes(typeof event.id))) {
          throw new Error('Invalid notification event.');
        }
        if (controller.signal.aborted) return;
        onUnreadCount(data.unreadCount);
        setFeed({ state: 'ready', unreadCount: data.unreadCount, notifications: recent });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFeed({ state: 'error' });
      });
    return () => controller.abort();
  }, [access, attempt, onUnreadCount]);

  return (
    <section aria-labelledby="panel-notifications-title">
      <h2 id="panel-notifications-title">Notifications</h2>
      <div className="panel-notification-status" aria-live="polite">
        {access === 'pending' && <p className="muted">Checking notification access…</p>}
        {access === 'unavailable' && <p className="muted">Notification access is unavailable.</p>}
        {access === 'restricted' && <p className="muted">Signal notifications require active membership access.</p>}
        {access === 'available' && feed.state === 'loading' && <p className="muted">Loading recent notifications…</p>}
        {access === 'available' && feed.state === 'error' && <>
          <p className="muted">Recent notifications could not be loaded.</p>
          <button type="button" className="button-secondary" onClick={() => {
            setFeed({ state: 'loading' });
            setAttempt((value) => value + 1);
          }}>Retry</button>
        </>}
        {access === 'available' && feed.state === 'ready' && <>
          <p className="muted">{feed.unreadCount} unread signal {feed.unreadCount === 1 ? 'notification' : 'notifications'}</p>
          {feed.notifications.length ? <ul className="panel-notification-list">
            {feed.notifications.map((event) => <li key={event.id}>
              <strong>{event.symbol} · {event.event_type.replaceAll('_', ' ')}</strong>
              <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time>
              {event.read_at === null && <span className="muted">Unread</span>}
            </li>)}
          </ul> : <p className="muted">No recent signal notifications.</p>}
        </>}
      </div>
      <div className="panel-notification-links">
        {access === 'available' && <Link href="/dashboard#notifications" onClick={onNavigate}>View signal notifications</Link>}
        <Link href="/news" onClick={onNavigate}>Crypto news{newsUnread > 0 ? ` (${newsUnread} unread)` : ''}</Link>
      </div>
    </section>
  );
}
