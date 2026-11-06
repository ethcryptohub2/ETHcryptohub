self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'ETHcryptohub alert', body: event.data?.text() ?? 'A new trading signal is available.' };
  }
  const title = typeof payload.title === 'string' ? payload.title : 'ETHcryptohub alert';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : 'A signal event is available.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: typeof payload.eventId === 'string' ? `signal-${payload.eventId}` : undefined,
    renotify: false,
    actions: [
      { action: 'open', title: 'Open signal' },
      { action: 'mark-read', title: 'Mark as read' },
    ],
    data: {
      url: typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/dashboard',
      eventId: payload.eventId,
    },
  };
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visibleWindows = windows.filter((client) => {
      if (!client.url.startsWith(self.location.origin) || client.visibilityState !== 'visible') return false;
      return new URL(client.url).pathname.startsWith('/dashboard');
    });
    if (visibleWindows.length > 0) {
      for (const client of visibleWindows) {
        client.postMessage({ type: 'SIGNAL_NOTIFICATION', eventId: payload.eventId });
      }
      return;
    }
    return self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notificationId = event.notification.data?.eventId;
  const markAsRead = async () => {
    if (typeof notificationId !== 'string' || !/^\d+$/.test(notificationId)) return;
    const csrfResponse = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
    const csrfBody = await csrfResponse.json();
    if (!csrfResponse.ok || typeof csrfBody.data?.csrfToken !== 'string') {
      throw new Error('Secure session unavailable.');
    }
    const response = await fetch('/api/notifications', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfBody.data.csrfToken,
      },
      body: JSON.stringify({ action: 'mark_read', id: notificationId }),
    });
    if (!response.ok) throw new Error('Could not mark notification as read.');
  };
  if (event.action === 'mark-read') {
    event.waitUntil((async () => {
      try {
        await markAsRead();
      } catch (error) {
        console.error('Notification action failed:', error);
      }
    })());
    return;
  }
  const target = new URL(event.notification.data?.url ?? '/dashboard', self.location.origin).href;
  event.waitUntil((async () => {
    try {
      await markAsRead();
    } catch (error) {
      console.error('Could not mark clicked notification as read:', error);
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        await client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
