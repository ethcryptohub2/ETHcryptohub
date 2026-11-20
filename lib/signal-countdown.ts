export function signalRemainingMs(expiresAt: string, serverNow: string, elapsedMs: number): number {
  const expiry = Date.parse(expiresAt);
  const reference = Date.parse(serverNow);
  if (!Number.isFinite(expiry) || !Number.isFinite(reference) || !Number.isFinite(elapsedMs)) return 0;
  return Math.max(0, expiry - reference - Math.max(0, elapsedMs));
}
