export const BINANCE_DEMO_ENDPOINT = 'https://demo-fapi.binance.com';
export const REMOTE_APPROVAL_FLAG = 'BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED';
export const REMOTE_CONFIRMATION = 'RUN_BINANCE_DEMO_LIFECYCLE';
const REMOTE_LIFECYCLE_ADAPTER_AVAILABLE = false;

const customerTradingGates = [
  'BINANCE_FUTURES_TRADING_ENABLED',
  'BINANCE_FUTURES_DEMO_TRADING_ENABLED',
  'BINANCE_FUTURES_DEMO_VERIFIED',
  'BINANCE_FUTURES_LIVE_TRADING_APPROVED',
];

const evidenceKeys = new Set([
  'algoId', 'clientAlgoId', 'orderId', 'clientOrderId', 'status', 'orderType',
  'side', 'positionSide', 'triggerPrice', 'activatePrice', 'callbackRate',
  'quantity', 'reduceOnly', 'closePosition', 'positionAmount', 'symbol',
  'direction', 'environment', 'lockAcquired', 'cancelledOrderIds',
  'reconcileAttempt', 'apiErrorCode', 'protectionStatus',
]);

export const BINANCE_DEMO_LIFECYCLE_CASES = [
  { id: 'initial-sl-long', testName: 'Initial Stop Loss protection', direction: 'LONG', expectedState: 'INITIAL_SL_ACTIVE' },
  { id: 'tp3-conditional-long', testName: 'TP3 conditional close order', direction: 'LONG', expectedState: 'TP3_CLOSE_ALL_ACTIVE' },
  { id: 'dormant-trailing-long', testName: 'Dormant trailing protection', direction: 'LONG', expectedState: 'TRAILING_DORMANT' },
  { id: 'tp1-long', testName: 'TP1 activates trailing without exit', direction: 'LONG', expectedState: 'TP1_TRAILING_ACTIVE_FULL_POSITION' },
  { id: 'tp1-short', testName: 'TP1 activates trailing without exit', direction: 'SHORT', expectedState: 'TP1_TRAILING_ACTIVE_FULL_POSITION' },
  { id: 'tp2-long', testName: 'TP2 continues protection without loosening', direction: 'LONG', expectedState: 'TP2_TRAILING_UNCHANGED_OR_TIGHTER' },
  { id: 'tp2-short', testName: 'TP2 continues protection without loosening', direction: 'SHORT', expectedState: 'TP2_TRAILING_UNCHANGED_OR_TIGHTER' },
  { id: 'tp3-close-long', testName: 'TP3 closes full remaining position', direction: 'LONG', expectedState: 'TP3_POSITION_CLOSED' },
  { id: 'tp3-close-short', testName: 'TP3 closes full remaining position', direction: 'SHORT', expectedState: 'TP3_POSITION_CLOSED' },
  { id: 'zero-position', testName: 'Zero position confirmation', direction: 'LONG', expectedState: 'ZERO_POSITION_CONFIRMED' },
  { id: 'protection-cleanup', testName: 'Protective-order cleanup after flat', direction: 'LONG', expectedState: 'OBSOLETE_PROTECTION_ABSENT' },
  { id: 'restart-recovery', testName: 'Restart and reconciliation recovery', direction: 'LONG', expectedState: 'RESTART_RECONCILED_NO_DUPLICATE' },
  { id: 'timeout-recovery', testName: 'API timeout recovery', direction: 'SHORT', expectedState: 'TIMEOUT_RECONCILED_NO_DUPLICATE' },
  { id: 'duplicate-event', testName: 'Duplicate event idempotency', direction: 'LONG', expectedState: 'DUPLICATE_EVENT_IDEMPOTENT' },
  { id: 'emergency-stop', testName: 'Emergency Stop safety', direction: 'LONG', expectedState: 'ENTRY_BLOCKED_PROTECTION_RETAINED' },
];

