export type UiPreviewFlagStatus = 'disabled' | 'enabled' | 'invalid';
export type UiPreviewRequestDecision = 'next' | 'reject' | 'unavailable';

export const UI_PREVIEW_PROJECT_ID: string;
export const UI_PREVIEW_UNAVAILABLE_PATH: string;
export function getUiPreviewFlagStatus(env?: Record<string, string | undefined>): UiPreviewFlagStatus;
export function isUiPreviewRequested(env?: Record<string, string | undefined>): boolean;
export function assertDatabaseAccessAllowed(env?: Record<string, string | undefined>): void;
export function inspectUiPreviewEnvironment(env?: Record<string, string | undefined>): {
  valid: boolean;
  errors: string[];
  checks: Record<string, boolean>;
};
export function decideUiPreviewRequest(
  env: Record<string, string | undefined>,
  pathname: string,
  method: string,
): UiPreviewRequestDecision;
