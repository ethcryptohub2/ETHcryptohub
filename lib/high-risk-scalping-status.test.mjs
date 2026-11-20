import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'high-risk-scalping-status.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);
const { formatSignalStatusText, highRiskEntryWindowOpen } = sourceModule.exports;

test('formats High-Risk lifecycle statuses consistently', () => {
  assert.equal(formatSignalStatusText('TP1_HIT'), 'TP1 HIT');
  assert.equal(formatSignalStatusText('ENTRY_INVALIDATED'), 'ENTRY INVALIDATED');
  assert.equal(formatSignalStatusText('STOP_LOSS_HIT'), 'STOP LOSS HIT');
  assert.equal(formatSignalStatusText(null), 'UNKNOWN');
  assert.equal(formatSignalStatusText(undefined), 'UNKNOWN');
  assert.equal(formatSignalStatusText(''), 'UNKNOWN');
});

test('High-Risk entry closes at either expiry even while its recorded lifecycle is active', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  const signal = {
    lifecycleStatus: 'ACTIVE',
    generatedAt: new Date(now - 1000).toISOString(),
    entryExpiresAt: new Date(now + 1000).toISOString(),
    expiresAt: new Date(now + 5000).toISOString(),
  };
  assert.equal(highRiskEntryWindowOpen(signal, now + 999), true);
  assert.equal(highRiskEntryWindowOpen(signal, now + 1000), false);
  assert.equal(highRiskEntryWindowOpen({ ...signal, expiresAt: new Date(now).toISOString() }, now), false);
  assert.equal(highRiskEntryWindowOpen({ ...signal, entryExpiresAt: 'invalid' }, now), false);
  assert.equal(highRiskEntryWindowOpen({ ...signal, generatedAt: new Date(now + 1).toISOString() }, now), false);
  assert.equal(highRiskEntryWindowOpen({ ...signal, lifecycleStatus: 'STOP_LOSS_HIT' }, now), false);
});
