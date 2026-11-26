import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function compileRoute(path) {
  const source = fileURLToPath(new URL(path, import.meta.url));
  const routeModule = new Module(source);
  routeModule.filename = source;
  routeModule.paths = Module._nodeModulePaths(process.cwd());
  routeModule._compile(ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, source);
  return routeModule.exports;
}
const queries = [];
const originalLoad = Module._load;
let schemaReady = false;
let encryptionReady = false;
let signedReads = 0;
let allowCsrf = true;
let queryFailure;
let authFailure;
class MockAuthError extends Error {
  status = 401;
}
let credentialRoute;
let balanceRoute;

try {
  Module._load = function loadFixture(name, parent, isMain) {
    if (name.endsWith('/lib/auth')) return {
      AuthError: MockAuthError,
      requireUser: async () => {
        if (authFailure) throw authFailure;
        return { id: 7 };
      },
    };
    if (name.endsWith('/lib/binance-futures')) return {
      BinanceFuturesError: class extends Error {},
      isTradingEnvironment: (input) => ['DEMO', 'LIVE'].includes(input),
      testBinanceEnvironment: async () => { signedReads++; },
      getFuturesBalance: async (actorId, environment) => {
        signedReads++;
        return { actorId, environment };
      },
    };
    if (name.endsWith('/lib/binance-demo-access')) return compileRoute('../lib/binance-demo-access.ts');
    if (name.endsWith('/lib/binance-credentials')) return {
      encryptCredential: (input) => `fixture-ciphertext:${input.length}`,
      isCredentialEncryptionConfigured: () => encryptionReady,
    };
    if (name.endsWith('/lib/http')) return { validCsrf: () => allowCsrf };
    if (name.endsWith('/lib/exchanges/schema')) return {
      assertExchangeFoundationReady: async () => {},
      ExchangeFoundationBlockedError: class extends Error {},
    };
    if (name.endsWith('/lib/db')) return {
      query: async (sql, values) => {
        queries.push({ sql, values });
        if (queryFailure) throw queryFailure;
        if (sql.includes('information_schema')) return { rows: [{ ready: schemaReady }] };
        if (sql.includes('user_trading_settings')) return { rows: [{ active_environment: 'DEMO' }] };
        return { rows: [{ environment_confirmed: true, updated_at: null }] };
      },
    };
    return originalLoad.call(this, name, parent, isMain);
  };
  credentialRoute = compileRoute('../app/api/binance/route.ts');
  balanceRoute = compileRoute('../app/api/binance/futures/balance/route.ts');
} finally {
  Module._load = originalLoad;
}

const { GET, POST } = credentialRoute;
const request = { nextUrl: new URL('https://example.invalid/api/binance?environment=DEMO') };
const post = (action, fields) => ({
  json: async () => ({ action, environment: 'DEMO', ...fields }),
});
const synthetic = { apiKey: 'A'.repeat(24), apiSecret: 'B'.repeat(24), confirmCredentialEnvironment: true };
const saveFlag = 'SMARTEXIT_BINANCE_CREDENTIAL_STORAGE_ENABLED';
const readFlag = 'SMARTEXIT_BINANCE_CREDENTIAL_TESTS_ENABLED';
const balanceFlag = 'SMARTEXIT_BINANCE_BALANCE_READ_ENABLED';

function setup(t) {
  const flags = [saveFlag, readFlag, balanceFlag];
  const previous = flags.map((name) => process.env[name]);
  for (const flag of flags) delete process.env[flag];
  t.after(() => {
    for (const [i, flag] of flags.entries()) {
      if (previous[i] === undefined) delete process.env[flag];
      else process.env[flag] = previous[i];
    }
  });
  queries.length = 0;
  schemaReady = false;
  encryptionReady = false;
  signedReads = 0;
  allowCsrf = true;
  queryFailure = undefined;
  authFailure = undefined;
}

test('missing credential migration returns a safe blocked status before reading or storing credentials', async (t) => {
  setup(t);
  for (const result of [await GET(request), await POST(post('save', synthetic))]) {
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await result.json()).code, 'SCHEMA_BLOCKED');
  }
  assert.equal(queries.length, 2);
  assert.ok(queries.every(({ sql }) => sql.includes('information_schema')));
});

test('storage needs encryption and approval and signed reads need a distinct approval', async (t) => {
  setup(t);
  schemaReady = true;
  assert.equal((await (await GET(request)).json()).code, 'ENCRYPTION_BLOCKED');
  encryptionReady = true;
  assert.equal((await (await POST(post('save', synthetic))).json()).code, 'ADMIN_APPROVAL_REQUIRED');
  process.env[saveFlag] = 'true';
  assert.equal((await (await POST(post('test'))).json()).code, 'SIGNED_READ_BLOCKED');
  assert.ok(queries.every(({ sql }) => sql.includes('information_schema')));
  assert.equal(signedReads, 0);
});

test('verified schema status reads no ciphertext and approved storage binds tenant, environment and encrypted values', async (t) => {
  setup(t);
  schemaReady = true;
  encryptionReady = true;
  process.env[saveFlag] = 'true';
  const status = await GET(request);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).data.signedReadEnabled, false);
  assert.match(queries[1].sql, /SELECT environment_confirmed, updated_at/);
  assert.doesNotMatch(queries[1].sql, /ciphertext/);
  assert.deepEqual(queries[1].values, [7, 'DEMO']);
  assert.equal((await POST(post('save', { ...synthetic, confirmCredentialEnvironment: false }))).status, 422);
  assert.equal((await POST(post('save', synthetic))).status, 200);
  assert.deepEqual(queries.at(-1).values, [7, 'DEMO', 'fixture-ciphertext:24', 'fixture-ciphertext:24']);
  assert.match(queries.at(-1).sql, /VALUES \(\$1, \$2, \$3, \$4, TRUE, NOW\(\)\)/);
});

test('credential route rejects unauthenticated or invalid CSRF requests before reaching database and hides driver errors', async (t) => {
  setup(t);
  authFailure = new MockAuthError('Sign in is required.');
  assert.equal((await GET(request)).status, 401);
  authFailure = undefined;
  allowCsrf = false;
  assert.equal((await POST(post('remove'))).status, 403);
  assert.equal(queries.length, 0);
  queryFailure = Object.assign(new Error('db-private fixture message'), { code: '42703' });
  const blocked = await GET(request);
  assert.equal((await blocked.json()).code, 'SCHEMA_BLOCKED');
  queryFailure = Object.assign(new Error('db-private fixture message'), { code: '42501' });
  const failure = await GET(request);
  assert.equal(failure.status, 503);
  assert.doesNotMatch(JSON.stringify(await failure.json()), /db-private|42501/);
});

test('balance uses a separate disabled-by-default gate and approved lookup is read-only and actor-bound', async (t) => {
  setup(t);
  encryptionReady = true;
  process.env[readFlag] = 'true';
  const blocked = await balanceRoute.GET();
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).code, 'SIGNED_READ_BLOCKED');
  assert.deepEqual(queries, []);
  assert.equal(signedReads, 0);
  process.env[balanceFlag] = 'true';
  const allowed = await balanceRoute.GET();
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).data, { actorId: 7, environment: 'DEMO' });
  assert.deepEqual(queries, [{
    sql: 'SELECT active_environment FROM public.user_trading_settings WHERE user_id = $1',
    values: [7],
  }]);
  assert.equal(signedReads, 1);
});
