import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'bitget-demo.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);
const {
  BITGET_DEMO_CAPABILITIES,
  BITGET_DEMO_REST_URL,
  BITGET_DEMO_UNSUPPORTED_CAPABILITIES,
  BITGET_DEMO_DOCUMENTATION_URL,
  BitgetDemoError,
  createBitgetDemoAdapter,
  signBitgetDemoRequest,
} = sourceModule.exports;

const credentials = {
  apiKey: 'bitget-demo-key',
  apiSecret: 'bitget-demo-secret',
  passphrase: 'bitget-demo-passphrase',
};

test('Bitget signature matches the documented HMAC-SHA256 Base64 scheme', () => {
  const timestamp = '1684814440729';
  const path = '/api/v3/account/fee-rate';
  const query = 'category=SPOT&symbol=BTCUSDT';
  const expected = crypto.createHmac('sha256', credentials.apiSecret)
    .update(`${timestamp}GET${path}?${query}`)
    .digest('base64');

  assert.equal(signBitgetDemoRequest(credentials.apiSecret, timestamp, 'GET', path, query), expected);
  assert.equal(BITGET_DEMO_REST_URL, 'https://api.bitget.com');
  assert.equal(BITGET_DEMO_DOCUMENTATION_URL, 'https://www.bitget.com/docs/uta/quick-start.md');
});

test('Bitget remains entirely unsupported until official futures Demo endpoint requirements are verified', () => {
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    throw new Error('Bitget test must not make network requests.');
  };
  try {
    assert.ok(BITGET_DEMO_UNSUPPORTED_CAPABILITIES.includes('connectionTest'));
    assert.ok(Object.values(BITGET_DEMO_CAPABILITIES).every((enabled) => !enabled));
    for (const environment of ['DEMO', 'TESTNET', 'LIVE']) {
      assert.throws(
        () => createBitgetDemoAdapter(environment),
        (error) => error instanceof BitgetDemoError && /No requests are enabled/.test(error.message),
      );
    }
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
