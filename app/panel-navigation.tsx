'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LogoutButton } from './logout-button';

type PanelUser = { role: 'user' | 'admin'; email: string } | null;

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
      .then((body) => {
        if (!active) return;
        setUser(body.data ?? null);
        if (body.data) {
          void fetch('/api/news/unread', { cache: 'no-store' })
            .then((response) => response.ok ? response.json() as Promise<{ data?: { unreadCount: number } }> : null)
            .then((unread) => {
              if (active && unread?.data) setNewsUnread(unread.data.unreadCount);
            })
            .catch((error: unknown) => console.error('Panel navigation news count lookup failed:', error));
        }
      })
      .catch((error: unknown) => {
        console.error('Panel navigation account lookup failed:', error);
      });
    return () => { active = false; };
  }, [isPanelPage]);

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
  return <aside className="panel-navigation" aria-label="Application navigation">
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
      {user && <p className="panel-navigation-account" title={user.email}>{user.email}</p>}
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
      {user && <div className="panel-navigation-logout"><LogoutButton /></div>}
    </div>
  </aside>;
}
