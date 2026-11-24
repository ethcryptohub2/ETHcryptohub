import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./launch-windows-public-preflight.ps1', import.meta.url));
const windowsNode24 = process.platform === 'win32' && Number(process.versions.node.split('.')[0]) >= 24;

function invokeLauncher(args) {
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', launcher, '-NodePath', process.execPath, ...args,
  ], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      BINANCE_API_KEY: 'offline-credential-fixture',
      SUPABASE_SERVICE_ROLE_KEY: 'offline-credential-fixture',
      SMTP_PASSWORD: 'offline-credential-fixture',
      HTTPS_PROXY: 'http://localhost:1',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NODE_OPTIONS: '--require=offline-missing-module-that-must-never-load',
    },
  });
}

test('Windows launcher verifies the real isolated child environment without loading injected credentials or Node options', {
  skip: !windowsNode24,
}, () => {
  const result = invokeLauncher(['-VerifyOnly']);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `Verified isolated Node.js ${process.versions.node} environment`);
  assert.equal(result.stderr, '');
});

test('Windows launcher refuses execution without both approvals and prevents combining verification with execution', {
  skip: !windowsNode24,
}, () => {
  const refused = invokeLauncher([]);
  assert.ifError(refused.error);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /SEPARATE_FINITE_PREFLIGHT_APPROVAL_REQUIRED/);
  const conflict = invokeLauncher(['-VerifyOnly', '-ExecuteApprovedPublicOnly']);
  assert.ifError(conflict.error);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /VERIFY_ONLY_CANNOT_EXECUTE_PREFLIGHT/);
});
