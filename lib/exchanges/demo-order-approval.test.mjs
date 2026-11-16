import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'demo-order-approval.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);

const {
  isBybitDemoOrderSubmissionEnabled,
  requiresBybitDemoOrderSubmission,
} = sourceModule.exports;

test('Bybit Demo order submission requires the exact explicit enabled flag', () => {
  assert.equal(isBybitDemoOrderSubmissionEnabled({}), false);
  assert.equal(isBybitDemoOrderSubmissionEnabled({
    SMARTEXIT_BYBIT_DEMO_ORDER_SUBMISSION_ENABLED: 'false',
  }), false);
  assert.equal(isBybitDemoOrderSubmissionEnabled({
    SMARTEXIT_BYBIT_DEMO_ORDER_SUBMISSION_ENABLED: 'TRUE',
  }), false);
  assert.equal(isBybitDemoOrderSubmissionEnabled({
    SMARTEXIT_BYBIT_DEMO_ORDER_SUBMISSION_ENABLED: 'true',
  }), true);
});

test('all Bybit Demo exchange-mutating actions require separate approval', () => {
  for (const action of ['marketOrder', 'limitOrder', 'cancel', 'protection', 'close', 'leverage']) {
    assert.equal(requiresBybitDemoOrderSubmission(action), true, action);
  }
  for (const action of ['balance', 'positions', 'orders', 'history', 'executions', 'closedPnl', 'reconcile']) {
    assert.equal(requiresBybitDemoOrderSubmission(action), false, action);
  }
});
