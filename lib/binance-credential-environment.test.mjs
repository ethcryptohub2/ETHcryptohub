import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const sourcePath = path.resolve('lib/binance-futures.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

function loadBinanceModule({ query, decryptCalls }) {
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
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === sourcePath) {
      if (request === './binance-credentials') {
        return {
          decryptCredential(value) {
            decryptCalls.count += 1;
            return value.replace(/^encrypted:/, '');
          },
        };
      }
      if (request === './db') return { query };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    sourceModule._compile(compiled.outputText, sourcePath);
  } finally {
    Module._load = originalLoad;
  }
  return sourceModule.exports;
}

test('Binance adapter rejects unconfirmed credentials before decryption or network use', async () => {
  const decryptCalls = { count: 0 };
  const query = async () => ({
    rows: [{
      api_key_ciphertext: 'opaque-ciphertext',
      api_secret_ciphertext: 'opaque-ciphertext',
      environment_confirmed: false,
    }],
  });
  const binance = loadBinanceModule({ query, decryptCalls });

  await assert.rejects(
    binance.createBinanceEnvironmentAdapter(7, 'DEMO'),
    /Re-enter the Demo Binance credentials/,
  );
  assert.equal(decryptCalls.count, 0);
});

test('confirmed Binance Demo credentials select only the fixed Demo endpoint', async () => {
  const decryptCalls = { count: 0 };
  const query = async () => ({
    rows: [{
      api_key_ciphertext: 'encrypted:demo-key',
      api_secret_ciphertext: 'encrypted:demo-secret',
      environment_confirmed: true,
    }],
  });
  const binance = loadBinanceModule({ query, decryptCalls });
  const adapter = await binance.createBinanceEnvironmentAdapter(7, 'DEMO');

  assert.equal(adapter.baseUrl, 'https://demo-fapi.binance.com');
  assert.equal(decryptCalls.count, 2);
});
