import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'registry.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
sourceModule._compile(compiled.outputText, sourcePath);
const { EXCHANGE_REGISTRY } = sourceModule.exports;

test('OKX, Bitget, and Gate.io remain disabled placeholders without verified capabilities', () => {
  for (const exchange of ['OKX', 'BITGET', 'GATE']) {
    const definition = EXCHANGE_REGISTRY[exchange];
    assert.equal(definition.customerTradingReady, false);
    assert.equal(Object.values(definition.capabilities).some(Boolean), false);
  }
});

test('Binance and Bybit have distinct implemented adapter readiness', () => {
  assert.equal(EXCHANGE_REGISTRY.BINANCE.capabilities.connectionTest, true);
  assert.equal(EXCHANGE_REGISTRY.BINANCE.customerTradingReady, true);
  assert.equal(EXCHANGE_REGISTRY.BYBIT.capabilities.connectionTest, true);
  assert.equal(EXCHANGE_REGISTRY.BYBIT.customerTradingReady, false);
});
