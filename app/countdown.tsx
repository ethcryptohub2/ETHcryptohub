'use client';

import { useEffect, useState } from 'react';
import { signalRemainingMs } from '../lib/signal-countdown';

function formatRemaining(milliseconds: number) {
  const seconds = Math.ceil(milliseconds / 1000);
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
    const startedAt = performance.now();
    const update = () => setRemaining(signalRemainingMs(expiresAt, serverNow, performance.now() - startedAt));
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
