'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { LogoutButton } from './logout-button';
import { ThemeToggle } from './theme-toggle';

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

type NavigationLink = { href: string; label: string; icon: string };

const SIDEBAR_CHANGE_EVENT = 'ethcryptohub-sidebar-change';
let sidebarPreference = false;

function subscribeToSidebar(listener: () => void) {
  window.addEventListener(SIDEBAR_CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(SIDEBAR_CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

function getSidebarSnapshot() {
  try {
    sidebarPreference = window.localStorage.getItem('ethcryptohub-sidebar') === 'collapsed';
  } catch (error) {
    console.error('Unable to read the saved sidebar preference:', error);
  }
  return sidebarPreference;
}

function subscribeToHash(listener: () => void) {
  window.addEventListener('hashchange', listener);
  window.addEventListener('popstate', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
    window.removeEventListener('popstate', listener);
  };
}

function getHashSnapshot() {
  return window.location.hash;
}

const userLinks: NavigationLink[] = [
  { href: '/dashboard', label: 'Overview', icon: 'overview' },
  { href: '/scanner', label: 'Live signals', icon: 'scanner' },
  { href: '/scanner/history', label: 'Signal history', icon: 'history' },
  { href: '/scanner/performance', label: 'Performance', icon: 'performance' },
  { href: '/positions', label: 'Open positions', icon: 'positions' },
  { href: '/news', label: 'Crypto news', icon: 'news' },
  { href: '/settings', label: 'Account settings', icon: 'settings' },
  { href: '/binance', label: 'Exchange connection', icon: 'exchange' },
];

const adminLinks: NavigationLink[] = [
  { href: '/admin', label: 'Admin overview', icon: 'overview' },
  { href: '/admin#scanner-management', label: 'Scanner management', icon: 'scanner' },
  { href: '/admin#admin-signal-management', label: 'Signal management', icon: 'activity' },
  { href: '/admin#admin-news', label: 'News management', icon: 'news' },
  { href: '/admin#admin-subscriptions', label: 'Subscriptions', icon: 'subscriptions' },
  { href: '/admin#admin-users', label: 'User management', icon: 'users' },
  { href: '/admin#system-diagnostics', label: 'System health', icon: 'system' },
];

function NavigationIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></>,
    scanner: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5M10.8 7v4l2.5 1.5" /></>,
    history: <><path d="M3 11a9 9 0 1 1 2.4 6.1L3 15.5" /><path d="M3 20v-4.5h4.5M12 7v5l3 2" /></>,
    performance: <><path d="M3 3v18h18M7 14l4-4 3 3 6-7" /><path d="M16 6h4v4" /></>,
    positions: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18m-11 0v2h4v-2" /></>,
    news: <><path d="M4 4h13a2 2 0 0 1 2 2v14H5a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1Z" /><path d="M7 8h8M7 12h8M7 16h5M19 18h2V8" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.7 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.7-1l-1.7.7-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.7-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.7 1l1.7-.7 1.4 2.4-1.4 1.1a7 7 0 0 1 0 2Z" /></>,
    exchange: <><path d="M7 7h13l-3-3m3 3-3 3M17 17H4l3 3m-3-3 3-3" /></>,
    activity: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
    subscriptions: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h4" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m6-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-7.5a4 4 0 0 1 0 7.8M20 21v-2a4 4 0 0 0-3-3.9" /></>,
    system: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4M7 9h4m-4 4h8m3-4h.01" /></>,
  };
  return <svg className="panel-navigation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.overview}</svg>;
}

export function PanelNavigation() {
  const pathname = usePathname();
  const [user, setUser] = useState<PanelUser>(null);
  const [newsUnread, setNewsUnread] = useState(0);
  const [signalUnread, setSignalUnread] = useState(0);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [subscriptionUnavailable, setSubscriptionUnavailable] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const sidebarCollapsed = useSyncExternalStore(
    subscribeToSidebar,
    getSidebarSnapshot,
    () => false,
  );
  const hash = useSyncExternalStore(subscribeToHash, getHashSnapshot, () => '');
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

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  if (!isPanelPage) return null;

  function toggleSidebar() {
    const collapsed = !sidebarCollapsed;
    sidebarPreference = collapsed;
    document.documentElement.style.setProperty('--sidebar-width', collapsed ? '76px' : '256px');
    try {
      window.localStorage.setItem('ethcryptohub-sidebar', collapsed ? 'collapsed' : 'expanded');
    } catch (error) {
      console.error('Unable to save the sidebar preference:', error);
    }
    window.dispatchEvent(new Event(SIDEBAR_CHANGE_EVENT));
  }

  const renderLinks = (links: NavigationLink[]) => links.map(({ href, label, icon }) => {
    const currentPath = href.split('#')[0];
    const targetHash = href.includes('#') ? `#${href.split('#')[1]}` : '';
    const active = targetHash
      ? pathname === currentPath && hash === targetHash
      : pathname === currentPath || (currentPath === '/scanner' && pathname.startsWith('/scanner/') &&
        !pathname.startsWith('/scanner/history') && !pathname.startsWith('/scanner/performance'));
    return <Link key={href} href={href} aria-current={active ? 'page' : undefined} onClick={() => setMenuOpen(false)} title={sidebarCollapsed ? label : undefined}>
      <NavigationIcon name={icon} />
      <span className="panel-navigation-label">{label}</span>
      {href === '/news' && newsUnread > 0 && <span className="panel-navigation-badge">{newsUnread > 99 ? '99+' : newsUnread}</span>}
    </Link>;
  });
  return <>
  {menuOpen && <button className="panel-navigation-backdrop" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
  <aside className={`panel-navigation${sidebarCollapsed ? ' is-collapsed' : ''}${menuOpen ? ' is-mobile-open' : ''}`} aria-label="Application navigation">
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
        <p className="panel-navigation-group-label">Workspace</p>
        {renderLinks(userLinks)}
        {user?.role === 'admin' && <>
          <p className="panel-navigation-group-label">Administration</p>
          {renderLinks(adminLinks)}
        </>}
      </nav>
      {user && <div className="panel-navigation-profile">
        <span className="panel-avatar" aria-hidden="true">{user.email.slice(0, 1).toUpperCase()}</span>
        <span className="panel-profile-text"><strong>{user.role === 'admin' ? 'Administrator' : 'Account'}</strong><small>{user.email}</small></span>
        <div className="panel-profile-logout"><LogoutButton /></div>
      </div>}
      <button className="panel-sidebar-collapse" type="button" onClick={toggleSidebar} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        <span aria-hidden="true">{sidebarCollapsed ? '›' : '‹'}</span><span className="panel-navigation-label">{sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}</span>
      </button>
    </div>
  </aside>
  <header className="panel-topbar" aria-label={user?.role === 'admin' ? 'Admin account menu' : 'User account menu'}>
    <button className="panel-mobile-toggle" type="button" aria-expanded={menuOpen} aria-controls="panel-navigation-links" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}>
      <span aria-hidden="true">☰</span>
    </button>
    <span className="panel-topbar-role">{user?.role === 'admin' ? 'Admin portal' : 'Workspace'}<strong>{pathname.startsWith('/admin') ? 'Administration' : pathname === '/news' ? 'Crypto news' : pathname.startsWith('/scanner') ? 'Market scanner' : pathname.startsWith('/positions') ? 'Open positions' : pathname.startsWith('/settings') ? 'Account settings' : pathname.startsWith('/binance') ? 'Exchange connection' : pathname.startsWith('/signals') ? 'Signal details' : 'Overview'}</strong></span>
    <div className="panel-topbar-actions">
      <ThemeToggle />
      {user && subscription && (() => {
        const badge = membershipLabel(subscription);
        return <Link className={`membership-badge ${badge.className}`} href="/dashboard#subscription" title={badge.title}>
          {badge.label}
        </Link>;
      })()}
      {user && subscriptionUnavailable && <span className="membership-badge is-unavailable">Membership unavailable</span>}
      <Link className="panel-topbar-notifications" href="/dashboard#notifications" onClick={() => setMenuOpen(false)}>
        Notifications{newsUnread + signalUnread > 0 && <span className="panel-navigation-badge">{newsUnread + signalUnread > 99 ? '99+' : newsUnread + signalUnread}</span>}
      </Link>
      {user && <span className="panel-topbar-user" title={user.email}>{user.email}</span>}
      {user && <div className="panel-topbar-logout"><LogoutButton /></div>}
    </div>
  </header>
  </>;
}
