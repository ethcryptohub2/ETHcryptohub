import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'binance-execution-policy.ts');
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
const { getFullPositionTakeProfit } = sourceModule.exports;

test('full-position conditional close uses TP3 rather than TP1 or TP2', () => {
  assert.equal(getFullPositionTakeProfit({ tp1: '101', tp2: '102', tp3: '103' }), '103');
  assert.equal(getFullPositionTakeProfit({ tp1: '99', tp2: '98', tp3: '97' }), '97');
});

test('refuses a full-position close target when TP3 is absent or invalid', () => {
  assert.throws(() => getFullPositionTakeProfit({ tp1: '101', tp2: '102', tp3: null }), /valid TP3/);
  assert.throws(() => getFullPositionTakeProfit({ tp1: '101', tp2: '102', tp3: '0' }), /valid TP3/);
});