function isDisabled(value) {
  return value === undefined || value === null || value === '' || String(value).toLowerCase() === 'false';
}

export function sanitizeBinanceEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const safe = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!evidenceKeys.has(key) || /secret|key|token|cipher|password|signature/i.test(key)) continue;
    if (typeof entry === 'string') safe[key] = entry.slice(0, 128);
    else if (typeof entry === 'number' && Number.isFinite(entry)) safe[key] = entry;
    else if (typeof entry === 'boolean' || entry === null) safe[key] = entry;
    else if (Array.isArray(entry) && key === 'cancelledOrderIds') {
      safe[key] = entry.filter((item) => typeof item === 'string').slice(0, 20).map((item) => item.slice(0, 128));
    }
  }
  return safe;
}

export function validateRemoteDemoAuthorization({ env, preflight, operatorConfirmation, adapter }) {
  const reasons = [];
  if (env?.[REMOTE_APPROVAL_FLAG] !== 'true') reasons.push('Separate remote Demo authorization flag is not enabled.');
  if (operatorConfirmation !== REMOTE_CONFIRMATION) reasons.push('Explicit remote Demo operator confirmation is missing.');
  if (!customerTradingGates.every((name) => isDisabled(env?.[name]))) {
    reasons.push('Customer trading execution gates must remain disabled.');
  }
  if (preflight?.environment !== 'DEMO') reasons.push('Preflight did not confirm the DEMO environment.');
  if (preflight?.endpoint !== BINANCE_DEMO_ENDPOINT) reasons.push('Preflight did not confirm the fixed Binance Demo endpoint.');
  if (preflight?.credentialSource !== 'DEDICATED_BINANCE_DEMO') {
    reasons.push('Preflight did not confirm a dedicated Binance Demo credential.');
  }
  if (preflight?.positionMode !== 'ONE_WAY') reasons.push('Preflight did not confirm One-way position mode.');
  if (preflight?.customerExecutionEnabled !== false) reasons.push('Customer execution must be explicitly confirmed disabled.');
  if (preflight?.liveEndpointSelected !== false) reasons.push('A Live endpoint was selected or not explicitly ruled out.');
  if (preflight?.liveCredentialSelected !== false) reasons.push('A Live credential was selected or not explicitly ruled out.');
  if (adapter?.kind !== 'remote-binance-demo') reasons.push('A dedicated remote Demo adapter is not configured.');
  return { authorized: reasons.length === 0, reasons };
}

function blockedResults({ mode, symbol, reason }) {
  return BINANCE_DEMO_LIFECYCLE_CASES.map((scenario) => ({
    testName: scenario.testName,
    testId: scenario.id,
    testType: mode,
    environment: mode === 'REMOTE_BINANCE_DEMO' ? 'DEMO' : mode,
    symbol,
    direction: scenario.direction,
    expectedState: scenario.expectedState,
    actualState: 'NOT_RUN',
    exchangeResponseVerification: 'NOT_VERIFIED',
    databaseStateVerification: 'NOT_VERIFIED',
    status: 'BLOCKED',
    sanitizedEvidence: {},
    reason,
  }));
}

function safeErrorCategory(error) {
  const name = error instanceof Error ? error.name : 'UnknownError';
  return /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name) ? name : 'AdapterError';
}

