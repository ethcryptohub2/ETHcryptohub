'use client';

import { useEffect } from 'react';

export type RefreshMinutes = 1 | 2 | 5;

export function SavedResultsRefresh({ minutes, onChange }: {
  minutes: RefreshMinutes;
  onChange: (minutes: RefreshMinutes) => void;
}) {
  return <label>Refresh saved results<select value={minutes} onChange={event => {
    const value = Number(event.target.value);
    if (value === 1 || value === 2 || value === 5) onChange(value);
  }}>
    <option value={1}>Every minute</option>
    <option value={2}>Every 2 minutes</option>
    <option value={5}>Every 5 minutes</option>
  </select></label>;
}

export function useSavedResultsPolling(load: () => Promise<void>, minutes: RefreshMinutes) {
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = window.setInterval(refreshWhenVisible, minutes * 60_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [load, minutes]);
}
