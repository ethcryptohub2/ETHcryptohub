import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const sourcePath = path.resolve('lib/exchanges/credentials.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

function loadCredentialModule({ query, decryptCalls }) {
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
      if (request === '../binance-credentials') {
        return {
          encryptCredential() { return 'opaque-ciphertext'; },
          decryptCredential(value) {
            decryptCalls.count += 1;
            return value.replace(/^encrypted:/, '');
          },
        };
      }
      if (request === '../db') return { query };
      if (request === './registry') {
        return { getExchangeDefinition: () => ({ name: 'Binance', requiredCredentialFields: [] }) };
      }
      if (request === './schema') return { assertExchangeFoundationReady: async () => {} };
      if (request === './types') {
        return {
          isExchangeEnvironment: (exchange, environment) =>
            exchange === 'BINANCE' && ['DEMO', 'LIVE'].includes(environment),
          isExchangeId: (exchange) => exchange === 'BINANCE',
        };
      }
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

test('legacy exchange credentials are reported for re-entry and are not decrypted', async () => {
  const decryptCalls = { count: 0 };
  const query = async (sql) => ({
    rows: sql.includes('SELECT api_key_suffix')
      ? [{
          api_key_suffix: '1234',
          last_verified_at: null,
          updated_at: '2026-01-01T00:00:00Z',
          environment_confirmed: false,
        }]
      : [{
          api_key_ciphertext: 'opaque-ciphertext',
          api_secret_ciphertext: 'opaque-ciphertext',
          passphrase_ciphertext: null,
          environment_confirmed: false,
        }],
  });
  const credentials = loadCredentialModule({ query, decryptCalls });

  const status = await credentials.getExchangeCredentialStatus(7, 'BINANCE', 'DEMO');
  assert.equal(status.configured, false);
  assert.equal(status.environmentConfirmationRequired, true);
  await assert.rejects(
    credentials.loadExchangeCredentials(7, 'BINANCE', 'DEMO'),
    /Re-enter the BINANCE DEMO credentials/,
  );
  assert.equal(decryptCalls.count, 0);
});

test('explicitly saved exchange credentials are marked confirmed and can be loaded', async () => {
  const decryptCalls = { count: 0 };
  const queries = [];
  const query = async (sql, values) => {
    queries.push({ sql, values });
    return {
      rows: [{
        api_key_ciphertext: 'encrypted:key-value',
        api_secret_ciphertext: 'encrypted:secret-value',
        passphrase_ciphertext: null,
        environment_confirmed: true,
      }],
    };
  };
  const credentials = loadCredentialModule({ query, decryptCalls });
  await credentials.saveExchangeCredentials(7, 'BINANCE', 'DEMO', {
    apiKey: 'key-value',
    apiSecret: 'secret-value',
  });
  assert.match(queries[0].sql, /environment_confirmed, last_verified_at/);
  assert.match(queries[0].sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, TRUE/);
  assert.equal(JSON.stringify(queries).includes('secret-value'), false);

  const loaded = await credentials.loadExchangeCredentials(7, 'BINANCE', 'DEMO');
  assert.deepEqual(loaded, { apiKey: 'key-value', apiSecret: 'secret-value' });
  assert.equal(decryptCalls.count, 2);
});
