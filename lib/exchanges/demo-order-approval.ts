export const BYBIT_DEMO_ORDER_SUBMISSION_FLAG = 'SMARTEXIT_BYBIT_DEMO_ORDER_SUBMISSION_ENABLED';

const BYBIT_DEMO_ORDER_ACTIONS = new Set([
  'marketOrder',
  'limitOrder',
  'cancel',
  'protection',
  'close',
  'leverage',
]);

export function isBybitDemoOrderSubmissionEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  return env[BYBIT_DEMO_ORDER_SUBMISSION_FLAG] === 'true';
}

export function requiresBybitDemoOrderSubmission(action: string) {
  return BYBIT_DEMO_ORDER_ACTIONS.has(action);
}
