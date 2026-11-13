import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectUiPreviewEnvironment,
  UI_PREVIEW_PROJECT_ID,
} from '../lib/ui-preview-mode.mjs';
import {
  validateUiPreviewEnvironment,
  verifyUiPreviewSafetyWiring,
} from './ui-preview-environment.mjs';
import { validateConfiguredDeploymentEnvironment } from './deployment-environment.mjs';

const validEnvironment = {
  SMARTEXIT_UI_PREVIEW_ONLY: 'true',
  SMARTEXIT_UI_PREVIEW_BRANCH: 'fix/smart-exit-preview',
  VERCEL_ENV: 'preview',
  VERCEL_PROJECT_ID: UI_PREVIEW_PROJECT_ID,
  VERCEL_GIT_COMMIT_REF: 'fix/smart-exit-preview',
  VERCEL_GIT_REPO_DEFAULT_BRANCH: 'main',
  VERCEL_URL: 'cryptohub-preview-123.vercel.app',
  VERCEL_PROJECT_PRODUCTION_URL: 'cryptohub.vercel.app',
};

const validSources = {
  policy: `normalizedPath === '/api'; normalizedPath.startsWith('/api/'); return 'unavailable';`,
  proxy: 'decideUiPreviewRequest; status: 503; NextResponse.rewrite; UI_PREVIEW_UNAVAILABLE_PATH;',
  database: 'assertDatabaseAccessAllowed(process.env); assertDatabaseAccessEnabled();',
  authentication: 'export async function requireUser() {} export async function requireAdmin() {}',
  publicHome: 'isUiPreviewRequested(process.env); Unavailable in UI Preview;',
  unavailablePage: 'Unavailable in UI Preview; notFound();',
};

test('UI Preview accepts an explicitly selected, isolated Preview branch without database secrets', () => {
  const report = validateUiPreviewEnvironment(validEnvironment, validSources);
  assert.equal(report.valid, true, report.errors.join('\n'));
  assert.equal(report.mode, 'ui-preview');
  assert.equal(report.checks.correctVercelProject, true);
  assert.equal(report.checks.selectedPreviewBranch, true);
  assert.equal(report.checks.databaseWritesDisabled, true);
  assert.equal(report.checks.noAuthenticationBypass, true);
  assert.equal(report.checks.noCrossEnvironmentFallback, true);
  assert.equal('SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256' in validEnvironment, false);
});

test('UI Preview rejects Production, wrong project or branch, pull requests, and unsafe gates', () => {
  const unsafeEnvironments = [
    { ...validEnvironment, VERCEL_ENV: 'production' },
    { ...validEnvironment, VERCEL_PROJECT_ID: 'wrong-project' },
    { ...validEnvironment, VERCEL_GIT_COMMIT_REF: 'another-branch' },
    { ...validEnvironment, VERCEL_GIT_PULL_REQUEST_ID: '42' },
    { ...validEnvironment, BINANCE_FUTURES_TRADING_ENABLED: 'true' },
    { ...validEnvironment, BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED: 'true' },
    { ...validEnvironment, SMARTEXIT_CRON_RECONCILIATION_ENABLED: 'true' },
    { ...validEnvironment, DATABASE_URL: 'postgresql://not-a-real-credential' },
    { ...validEnvironment, NEXT_PUBLIC_SUPABASE_URL: 'https://production.supabase.co' },
    { ...validEnvironment, BINANCE_API_SECRET: 'do-not-echo-this-value' },
    { ...validEnvironment, VERCEL_URL: 'cryptohub.vercel.app' },
  ];

  for (const env of unsafeEnvironments) {
    assert.equal(inspectUiPreviewEnvironment(env).valid, false);
    assert.equal(validateUiPreviewEnvironment(env, validSources).valid, false);
  }
});

test('UI Preview rejects missing selection, malformed flags, and unsafe source wiring', () => {
  assert.equal(inspectUiPreviewEnvironment({
    ...validEnvironment,
    SMARTEXIT_UI_PREVIEW_BRANCH: '',
  }).valid, false);
  assert.equal(inspectUiPreviewEnvironment({
    ...validEnvironment,
    SMARTEXIT_UI_PREVIEW_ONLY: 'yes',
  }).valid, false);
  assert.equal(verifyUiPreviewSafetyWiring({
    ...validSources,
    proxy: '',
  }).apiRequestsBlocked, false);

  const malformedMode = validateConfiguredDeploymentEnvironment({
    ...validEnvironment,
    SMARTEXIT_UI_PREVIEW_ONLY: 'yes',
  });
  assert.equal(malformedMode.valid, false);
  assert.equal(malformedMode.mode, 'invalid');
});

test('full deployment validation remains the default when UI Preview mode is not enabled', () => {
  const report = validateConfiguredDeploymentEnvironment({});
  assert.equal(report.valid, true);
  assert.equal(report.mode, 'full');
  assert.equal(report.classification, 'local');
});
