import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'api', 'admin', 'scanner-management', 'route.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
});
const routeModule = new Module(sourcePath);
routeModule.filename = sourcePath;
routeModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
const calls = [];
const originalLoad = Module._load;
class MockAuthError extends Error {}

try {
  Module._load = function load(request, parent, isMain) {
    if (request.endsWith('/lib/auth')) {
      return {
        AuthError: MockAuthError,
        async requireAdmin() { return { id: 9, role: 'admin' }; },
      };
    }
    if (request.endsWith('/lib/http')) return { validCsrf: () => true };
    if (request.endsWith('/lib/signal-scan')) {
      return {
        SignalScanError: class SignalScanError extends Error {},
        async runSignalScan(...args) {
          calls.push(args);
          return { candidates: 1 };
        },
      };
    }
    if (request.endsWith('/lib/scanner-coins')) {
      return {
        async changeScannerCoins() { return {}; },
        async consumeScannerAdminRateLimit() {},
        async getScannerAuditLog() { return { entries: [], total: 0, page: 1 }; },
        async getScannerCoinUniverse() { return []; },
        async getScannerSyncState() { return null; },
        async syncBinanceScannerUniverse() { return {}; },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  routeModule._compile(compiled.outputText, sourcePath);
} finally {
  Module._load = originalLoad;
}

test('Admin scan-now requests skip automatic trade processing', async () => {
  calls.length = 0;
  const response = await routeModule.exports.POST({
    async json() { return { action: 'scan_now' }; },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [['15m', { executeAutomaticTrades: false }]]);
});
