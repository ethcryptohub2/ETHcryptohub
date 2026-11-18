import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'admin-demo-staging-policy.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);
const { isApprovedAdminDemoStagingTarget, isAdminDemoExecutionRequestApproved } = sourceModule.exports;

const staging = {
  VERCEL_ENV: 'preview',
  SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: 'stage-ref',
  SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF: 'prod-ref',
  NEXT_PUBLIC_SUPABASE_URL: 'https://stage-ref.supabase.co',
  SUPABASE_DB_URL: 'postgresql://postgres.stage-ref:password@pooler.example:6543/postgres',
};

test('allows only a preview whose public and server DB targets match approved staging', () => {
  assert.equal(isApprovedAdminDemoStagingTarget(staging), true);
});

test('rejects unknown, production, mismatched and local targets', () => {
  for (const env of [
    { ...staging, VERCEL_ENV: 'production' },
    { ...staging, VERCEL_ENV: 'production', SMARTEXIT_DEPLOYMENT_ENV: 'staging' },
    { ...staging, VERCEL_ENV: ' Production ', SMARTEXIT_DEPLOYMENT_ENV: 'staging' },
    { ...staging, NEXT_PUBLIC_SUPABASE_URL: 'https://prod-ref.supabase.co' },
    { ...staging, SUPABASE_DB_URL: 'postgresql://postgres.prod-ref@pooler.example:6543/postgres' },
    { ...staging, SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: '' },
    { ...staging, SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF: 'stage-ref' },
    { ...staging, VERCEL_ENV: undefined, SMARTEXIT_DEPLOYMENT_ENV: 'local' },
  ]) {
    assert.equal(isApprovedAdminDemoStagingTarget(env), false);
  }
});

test('Preview release keeps remote execution disabled even with valid target and explicit confirmation', () => {
  const confirmation = 'RUN_BINANCE_DEMO_LIFECYCLE';
  assert.equal(isAdminDemoExecutionRequestApproved(staging, confirmation), false);
  assert.equal(
    isAdminDemoExecutionRequestApproved({
      ...staging,
      BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED: 'false',
      BINANCE_FUTURES_DEMO_TRADING_ENABLED: 'false',
    }, confirmation),
    false,
  );
  for (const env of [
    { ...staging, BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED: 'true' },
    { ...staging, BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED: 'yes' },
    { ...staging, BINANCE_FUTURES_DEMO_TRADING_ENABLED: 'true' },
    { ...staging, BINANCE_FUTURES_TRADING_ENABLED: 'enabled' },
    { ...staging, BINANCE_FUTURES_LIVE_TRADING_APPROVED: 'TRUE ' },
    { ...staging, NEXT_PUBLIC_SUPABASE_URL: 'https://prod-ref.supabase.co' },
  ]) {
    assert.equal(isAdminDemoExecutionRequestApproved(env, confirmation), false);
  }
  assert.equal(isAdminDemoExecutionRequestApproved(staging, 'wrong confirmation'), false);
});
