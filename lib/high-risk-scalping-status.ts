export function formatSignalStatusText(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return 'UNKNOWN';
  return String(value).replace(/_/g, ' ');
}

const openLifecycleStatuses = new Set(['ACTIVE', 'TP1_HIT', 'TP2_HIT']);

export function highRiskEntryWindowOpen(signal: {
  lifecycleStatus: string;
  generatedAt: string;
  entryExpiresAt: string;
  expiresAt: string;
}, now: number) {
  const generatedAt = new Date(signal.generatedAt).getTime();
  return openLifecycleStatuses.has(signal.lifecycleStatus) && generatedAt > 0 && generatedAt <= now &&
    now < Math.min(new Date(signal.entryExpiresAt).getTime(), new Date(signal.expiresAt).getTime());
}
