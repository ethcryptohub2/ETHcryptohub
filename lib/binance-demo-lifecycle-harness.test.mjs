import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BINANCE_DEMO_ENDPOINT,
  BINANCE_DEMO_LIFECYCLE_CASES,
  REMOTE_APPROVAL_FLAG,
  REMOTE_CONFIRMATION,
  runBinanceDemoLifecycleHarness,
  sanitizeBinanceEvidence,
  validateRemoteDemoAuthorization,
} from './binance-demo-lifecycle-harness.mjs';

const envDisabled = {
  BINANCE_FUTURES_TRADING_ENABLED: 'false',
  BINANCE_FUTURES_DEMO_TRADING_ENABLED: 'false',
  BINANCE_FUTURES_DEMO_VERIFIED: 'false',
  BINANCE_FUTURES_LIVE_TRADING_APPROVED: 'false',
};

function mockedAdapter() {
  return {
    kind: 'mocked-unit',
    async executeCase(scenario) {
      return {
        actualState: scenario.expectedState,
        exchangeResponseVerified: true,
        databaseStateVerified: true,
        evidence: {
          symbol: scenario.symbol,
          direction: scenario.direction,
          status: 'VERIFIED',
          orderId: '12345',
          apiSecret: 'must-not-appear',
          signature: 'must-not-appear',
        },
      };
    },
  };
}

function remotePreflight(overrides = {}) {
  return {
    environment: 'DEMO',
    endpoint: BINANCE_DEMO_ENDPOINT,
    credentialSource: 'DEDICATED_BINANCE_DEMO',
    positionMode: 'ONE_WAY',
    customerExecutionEnabled: false,
    liveEndpointSelected: false,
    liveCredentialSelected: false,
    ...overrides,
  };
}

test('harness covers lifecycle behavior in both directions and reports all evidence fields', async () => {
  const report = await runBinanceDemoLifecycleHarness({
    mode: 'MOCKED_UNIT',
    adapter: mockedAdapter(),
    symbol: 'BTCUSDT',
  });
  assert.equal(report.status, 'PASS');
  assert.equal(report.results.length, BINANCE_DEMO_LIFECYCLE_CASES.length);
  assert.ok(report.results.some((item) => item.direction === 'LONG'));
  assert.ok(report.results.some((item) => item.direction === 'SHORT'));
  assert.ok(report.results.every((item) =>
    item.testType === 'MOCKED_UNIT' &&
    item.environment === 'MOCKED_UNIT' &&
    item.exchangeResponseVerification === 'VERIFIED' &&
    item.databaseStateVerification === 'VERIFIED' &&
    item.status === 'PASS',
  ));
  assert.equal(JSON.stringify(report).includes('must-not-appear'), false);
});

test('harness fails when exchange or database state is not verified', async () => {
  const adapter = {
    kind: 'mocked-unit',
    async executeCase(scenario) {
      return {
        actualState: scenario.expectedState,
        exchangeResponseVerified: false,
        databaseStateVerified: true,
      };
    },
  };
  const report = await runBinanceDemoLifecycleHarness({
    mode: 'MOCKED_UNIT', adapter, symbol: 'BTCUSDT',
  });
  assert.equal(report.status, 'FAIL');
  assert.ok(report.results.every((item) => item.status === 'FAIL'));
});

test('remote harness is blocked without separate authorization and explicit confirmation', async () => {
  const adapter = { kind: 'remote-binance-demo', async executeCase() { throw new Error('must not run'); } };
  const report = await runBinanceDemoLifecycleHarness({
    mode: 'REMOTE_BINANCE_DEMO',
    adapter,
    env: envDisabled,
    preflight: remotePreflight(),
    operatorConfirmation: REMOTE_CONFIRMATION,
    symbol: 'BTCUSDT',
  });
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.authorization, 'DENIED');
  assert.ok(report.results.every((item) => item.status === 'BLOCKED'));
});

test('remote harness cannot claim remote verification through a caller-supplied mock adapter', async () => {
  let called = false;
  const report = await runBinanceDemoLifecycleHarness({
    mode: 'REMOTE_BINANCE_DEMO',
    adapter: {
      kind: 'remote-binance-demo',
      async executeCase() {
        called = true;
        return {
          actualState: 'INITIAL_SL_ACTIVE',
          exchangeResponseVerified: true,
          databaseStateVerified: true,
        };
      },
    },
    env: { ...envDisabled, [REMOTE_APPROVAL_FLAG]: 'true' },
    preflight: remotePreflight(),
    operatorConfirmation: REMOTE_CONFIRMATION,
    symbol: 'BTCUSDT',
  });
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.authorization, 'PREREQUISITES_MET_ADAPTER_MISSING');
  assert.equal(called, false);
  assert.ok(report.results.every((item) => item.status === 'BLOCKED'));
});

test('remote approval requires Demo endpoint, dedicated credentials, One-way mode and customer lock', () => {
  const env = {
    ...envDisabled,
    [REMOTE_APPROVAL_FLAG]: 'true',
  };
  const adapter = { kind: 'remote-binance-demo' };
  const approved = validateRemoteDemoAuthorization({
    env,
    preflight: remotePreflight(),
    operatorConfirmation: REMOTE_CONFIRMATION,
    adapter,
  });
  assert.equal(approved.authorized, true);

  for (const invalid of [
    { environment: 'LIVE' },
    { endpoint: 'https://fapi.binance.com' },
    { credentialSource: 'LIVE' },
    { positionMode: 'HEDGE' },
    { customerExecutionEnabled: true },
    { liveEndpointSelected: true },
    { liveCredentialSelected: true },
  ]) {
    const result = validateRemoteDemoAuthorization({
      env,
      preflight: remotePreflight(invalid),
      operatorConfirmation: REMOTE_CONFIRMATION,
      adapter,
    });
    assert.equal(result.authorized, false);
  }
});

test('adapter failures produce a sanitized blocked result rather than disappearing', async () => {
  const report = await runBinanceDemoLifecycleHarness({
    mode: 'MOCKED_UNIT',
    symbol: 'BTCUSDT',
    adapter: {
      kind: 'mocked-unit',
      async executeCase() {
        throw new Error('request signature=private-value');
      },
    },
  });
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.results[0].reason, 'Lifecycle adapter failed (Error).');
  assert.equal(JSON.stringify(report).includes('private-value'), false);
});

test('remote harness requires every customer execution gate disabled', () => {
  const result = validateRemoteDemoAuthorization({
    env: {
      ...envDisabled,
      [REMOTE_APPROVAL_FLAG]: 'true',
      BINANCE_FUTURES_TRADING_ENABLED: 'true',
    },
    preflight: remotePreflight(),
    operatorConfirmation: REMOTE_CONFIRMATION,
    adapter: { kind: 'remote-binance-demo' },
  });
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((reason) => reason.includes('execution gates')));
});

test('evidence sanitizer allows audit identifiers but removes secret-shaped fields', () => {
  assert.deepEqual(sanitizeBinanceEvidence({
    algoId: '999',
    status: 'NEW',
    apiKey: 'secret',
    clientSecret: 'secret',
    signature: 'secret',
    password: 'secret',
    arbitrary: 'not allowlisted',
  }), {
    algoId: '999',
    status: 'NEW',
  });
});