export async function runBinanceDemoLifecycleHarness({
  mode,
  adapter,
  env = {},
  preflight,
  operatorConfirmation,
  symbol,
}) {
  if (!['MOCKED_UNIT', 'LOCAL_INTEGRATION', 'REMOTE_BINANCE_DEMO'].includes(mode)) {
    throw new Error('Unsupported Binance lifecycle test mode.');
  }
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,30}$/.test(symbol)) {
    throw new Error('A valid uppercase Binance symbol is required.');
  }

  if (mode === 'REMOTE_BINANCE_DEMO') {
    const authorization = validateRemoteDemoAuthorization({ env, preflight, operatorConfirmation, adapter });
    if (!authorization.authorized) {
      return {
        testType: mode,
        environment: 'DEMO',
        symbol,
        status: 'BLOCKED',
        authorization: 'DENIED',
        results: blockedResults({ mode, symbol, reason: authorization.reasons.join(' ') }),
      };
    }
    if (!REMOTE_LIFECYCLE_ADAPTER_AVAILABLE) {
      return {
        testType: mode,
        environment: 'DEMO',
        symbol,
        status: 'BLOCKED',
        authorization: 'PREREQUISITES_MET_ADAPTER_MISSING',
        results: blockedResults({
          mode,
          symbol,
          reason: 'No trusted adapter is integrated with the SmartExit execution and reconciliation lifecycle.',
        }),
      };
    }
  } else if (
    (mode === 'MOCKED_UNIT' && adapter?.kind !== 'mocked-unit') ||
    (mode === 'LOCAL_INTEGRATION' && adapter?.kind !== 'local-integration')
  ) {
    return {
      testType: mode,
      environment: mode,
      symbol,
      status: 'BLOCKED',
      authorization: 'NOT_REQUIRED',
      results: blockedResults({ mode, symbol, reason: 'A controlled mocked-unit adapter is required.' }),
    };
  }

  if (typeof adapter?.executeCase !== 'function') {
    return {
      testType: mode,
      environment: mode === 'REMOTE_BINANCE_DEMO' ? 'DEMO' : mode,
      symbol,
      status: 'BLOCKED',
      authorization: mode === 'REMOTE_BINANCE_DEMO' ? 'APPROVED' : 'NOT_REQUIRED',
      results: blockedResults({ mode, symbol, reason: 'Lifecycle case adapter is not implemented.' }),
    };
  }

  const results = [];
  for (const scenario of BINANCE_DEMO_LIFECYCLE_CASES) {
    let response;
    let failureReason;
    try {
      response = await adapter.executeCase({ ...scenario, symbol, environment: mode === 'REMOTE_BINANCE_DEMO' ? 'DEMO' : mode });
    } catch (error) {
      response = null;
      failureReason = `Lifecycle adapter failed (${safeErrorCategory(error)}).`;
    }
    const actualState = typeof response?.actualState === 'string' &&
      /^[A-Z0-9_]{1,64}$/.test(response.actualState)
      ? response.actualState
      : 'UNRECOGNIZED';
    const exchangeVerified = response?.exchangeResponseVerified === true;
    const databaseVerified = response?.databaseStateVerified === true;
    const passed = actualState === scenario.expectedState && exchangeVerified && databaseVerified;
    results.push({
      testName: scenario.testName,
      testId: scenario.id,
      testType: mode,
      environment: mode === 'REMOTE_BINANCE_DEMO' ? 'DEMO' : mode,
      symbol,
      direction: scenario.direction,
      expectedState: scenario.expectedState,
      actualState,
      exchangeResponseVerification: exchangeVerified ? 'VERIFIED' : 'NOT_VERIFIED',
      databaseStateVerification: databaseVerified ? 'VERIFIED' : 'NOT_VERIFIED',
      status: passed ? 'PASS' : response ? 'FAIL' : 'BLOCKED',
      sanitizedEvidence: sanitizeBinanceEvidence(response?.evidence),
      ...(response ? {} : { reason: failureReason ?? 'Lifecycle adapter did not return a verifiable result.' }),
    });
  }
  return {
    testType: mode,
    environment: mode === 'REMOTE_BINANCE_DEMO' ? 'DEMO' : mode,
    symbol,
    status: results.every((result) => result.status === 'PASS')
      ? 'PASS'
      : results.some((result) => result.status === 'FAIL')
        ? 'FAIL'
        : 'BLOCKED',
    authorization: mode === 'REMOTE_BINANCE_DEMO' ? 'APPROVED' : 'NOT_REQUIRED',
    results,
  };
}
