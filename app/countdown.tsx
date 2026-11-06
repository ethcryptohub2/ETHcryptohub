'use client';

import { useEffect, useState } from 'react';

function getRemaining(expiresAt: string, serverNow: string) {
  const expiry = Date.parse(expiresAt);
  const serverTimestamp = Date.parse(serverNow);
  if (!Number.isFinite(expiry) || !Number.isFinite(serverTimestamp)) return 0;
  const serverOffset = serverTimestamp - Date.now();
  return Math.max(0, expiry - (Date.now() + serverOffset));
}

function formatRemaining(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(remainder).padStart(2, '0')}s`;
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
}

export function SignalCountdown({
  expiresAt,
  serverNow,
  status,
}: {
  expiresAt: string;
  serverNow: string;
  status: string;
}) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setRemaining(getRemaining(expiresAt, serverNow));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, serverNow]);

  if (status === 'ENTRY_INVALIDATED') {
    return <span className="signal-countdown is-expired">ENTRY MISSED</span>;
  }
  if (status === 'EXPIRED' || remaining === 0) {
    return <span className="signal-countdown is-expired">EXPIRED</span>;
  }
  if (remaining === null) return <span className="signal-countdown" aria-label="Calculating signal expiry">—</span>;
  const urgent = remaining <= 60_000;
  return (
    <span className={`signal-countdown${urgent ? ' is-urgent' : ''}`} aria-label={`Signal expires in ${formatRemaining(remaining)}`}>
      {formatRemaining(remaining)}
    </span>
  );
}
