import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'cron-auth.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);
const { isAuthorizedCronRequest } = sourceModule.exports;

test('CRON auth accepts only the configured Bearer token', () => {
  assert.equal(isAuthorizedCronRequest('Bearer expected-secret', 'expected-secret'), true);
  assert.equal(isAuthorizedCronRequest('expected-secret', 'expected-secret'), false);
  assert.equal(isAuthorizedCronRequest('Bearer wrong-secret', 'expected-secret'), false);
  assert.equal(isAuthorizedCronRequest(null, 'expected-secret'), false);
  assert.equal(isAuthorizedCronRequest('Bearer expected-secret', undefined), false);
});
