'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LogoutButton } from './logout-button';

type PanelUser = { role: 'user' | 'admin'; email: string } | null;
type Subscription = {
  status: 'FREE_TRIAL' | 'PREMIUM_ACTIVE' | 'TRIAL_EXPIRED' | 'PREMIUM_EXPIRED';
  hasPremiumAccess: boolean;
  trialExpiresAt: string;
  premiumExpiresAt: string | null;
};

function membershipLabel(subscription: Subscription) {
  const expiry = subscription.status === 'PREMIUM_ACTIVE'
    ? subscription.premiumExpiresAt
    : subscription.status === 'FREE_TRIAL'
      ? subscription.trialExpiresAt
      : null;
  if (!expiry) {
    return {
      label: subscription.status === 'PREMIUM_EXPIRED' ? 'Premium expired' : 'Trial ended',
      className: 'is-expired',
      title: 'Membership access has expired.',
    };
  }
  const remainingMs = Date.parse(expiry) - Date.now();
  const days = Math.max(0, Math.ceil(remainingMs / 86_400_000));
  const remaining = days > 0 ? `${days}d left` : 'Less than 1d left';
  const isPremium = subscription.status === 'PREMIUM_ACTIVE';
  return {
    label: `${isPremium ? 'Premium' : 'Free trial'} · ${remaining}`,
    className: isPremium ? days <= 7 ? 'is-expiring' : 'is-premium' : 'is-free',
    title: `${isPremium ? 'Premium access' : 'Free trial'} until ${new Date(expiry).toLocaleString()}.`,
  };
}

const userLinks = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/scanner', label: 'Live signals' },
  { href: '/scanner/history', label: 'Signal history' },
  { href: '/scanner/performance', label: 'Performance' },
  { href: '/positions', label: 'Open positions' },
  { href: '/news', label: 'Crypto news' },
  { href: '/settings', label: 'Account settings' },
  { href: '/binance', label: 'Exchange connection' },
];

const adminLinks = [
  { href: '/admin', label: 'Admin overview' },
  { href: '/admin#admin-news', label: 'News management' },
  { href: '/admin#admin-users', label: 'User management' },
  { href: '/admin#admin-signal-management', label: 'Signal monitoring' },
  { href: '/admin#system-diagnostics', label: 'System health' },
];

