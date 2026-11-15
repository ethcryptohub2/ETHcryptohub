import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectStagingReadiness } from './staging-readiness.mjs';

test('reports the current owner confirmations without claiming backup verification', () => {
  const report = inspectStagingReadiness({}, {
    stagingDataSanitized: true,
    stagingBackupPitr: true,
  });
  assert.deepEqual(report.statuses, {
    STAGING_SUPABASE_REFERENCE: 'MISSING',
    PRODUCTION_SUPABASE_REFERENCE: 'MISSING',
    VERCEL_PREVIEW_URL: 'MISSING',
    VERCEL_DEPLOYMENT_ENVIRONMENT: 'MISSING_OR_NOT_PREVIEW',
    STAGING_PUBLIC_DATABASE_TARGET: 'MISSING',
    STAGING_SERVER_DATABASE_TARGET: 'MISSING',
    SUPABASE_REALTIME_PUBLIC_KEY: 'MISSING',
    AUTH_SECRET: 'MISSING',
    AUTH_SECRET_SEPARATION: 'OWNER_CONFIRMATION_REQUIRED',
    VERIFICATION_EMAIL: 'MISSING',
    STAGING_DATA_SANITIZATION: 'OWNER_CONFIRMED',
    STAGING_BACKUP_PITR: 'OWNER_CONFIRMED_NOT_INDEPENDENTLY_VERIFIED',
    ENCRYPTION_KEY_SEPARATION: 'NOT_VERIFIED',
    MIGRATION_STATUS: 'UNKNOWN',
    REMOTE_DEMO_STATUS: 'BLOCKED',
    CRON_STATUS: 'DISABLED',
    CUSTOMER_TRADING_GATES: 'DISABLED',
  });
  assert.equal(report.readyForStagingReview, false);
});

test('requires isolated project targets, Preview origin, Auth configuration, and distinct key fingerprints', () => {
  const report = inspectStagingReadiness({
    SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: 'stage-ref',
    SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF: 'prod-ref',
    SMARTEXIT_STAGING_PREVIEW_URL: 'https://staging.example.vercel.app/',
    SMARTEXIT_PRODUCTION_APP_URL: 'https://production.example.vercel.app',
    SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256: 'a'.repeat(64),
    SMARTEXIT_STAGING_BINANCE_CREDENTIALS_KEY_SHA256: 'b'.repeat(64),
    VERCEL_ENV: 'preview',
    NEXT_PUBLIC_SUPABASE_URL: 'https://stage-ref.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-staging-key',
    AUTH_SECRET: 's'.repeat(40),
    RESEND_API_KEY: 'test-only',
    MAIL_FROM: 'test@example.test',
    SUPABASE_DB_URL: 'postgresql://postgres.stage-ref:placeholder@pooler.supabase.com:6543/postgres',
    BINANCE_FUTURES_TRADING_ENABLED: 'false',
  }, {
    stagingDataSanitized: true,
    stagingBackupPitr: true,
    authSecretSeparate: true,
  });
  assert.equal(report.readyForStagingReview, true);
  assert.equal(report.statuses.ENCRYPTION_KEY_SEPARATION, 'DISTINCT');
  assert.equal(report.statuses.STAGING_SERVER_DATABASE_TARGET, 'MATCH');
  assert.equal(report.statuses.SUPABASE_REALTIME_PUBLIC_KEY, 'PRESENT');
  assert.equal(report.statuses.AUTH_SECRET, 'PRESENT');
  assert.equal(report.statuses.AUTH_SECRET_SEPARATION, 'OWNER_CONFIRMED_NOT_INDEPENDENTLY_VERIFIED');
  assert.equal(report.statuses.VERIFICATION_EMAIL, 'CONFIGURED');
});

test('blocks shared identity, shared key, malformed Preview URLs, and secret-like URL credentials', () => {
  const sharedRef = inspectStagingReadiness({
    SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: 'same-ref',
    SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF: 'same-ref',
  });
  assert.equal(sharedRef.statuses.STAGING_SUPABASE_REFERENCE, 'CONFLICT');

  const sharedKey = inspectStagingReadiness({
    SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256: 'c'.repeat(64),
    SMARTEXIT_STAGING_BINANCE_CREDENTIALS_KEY_SHA256: 'c'.repeat(64),
    SMARTEXIT_STAGING_PREVIEW_URL: 'https://user:password@preview.example.vercel.app',
    VERCEL_ENV: 'preview',
  });
  assert.equal(sharedKey.statuses.ENCRYPTION_KEY_SEPARATION, 'SHARED_KEY');
  assert.equal(sharedKey.statuses.VERCEL_PREVIEW_URL, 'MISSING');
  assert.equal(JSON.stringify(sharedKey).includes('password'), false);
});

test('rejects a staging fingerprint that does not match the configured staging encryption key', () => {
  const report = inspectStagingReadiness({
    BINANCE_CREDENTIALS_KEY: '1'.repeat(64),
    SMARTEXIT_STAGING_BINANCE_CREDENTIALS_KEY_SHA256: '2'.repeat(64),
    SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256: '3'.repeat(64),
  });
  assert.equal(report.statuses.ENCRYPTION_KEY_SEPARATION, 'FINGERPRINT_MISMATCH');
});

test('does not report staging-ready when project targets mismatch or trading gates are enabled', () => {
  const report = inspectStagingReadiness({
    SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: 'stage-ref',
    SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF: 'prod-ref',
    SMARTEXIT_STAGING_PREVIEW_URL: 'https://preview.example.vercel.app',
    SMARTEXIT_PRODUCTION_APP_URL: 'https://production.example.vercel.app',
    SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256: 'a'.repeat(64),
    SMARTEXIT_STAGING_BINANCE_CREDENTIALS_KEY_SHA256: 'b'.repeat(64),
    VERCEL_ENV: 'preview',
    NEXT_PUBLIC_SUPABASE_URL: 'https://prod-ref.supabase.co',
    SUPABASE_DB_URL: 'postgresql://postgres.prod-ref:placeholder@pooler.supabase.com:6543/postgres',
    BINANCE_FUTURES_TRADING_ENABLED: 'true',
  }, {
    stagingDataSanitized: true,
    stagingBackupPitr: true,
  });
  assert.equal(report.statuses.STAGING_PUBLIC_DATABASE_TARGET, 'MISMATCH');
  assert.equal(report.statuses.STAGING_SERVER_DATABASE_TARGET, 'MISMATCH');
  assert.equal(report.statuses.CUSTOMER_TRADING_GATES, 'UNEXPECTEDLY_ENABLED');
  assert.equal(report.readyForStagingReview, false);
});
