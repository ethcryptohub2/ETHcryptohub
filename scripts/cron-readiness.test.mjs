import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectCronReadiness } from './cron-readiness.mjs';

const staged = {
  VERCEL_ENV: 'preview',
  SMARTEXIT_CRON_RECONCILIATION_ENABLED: 'true',
  SMARTEXIT_CRON_TARGET_ENVIRONMENT: 'staging',
  SMARTEXIT_CRON_BASE_URL: 'https://staging-preview.example.vercel.app',
  SMARTEXIT_STAGING_PREVIEW_URL: 'https://staging-preview.example.vercel.app/',
  SMARTEXIT_PRODUCTION_APP_URL: 'https://app.example.com',
  CRON_SECRET: 'x'.repeat(32),
};

test('reconciliation CRON defaults to disabled and does not require a target', () => {
  const report = inspectCronReadiness({ CRON_SECRET: 'x'.repeat(32) });
  assert.equal(report.status, 'DISABLED');
  assert.equal(report.enabled, false);
  assert.equal(report.targetVerified, false);
});

test('enabled CRON is ready only for the exact approved Staging Preview origin', () => {
  const report = inspectCronReadiness(staged);
  assert.equal(report.status, 'READY');
  assert.equal(report.enabled, true);
  assert.equal(report.targetVerified, true);
  assert.equal(JSON.stringify(report).includes(staged.CRON_SECRET), false);
});

test('CRON blocks Production, non-staging, malformed, and unapproved targets', () => {
  const cases = [
    { ...staged, VERCEL_ENV: 'production' },
    { ...staged, VERCEL_ENV: 'production', SMARTEXIT_DEPLOYMENT_ENV: 'staging' },
    { ...staged, SMARTEXIT_CRON_TARGET_ENVIRONMENT: 'production' },
    { ...staged, SMARTEXIT_PRODUCTION_APP_URL: '' },
    { ...staged, SMARTEXIT_CRON_BASE_URL: 'https://other.example.vercel.app' },
    { ...staged, SMARTEXIT_CRON_BASE_URL: 'http://staging-preview.example.vercel.app' },
    { ...staged, SMARTEXIT_CRON_BASE_URL: 'https://staging-preview.example.vercel.app/api/cron' },
    { ...staged, SMARTEXIT_CRON_BASE_URL: 'https://user:pass@staging-preview.example.vercel.app' },
    { ...staged, SMARTEXIT_CRON_BASE_URL: staged.SMARTEXIT_PRODUCTION_APP_URL },
    {
      ...staged,
      SMARTEXIT_CRON_BASE_URL: staged.SMARTEXIT_PRODUCTION_APP_URL,
      SMARTEXIT_STAGING_PREVIEW_URL: staged.SMARTEXIT_PRODUCTION_APP_URL,
    },
  ];
  for (const env of cases) {
    const report = inspectCronReadiness(env);
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.enabled, false);
  }
});

test('CRON requires a strong authorization secret without exposing it', () => {
  const report = inspectCronReadiness({ ...staged, CRON_SECRET: 'short' });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.errors.some((error) => error.includes('CRON_SECRET')));
  assert.equal(JSON.stringify(report).includes('short'), false);
});

test('invalid enablement flag is surfaced as invalid instead of treated as enabled', () => {
  const report = inspectCronReadiness({ SMARTEXIT_CRON_RECONCILIATION_ENABLED: 'yes' });
  assert.equal(report.status, 'INVALID');
  assert.equal(report.enabled, false);
});
