'use client';

import { useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';
const THEME_CHANGE_EVENT = 'ethcryptohub-theme-change';

function getThemeSnapshot(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function subscribeToTheme(listener: () => void) {
  const handleStorage = () => {
    try {
      document.documentElement.dataset.theme =
        window.localStorage.getItem('ethcryptohub-theme') === 'dark' ? 'dark' : 'light';
    } catch (error) {
      console.error('Unable to read the saved theme preference:', error);
    }
    listener();
  };
  window.addEventListener(THEME_CHANGE_EVENT, listener);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, listener);
    window.removeEventListener('storage', handleStorage);
  };
}

function themeIcon(theme: Theme) {
  return theme === 'light'
    ? <path d="M12 3v2m0 14v2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42M3 12h2m14 0h2M5.64 18.36l1.42-1.42m9.88-9.88 1.42-1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
    : <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" />;
}

export function ThemeToggle() {
  const theme = useSyncExternalStore<Theme>(subscribeToTheme, getThemeSnapshot, () => 'light');

  function toggleTheme() {
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = nextTheme;
    try {
      window.localStorage.setItem('ethcryptohub-theme', nextTheme);
    } catch (error) {
      console.error('Unable to save the theme preference:', error);
    }
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }

  return <button
    type="button"
    className="theme-toggle"
    onClick={toggleTheme}
    aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
    title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">{themeIcon(theme)}</svg>
    <span>{theme === 'light' ? 'Light' : 'Dark'}</span>
  </button>;
}
