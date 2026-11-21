import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateDeploymentEnvironment, verifyBinanceEndpointSource } from './deployment-environment.mjs';

const demoSource = `
const environmentUrls: Record<TradingEnvironment, string> = {
  DEMO: 'https://demo-fapi.binance.com',
  LIVE: 'https://fapi.binance.com',
};
if (!isTradingEnvironment(environment)) throw new Error('invalid');
const baseUrl = environmentUrls[environment];
`;
const stagingKey = '1'.repeat(64);
const productionKeyFingerprint = 'a'.repeat(64);
const validPreview = {
  VERCEL_ENV: 'preview',
  SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: 'stage-ref',
  SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF: 'prod-ref',
  SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256: productionKeyFingerprint,
  NEXT_PUBLIC_SUPABASE_URL: 'https://stage-ref.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-placeholder',
  AUTH_SECRET: 'a'.repeat(32),
  BINANCE_CREDENTIALS_KEY: stagingKey,
  CRON_SECRET: 'c'.repeat(32),
  SUPABASE_DB_URL: 'postgresql://postgres.stage-ref:placeholder@aws-0-test.pooler.supabase.com:6543/postgres',
  BINANCE_FUTURES_TRADING_ENABLED: 'false',
  BINANCE_FUTURES_DEMO_TRADING_ENABLED: 'false',
  BINANCE_FUTURES_DEMO_VERIFIED: 'false',
  BINANCE_FUTURES_LIVE_TRADING_APPROVED: 'false',
};

test('local classification does not require deployment-only variables', () => {
  const report = validateDeploymentEnvironment({}, '');
  assert.equal(report.valid, true);
  assert.equal(report.classification, 'local');
});

test('valid Preview requires project isolation, staging key fingerprint, and disabled gates', () => {
  const report = validateDeploymentEnvironment(validPreview, demoSource);
  assert.equal(report.valid, true, report.errors.join('\n'));
  assert.ok(!report.errors.some((error) => error.includes('SUPABASE_JWT_SECRET')));
  assert.equal(report.checks.databaseProjectMatches, true);
  assert.equal(report.checks.productionAndStagingDiffer, true);
  assert.equal(report.checks.encryptionKeyIsStagingSpecific, true);
  assert.equal(report.checks.executionGatesDisabled, true);
  assert.equal(report.checks.demoEndpointPinnedWithoutFallback, true);
});

test('Preview fails closed on unknown or Production database identity', () => {
  const unknown = validateDeploymentEnvironment({
    ...validPreview,
    SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: '',
    SUPABASE_DB_URL: 'postgresql://postgres.prod-ref:placeholder@aws-0-test.pooler.supabase.com:6543/postgres',
  }, demoSource);
  assert.equal(unknown.valid, false);
  assert.ok(unknown.errors.some((error) => error.includes('SMARTEXIT_STAGING_SUPABASE_PROJECT_REF')));
  assert.ok(unknown.errors.some((error) => error.includes('database target')));
});

test('Preview rejects enabled Bybit Demo order submission', () => {
  const report = validateDeploymentEnvironment({
    ...validPreview,
    SMARTEXIT_BYBIT_DEMO_ORDER_SUBMISSION_ENABLED: 'true',
  }, demoSource);
  assert.equal(report.valid, false);
  assert.equal(report.checks.executionGatesDisabled, false);
  assert.ok(report.errors.some((error) =>
    error.includes('SMARTEXIT_BYBIT_DEMO_ORDER_SUBMISSION_ENABLED')));
});

test('Preview rejects opt-in Demo services and public provider traffic for this release', () => {
  for (const gate of [
    'SMARTEXIT_ADMIN_DEMO_REMOTE_SERVICE_ENABLED',
    'SMARTEXIT_ADMIN_BINANCE_DEMO_LAB_ENABLED',
    'SMARTEXIT_ADMIN_BYBIT_DEMO_LAB_ENABLED',
    'SMARTEXIT_ADMIN_SCANNER_REFRESH_ENABLED',
    'SMARTEXIT_BINANCE_CREDENTIAL_STORAGE_ENABLED',
    'SMARTEXIT_BINANCE_CREDENTIAL_TESTS_ENABLED',
    'SMARTEXIT_BINANCE_BALANCE_READ_ENABLED',
    'SMARTEXIT_PUBLIC_REST_SNAPSHOT_ENABLED',
  ]) {
    const report = validateDeploymentEnvironment({ ...validPreview, [gate]: 'true' }, demoSource);
    assert.equal(report.valid, false);
    assert.ok(report.errors.includes(`Staging remote service gates must remain unset or false: ${gate}.`));
  }
});

test('Preview fails closed on Production key reuse and enabled trading gates', () => {
  const reusedKey = '2'.repeat(64);
  const reusedFingerprint = createHash('sha256').update(Buffer.from(reusedKey, 'hex')).digest('hex');
  const report = validateDeploymentEnvironment({
    ...validPreview,
    BINANCE_CREDENTIALS_KEY: reusedKey,
    SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256: reusedFingerprint,
    BINANCE_FUTURES_TRADING_ENABLED: 'true',
  }, demoSource);
  assert.equal(report.valid, false);
  assert.equal(report.checks.executionGatesDisabled, false);
  assert.ok(report.errors.some((error) => error.includes('credential-encryption key')));
  assert.ok(report.errors.some((error) => error.includes('Trading gates')));
});

test('deployment build rejects a persistent remote-test authorization flag', () => {
  const report = validateDeploymentEnvironment({
    ...validPreview,
    BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED: 'true',
  }, demoSource);
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.includes('Remote Demo test authorization')));
});

test('Preview environment report shows CRON disabled until its staging target is approved', () => {
  const report = validateDeploymentEnvironment(validPreview, demoSource);
  assert.equal(report.valid, true);
  assert.equal(report.checks.cronAuthorizationConfigured, true);
  assert.equal(report.checks.cronReconciliationStatus, 'DISABLED');
  assert.equal(report.checks.cronTargetVerified, false);
});

test('Demo endpoint must be fixed and selected only after environment validation', () => {
  assert.equal(verifyBinanceEndpointSource(demoSource).valid, true);
  assert.equal(
    verifyBinanceEndpointSource(demoSource.replace('https://demo-fapi.binance.com', 'https://fapi.binance.com')).valid,
    false,
  );
  assert.equal(
    verifyBinanceEndpointSource(demoSource.replace('environmentUrls[environment]', 'environmentUrls[environment] ?? environmentUrls.LIVE')).valid,
    false,
  );
});

test('deployment errors never contain configured secret values', () => {
  const secret = 'secret-value-that-must-not-be-printed';
  const report = validateDeploymentEnvironment({
    ...validPreview,
    AUTH_SECRET: secret,
    BINANCE_FUTURES_TRADING_ENABLED: 'true',
  }, demoSource);
  assert.ok(!JSON.stringify(report).includes(secret));
});
