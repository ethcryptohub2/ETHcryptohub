import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'binance-futures.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
const originalLoad = Module._load;
let exports;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === './binance-credentials') return { decryptCredential() { throw new Error('Unexpected credential access.'); } };
    if (request === './db') return { query() { throw new Error('Unexpected database access.'); } };
    return originalLoad.call(this, request, parent, isMain);
  };
  sourceModule._compile(compiled.outputText, sourcePath);
  exports = sourceModule.exports;
} finally {
  Module._load = originalLoad;
}

test('Binance Demo client uses its injected offline transport and fixed Demo host', async () => {
  const calls = [];
  const client = exports.createFixedBinanceDemoClient(
    { apiKey: 'offline-demo-key', apiSecret: 'offline-demo-secret' },
    async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return Response.json({ ok: true });
    },
  );

  const result = await client.request('GET', '/fapi/v3/account', { recvWindow: '5000' });
  assert.deepEqual(result, { ok: true });
  assert.equal(client.baseUrl, 'https://demo-fapi.binance.com');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://demo-fapi.binance.com');
  assert.equal(calls[0].init.headers['X-MBX-APIKEY'], 'offline-demo-key');

  const parameters = new URLSearchParams(calls[0].url.search);
  const signature = parameters.get('signature');
  parameters.delete('signature');
  const expected = crypto.createHmac('sha256', 'offline-demo-secret')
    .update(parameters.toString())
    .digest('hex');
  assert.equal(signature, expected);
});
