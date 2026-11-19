export interface IntelligenceActor { id: number; role: 'admin' | 'user' }
export interface SnapshotHealth {
  enabledSymbols: number;
  snapshotSymbols: number;
  latestSnapshotAt: string | null;
}

export function buildIntelligenceStatus(actor: IntelligenceActor, health: SnapshotHealth | null, now = Date.now()) {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || !['user', 'admin'].includes(actor.role)) {
    throw new Error('Authenticated account required.');
  }
  const time = Date.parse(health?.latestSnapshotAt ?? '');
  const validTime = Number.isFinite(time) && time <= now;
  return {
    account: { id: actor.id, mode: 'OBSERVE' as const },
    market: {
      source: 'Saved Binance USD-M research snapshots',
      state: 'WORKER_INACTIVE' as const,
      enabledSymbols: health?.enabledSymbols ?? 0,
      snapshotSymbols: health?.snapshotSymbols ?? 0,
      latestSnapshotAt: validTime ? new Date(time).toISOString() : null,
      ageSeconds: validTime ? Math.floor((now - time) / 1000) : null,
      databaseAvailable: health !== null,
      continuousFeedVerified: false,
    },
    research: { candidates: [], attribution: 'Exchange order flow is not verified wallet activity.' },
    paper: {
      enabled: false, modes: ['OBSERVE', 'CONFIRM', 'PAPER_AUTOPILOT'],
      currentMode: 'OBSERVE', liveAutopilotEnabled: false,
      reason: 'Paper execution and saved customer settings await approved durable storage and worker activation.',
    },
    safeguards: { exchangeOrdersEnabled: false, cronEnabled: false, remotePaperEnabled: false },
    ...(actor.role === 'admin' ? { operations: {
      workerActivationApproved: false, subscriptions: 'NOT_STARTED',
      globalExecutionLocked: true, feedSequenceVerified: false,
      auditStatus: 'Local replay journals implemented; no remote execution journal activated.',
    } } : {}),
  };
}
