import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin-demo-provider-contract.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
sourceModule._compile(compiled.outputText, sourcePath);
const {
  ADMIN_DEMO_PROVIDER_ENVIRONMENTS,
  DISABLED_ADMIN_DEMO_CAPABILITIES,
  assertAdminDemoProviderEnvironment,
  isAdminDemoProvider,
  isAdminDemoProviderEnvironment,
} = sourceModule.exports;

test('Admin Demo provider environments are fixed and keep Gate Testnet distinct', () => {
  assert.deepEqual(ADMIN_DEMO_PROVIDER_ENVIRONMENTS, {
    BINANCE: 'DEMO',
    BYBIT: 'DEMO',
    OKX: 'DEMO',
    BITGET: 'DEMO',
    GATE: 'TESTNET',
  });
  assert.equal(isAdminDemoProvider('OKX'), true);
  assert.equal(isAdminDemoProvider('UNKNOWN'), false);
  assert.equal(isAdminDemoProviderEnvironment('GATE', 'DEMO'), false);
  assert.equal(isAdminDemoProviderEnvironment('GATE', 'TESTNET'), true);
  assert.throws(() => assertAdminDemoProviderEnvironment('GATE', 'DEMO'));
  assert.throws(() => assertAdminDemoProviderEnvironment('BYBIT', 'LIVE'));
});

test('Admin Demo provider capabilities fail closed by default', () => {
  assert.ok(Object.values(DISABLED_ADMIN_DEMO_CAPABILITIES).every((capability) => capability === false));
});
