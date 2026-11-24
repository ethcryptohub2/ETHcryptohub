'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';

interface BreadcrumbItem {
  label: string;
  href?: string;
}

function subscribeToLocation(listener: () => void) {
  window.addEventListener('popstate', listener);
  window.addEventListener('hashchange', listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener('hashchange', listener);
  };
}

function getSearchSnapshot() {
  return window.location.search;
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const search = useSyncExternalStore(subscribeToLocation, getSearchSnapshot, () => '');
  const searchParams = new URLSearchParams(search);
  const tab = searchParams.get('tab');

  const items: BreadcrumbItem[] = [{ label: 'SmartExit', href: '/dashboard' }];

  if (pathname.startsWith('/admin')) {
    items.push({ label: 'Administration', href: '/admin' });
    if (pathname === '/admin/exchanges') {
      items.push({ label: 'Exchange Control' });
    } else if (pathname === '/admin/exchanges/testing') {
      items.push({ label: 'Exchange Control', href: '/admin/exchanges' });
      items.push({ label: 'Demo Testing Lab' });
    } else if (pathname === '/admin/intelligence') {
      items.push({ label: 'Feed & Exchange Readiness' });
    } else if (pathname === '/admin/backtesting') {
      items.push({ label: 'Backtesting' });
    } else {
      items.push({ label: 'Command Center' });
    }
  } else if (pathname.startsWith('/scanner')) {
    items.push({ label: 'Market Intelligence', href: '/scanner' });
    if (pathname === '/scanner/history') {
      items.push({ label: 'Signal History' });
    } else if (pathname === '/scanner/performance') {
      items.push({ label: 'Performance Analytics' });
    } else if (pathname === '/scanner/successful') {
      items.push({ label: 'Successful Signals' });
    } else if (tab === 'scalping') {
      items.push({ label: 'High-Risk Scalping' });
    } else if (tab === 'alpha') {
      items.push({ label: 'Alpha Intelligence' });
    } else {
      items.push({ label: 'Live Signals' });
    }
  } else if (pathname.startsWith('/signals/')) {
    items.push({ label: 'Market Intelligence', href: '/scanner' });
    items.push({ label: 'Signal Details' });
  } else if (pathname.startsWith('/intelligence')) {
    items.push({ label: 'Market Intelligence', href: '/scanner' });
    items.push({ label: 'Research Workspace' });
  } else if (pathname.startsWith('/news')) {
    items.push({ label: 'Market Intelligence', href: '/scanner' });
    items.push({ label: 'Crypto News' });
  } else if (pathname.startsWith('/positions')) {
    items.push({ label: 'Trading & Execution', href: '/dashboard' });
    items.push({ label: 'Open Positions' });
  } else if (pathname.startsWith('/binance')) {
    items.push({ label: 'Trading & Execution', href: '/dashboard' });
    items.push({ label: 'Exchange Connections' });
  } else if (pathname.startsWith('/settings')) {
    items.push({ label: 'Account', href: '/settings' });
    items.push({ label: 'Account Settings' });
  } else {
    items.push({ label: 'Overview' });
  }

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb navigation">
      <ol className="breadcrumbs-list">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={index} className={`breadcrumbs-item ${isLast ? 'is-current' : ''}`} aria-current={isLast ? 'page' : undefined}>
              {index > 0 && <span className="breadcrumbs-separator" aria-hidden="true">/</span>}
              {!isLast && item.href ? (
                <Link href={item.href} className="breadcrumbs-link">
                  {item.label}
                </Link>
              ) : (
                <span className="breadcrumbs-text">{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
