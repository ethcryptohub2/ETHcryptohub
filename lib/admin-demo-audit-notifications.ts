import { ADMIN_DEMO_PROVIDER_ENVIRONMENTS, type AdminDemoProvider } from './admin-demo-provider-contract';

export type DemoAuditNotice = { id: string; label: string; createdAt: string; critical: boolean };

export function projectDemoAuditNotices(provider: AdminDemoProvider, events: readonly unknown[]): DemoAuditNotice[] {
  const notices = new Map<string, DemoAuditNotice>();
  for (const value of events.slice(0, 50)) {
    if (!value || typeof value !== 'object') continue;
    const event = value as Record<string, unknown>;
    const details = event.safeDetails as Record<string, unknown> | null | undefined;
    const { id, createdAt } = event;
    if (event.provider !== provider || event.environment !== ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider] ||
        typeof id !== 'string' || !/^\d{1,20}$/.test(id) || typeof createdAt !== 'string' ||
        !Number.isFinite(Date.parse(createdAt)) || notices.has(id)) continue;

    let label: string | undefined;
    if (event.eventType === 'PROTECTION_VERIFIED' && event.eventStatus === 'SUCCEEDED' &&
        (details?.executionStatus === 'PROTECTED' || details?.lifecycleEvent === 'PROTECTION_VERIFIED')) {
      label = 'Demo protection verified';
    }
    if (event.eventType === 'POSITION_CLOSED' && event.eventStatus === 'SUCCEEDED' &&
        (details?.executionStatus === 'CLOSED' || details?.lifecycleEvent === 'EXECUTION_CLOSED')) {
      label = 'Demo position closed';
    }
    if (event.eventType === 'RECONCILIATION_REQUIRED' && event.eventStatus === 'UNCERTAIN') {
      label = 'Demo reconciliation required';
    }
    if (event.eventType === 'TEST_FAILED' && event.eventStatus === 'FAILED' && details?.executionStatus === 'FAILED') {
      label = 'Demo execution failed';
    }
    if (label) notices.set(id, { id, label, createdAt, critical: event.eventStatus !== 'SUCCEEDED' });
  }
  return [...notices.values()];
}