export function PanelNavigation() {
  const pathname = usePathname();
  const [user, setUser] = useState<PanelUser>(null);
  const [newsUnread, setNewsUnread] = useState(0);
  const [signalUnread, setSignalUnread] = useState(0);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [subscriptionUnavailable, setSubscriptionUnavailable] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isPanelPage = pathname.startsWith('/dashboard') ||
    pathname.startsWith('/scanner') ||
    pathname.startsWith('/signals') ||
    pathname.startsWith('/positions') ||
    pathname.startsWith('/news') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/binance') ||
    pathname.startsWith('/admin');

  useEffect(() => {
    if (!isPanelPage) return;
    let active = true;
    void fetch('/api/auth/me', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Account details are unavailable.');
        return response.json() as Promise<{ data?: PanelUser }>;
      })
      .then(async (body) => {
        if (!active) return;
        setUser(body.data ?? null);
        if (body.data) {
          try {
            const response = await fetch('/api/subscription', { cache: 'no-store' });
            const result = await response.json() as { data?: { subscription: Subscription }; error?: string };
            if (!response.ok || !result.data) throw new Error(result.error ?? 'Membership details are unavailable.');
            if (active) {
              setSubscription(result.data.subscription);
              setSubscriptionUnavailable(false);
            }
          } catch (error) {
            if (active) setSubscriptionUnavailable(true);
            console.error('Panel navigation membership lookup failed:', error);
          }
        }
      })
      .catch((error: unknown) => {
        console.error('Panel navigation account lookup failed:', error);
      });
    return () => { active = false; };
  }, [isPanelPage]);

  useEffect(() => {
    if (!isPanelPage || !user) return;
    let active = true;
    const refreshCounts = async () => {
      try {
        const unreadResponse = await fetch('/api/news/unread', { cache: 'no-store' });
        if (unreadResponse.ok) {
          const unread = await unreadResponse.json() as { data?: { unreadCount: number } };
          if (active && unread.data) setNewsUnread(unread.data.unreadCount);
        }
        if (subscription?.hasPremiumAccess) {
          const notificationResponse = await fetch('/api/notifications', { cache: 'no-store' });
          if (notificationResponse.ok) {
            const result = await notificationResponse.json() as { data?: { unreadCount: number } };
            if (active && result.data) setSignalUnread(result.data.unreadCount);
          }
        } else if (active) {
          setSignalUnread(0);
        }
      } catch (error) {
        console.error('Panel navigation notification count lookup failed:', error);
      }
    };
    void refreshCounts();
    const timer = window.setInterval(() => void refreshCounts(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isPanelPage, subscription, user]);

  useEffect(() => {
    const updateUnread = (event: Event) => {
      const count = (event as CustomEvent<number>).detail;
      if (Number.isInteger(count) && count >= 0) setNewsUnread(count);
    };
    window.addEventListener('news-unread-count', updateUnread);
    return () => window.removeEventListener('news-unread-count', updateUnread);
  }, []);

  if (!isPanelPage) return null;

  const links = [...userLinks, ...(user?.role === 'admin' ? adminLinks : [])];
  return <>
  <aside className="panel-navigation" aria-label="Application navigation">
    <div className="panel-navigation-brand">
      <Link href="/dashboard" aria-label="ETHcryptohub overview">ETH<span>CRYPTOHUB</span></Link>
      <button
        className="panel-menu-toggle"
        type="button"
        aria-expanded={menuOpen}
        aria-controls="panel-navigation-links"
        onClick={() => setMenuOpen((open) => !open)}
      >{menuOpen ? 'Close' : 'Menu'}</button>
    </div>
    <div className={`panel-navigation-content${menuOpen ? ' is-open' : ''}`}>
      <nav id="panel-navigation-links" aria-label="Main menu">
        {links.map(({ href, label }) => {
          const currentPath = href.split('#')[0];
          const active = pathname === currentPath ||
            (currentPath !== '/dashboard' && pathname.startsWith(`${currentPath}/`));
          return <Link key={href} href={href} aria-current={active ? 'page' : undefined} onClick={() => setMenuOpen(false)}>
            <span className="panel-navigation-indicator" aria-hidden="true" />
            {label}{href === '/news' && newsUnread > 0 && <span className="panel-navigation-badge">{newsUnread > 99 ? '99+' : newsUnread}</span>}
          </Link>;
        })}
      </nav>
    </div>
  </aside>
  <header className="panel-topbar" aria-label={user?.role === 'admin' ? 'Admin account menu' : 'User account menu'}>
    <span className="panel-topbar-role">{user?.role === 'admin' ? 'Admin portal' : 'User portal'}</span>
    <div className="panel-topbar-actions">
      {user && subscription && (() => {
        const badge = membershipLabel(subscription);
        return <Link className={`membership-badge ${badge.className}`} href="/dashboard#subscription" title={badge.title}>
          {badge.label}
        </Link>;
      })()}
      {user && subscriptionUnavailable && <span className="membership-badge is-unavailable">Membership unavailable</span>}
      <Link className="panel-topbar-notifications" href="/dashboard#notifications">
        Notifications{newsUnread + signalUnread > 0 && <span className="panel-navigation-badge">{newsUnread + signalUnread > 99 ? '99+' : newsUnread + signalUnread}</span>}
      </Link>
      {user && <span className="panel-topbar-user" title={user.email}>{user.email}</span>}
      {user && <div className="panel-topbar-logout"><LogoutButton /></div>}
    </div>
  </header>
  </>;
}
