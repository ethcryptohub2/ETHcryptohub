import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'strategy-routing.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);
const { strategyForSignal, assertSignalStrategy, assertStrategyDestination } = sourceModule.exports;

test('maps each scanner identity to exactly one execution strategy', () => {
  assert.equal(strategyForSignal('STANDARD'), 'STANDARD');
  assert.equal(strategyForSignal('HIGH_RISK'), 'HIGH_RISK_SCALPING');
});

test('rejects routing a High-Risk signal through Standard settings', () => {
  assert.throws(
    () => assertSignalStrategy('HIGH_RISK', 'STANDARD'),
    /must route to HIGH_RISK_SCALPING/,
  );
});

test('rejects a signal destination that differs from its strategy profile', () => {
  assert.throws(
    () => assertStrategyDestination({ exchange: 'BINANCE', environment: 'DEMO' }, 'BINANCE', 'LIVE'),
    /does not match the strategy profile/,
  );
});
