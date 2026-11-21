import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};
Module._extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  module._compile(compiled.outputText, filename);
};

const { createAdminDemoProviderRepository } = require('./admin-demo-provider-repository.ts');
const credentialKey = '1a'.repeat(32);
process.env.BINANCE_CREDENTIALS_KEY = credentialKey;

function createDependencies(query, overrides = {}) {
  return {
    query,
    transaction: overrides.transaction ?? (async (work) => work(query)),
    rpc: overrides.rpc ?? (async () => ({ data: true, error: null })),
  };
}

function sessionRow(values = {}) {
  return {
    id: '501',
    admin_user_id: 17,
    provider: 'BYBIT',
    environment: 'DEMO',
    credential_id: '91',
    session_status: 'CREATED',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: null,
    ended_at: null,
    ...values,
  };
}

test('credential removal scrubs only the approved provider scope and preserves reconciliation', async () => {
  let unsettled = true;
  const statements = [];
  const repository = createAdminDemoProviderRepository(createDependencies(async (sql, values) => {
    statements.push({ sql, values });
    if (sql.includes('FROM public.admin_demo_identities')) return { rows: [{ is_active: true }] };
    if (sql.includes('FROM public.admin_demo_exchange_executions')) return { rows: unsettled ? [{}] : [] };
    if (sql.includes('UPDATE public.admin_demo_exchange_credentials')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO public.admin_demo_exchange_audit_events')) return { rows: [] };
    throw new Error('Unexpected query');
  }));
  await assert.rejects(repository.revokeCredential(17, 'GATE', { erase: true }), /before removing credentials/);
  assert.equal(statements.some(({ sql }) => sql.startsWith('UPDATE')), false);
  unsettled = false;
  assert.equal(await repository.revokeCredential(17, 'GATE', { erase: true }), true);
  const update = statements.find(({ sql }) => sql.includes('UPDATE public.admin_demo_exchange_credentials'));
  assert.deepEqual(update.values, [17, 'GATE', 'TESTNET']);
  assert.match(update.sql, /api_key_ciphertext = '', secret_key_ciphertext = '', passphrase_ciphertext = NULL/);
  assert.match(update.sql, /is_enabled = FALSE, revoked_at = COALESCE/);
  const audit = statements.find(({ sql }) => sql.includes('INSERT INTO public.admin_demo_exchange_audit_events'));
  assert.match(JSON.stringify(audit.values), /encryptedValuesRemoved/);
});

test('credential save encrypts every secret before SQL and only status DTO fields are returned', async () => {
  const secrets = {
    apiKey: 'api-key-plaintext-44',
    apiSecret: 'api-secret-plaintext-55',
    passphrase: 'passphrase-plaintext-66',
  };
  const calls = [];
  let ciphertexts;
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('FROM public.admin_demo_identities')) return { rows: [{ is_active: true }] };
    if (sql.includes('FROM public.admin_demo_exchange_sessions')) return { rows: [] };
    if (sql.includes('UPDATE public.admin_demo_exchange_credentials')) return { rows: [] };
    if (sql.includes('INSERT INTO public.admin_demo_exchange_credentials')) {
      ciphertexts = values.slice(3, 6);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO public.admin_demo_exchange_audit_events')) return { rows: [] };
    if (sql.includes('FROM public.admin_demo_exchange_credentials') &&
        sql.includes('owner_confirmed_at, is_enabled')) {
      return {
        rows: [{
          owner_confirmed_at: '2026-01-01T00:00:00.000Z',
          is_enabled: false,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          revoked_at: null,
        }],
      };
    }
    throw new Error(`Unexpected SQL in mock: ${sql}`);
  };
  const repository = createAdminDemoProviderRepository(createDependencies(query));

  const status = await repository.saveCredential(17, 'BYBIT', {
    ...secrets,
    ownerConfirmed: true,
  });

  assert.equal(status.provider, 'BYBIT');
  assert.equal(status.environment, 'DEMO');
  assert.equal(status.configured, true);
  assert.equal(status.ownerConfirmed, true);
  assert.equal(status.enabled, false);
  assert.equal('apiKey' in status, false);
  assert.equal('apiSecret' in status, false);
  assert.equal('passphrase' in status, false);
  assert.ok(ciphertexts.every((value) => typeof value === 'string' && value.includes('.')));
  const rotation = calls.find(({ sql }) =>
    sql.includes('UPDATE public.admin_demo_exchange_credentials'));
  assert.match(rotation.sql, /SET is_enabled = FALSE, revoked_at = CURRENT_TIMESTAMP/);
  const submittedParams = JSON.stringify(calls.map((call) => call.values));
  for (const secret of Object.values(secrets)) assert.equal(submittedParams.includes(secret), false);

  const credentialRepository = createAdminDemoProviderRepository(createDependencies(async (sql) => {
    assert.match(sql, /c\.provider = \$2::public\.admin_demo_provider/);
    assert.match(sql, /c\.environment = \$3/);
    assert.match(sql, /c\.owner_confirmed_at IS NOT NULL/);
    assert.match(sql, /c\.revoked_at IS NULL/);
    assert.doesNotMatch(sql, /AND c\.is_enabled/);
    return {
      rows: [{
        id: '92',
        admin_user_id: 17,
        provider: 'BYBIT',
        environment: 'DEMO',
        api_key_ciphertext: ciphertexts[0],
        secret_key_ciphertext: ciphertexts[1],
        passphrase_ciphertext: ciphertexts[2],
        owner_confirmed_at: '2026-01-01T00:00:00.000Z',
        is_enabled: false,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        revoked_at: null,
      }],
    };
  }));
  const internalCredential = await credentialRepository.getCredential(17, 'BYBIT');
  assert.deepEqual(
    (({ apiKey, apiSecret, passphrase }) => ({ apiKey, apiSecret, passphrase }))(internalCredential),
    secrets,
  );
  assert.equal(internalCredential.enabled, false);
});

test('session reads strictly scope administrator, provider, and its fixed environment', async () => {
  const calls = [];
  const repository = createAdminDemoProviderRepository(createDependencies(async (sql, values) => {
    calls.push({ sql, values });
    if (values[1] !== 17 || values[2] !== 'BYBIT') return { rows: [] };
    return { rows: [sessionRow()] };
  }));

  assert.equal((await repository.getSession(17, 'BYBIT', '501'))?.id, '501');
  assert.equal(await repository.getSession(18, 'BYBIT', '501'), null);
  assert.equal(await repository.getSession(17, 'OKX', '501'), null);
  assert.deepEqual(calls.map((call) => call.values), [
    ['501', 17, 'BYBIT', 'DEMO'],
    ['501', 18, 'BYBIT', 'DEMO'],
    ['501', 17, 'OKX', 'DEMO'],
  ]);
  assert.ok(calls.every(({ sql }) =>
    /s\.admin_user_id = \$2/.test(sql) &&
    /s\.provider = \$3::public\.admin_demo_provider/.test(sql) &&
    /s\.environment = \$4/.test(sql) &&
    /i\.is_active/.test(sql),
  ));
});

test('session creation is idempotent for a duplicate and rejects a conflicting active session', async () => {
  let inserts = 0;
  const existingSession = sessionRow();
  const query = async (sql) => {
    if (sql.includes('FROM public.admin_demo_identities')) {
      return { rows: [{ id: '17', is_active: true }] };
    }
    if (sql.includes('FROM public.admin_demo_exchange_credentials')) return { rows: [{ id: '91' }] };
    if (sql.includes('FROM public.admin_demo_exchange_sessions')) return { rows: [existingSession] };
    if (sql.includes('INSERT INTO public.admin_demo_exchange_sessions')) {
      inserts += 1;
      return { rows: [existingSession] };
    }
    throw new Error(`Unexpected SQL in mock: ${sql}`);
  };
  const repository = createAdminDemoProviderRepository(createDependencies(query));

  assert.equal((await repository.createSession(17, 'BYBIT', {
    symbol: 'BTCUSDT',
    direction: 'LONG',
  })).id, '501');
  await assert.rejects(
    repository.createSession(17, 'BYBIT', { symbol: 'ETHUSDT', direction: 'LONG' }),
    /active Admin Demo session already exists/,
  );
  assert.equal(inserts, 0);

  const duplicateRepository = createAdminDemoProviderRepository(createDependencies(
    async () => ({ rows: [] }),
    { transaction: async () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); } },
  ));
  await assert.rejects(
    duplicateRepository.createSession(17, 'BYBIT', {}),
    /active Admin Demo session already exists/,
  );

  const insertConflict = createAdminDemoProviderRepository(createDependencies(async (sql) => {
    if (sql.includes('FROM public.admin_demo_identities')) {
      return { rows: [{ id: '17', is_active: true }] };
    }
    if (sql.includes('FROM public.admin_demo_exchange_credentials')) return { rows: [{ id: '91' }] };
    if (sql.includes('FROM public.admin_demo_exchange_sessions')) return { rows: [] };
    if (sql.includes('INSERT INTO public.admin_demo_exchange_sessions')) {
      throw Object.assign(new Error('database duplicate detail'), { code: '23505' });
    }
    return { rows: [] };
  }));
  await assert.rejects(
    insertConflict.createSession(17, 'BYBIT', {}),
    /active Admin Demo session already exists/,
  );
});

test('disabled owner-confirmed credentials cannot create execution sessions', async () => {
  const statements = [];
  const repository = createAdminDemoProviderRepository(createDependencies(async (sql) => {
    statements.push(sql);
    if (sql.includes('FROM public.admin_demo_identities')) {
      return { rows: [{ id: '17', is_active: true }] };
    }
    if (sql.includes('FROM public.admin_demo_exchange_credentials')) return { rows: [] };
    throw new Error(`Unexpected SQL in mock: ${sql}`);
  }));
  await assert.rejects(
    repository.createSession(17, 'BYBIT', { symbol: 'BTCUSDT', direction: 'LONG' }),
    /enabled Admin Demo credential is required/,
  );
  const credentialCheck = statements.find((sql) =>
    sql.includes('FROM public.admin_demo_exchange_credentials'));
  assert.match(credentialCheck, /is_enabled AND revoked_at IS NULL/);
  assert.equal(statements.some((sql) =>
    sql.includes('INSERT INTO public.admin_demo_exchange_sessions')), false);
});

test('active authorizations and execution reservations are idempotent and reject conflicting retries', async () => {
  const activeAuthorization = {
    id: '702',
    session_id: '501',
    admin_user_id: 17,
    provider: 'BYBIT',
    environment: 'DEMO',
    permitted_actions: ['START_TEST'],
    expires_at: '2026-01-01T00:10:00.000Z',
    consumed_at: null,
    revoked_at: null,
  };
  let authorizationInserts = 0;
  const authorizationRepository = createAdminDemoProviderRepository(createDependencies(async (sql) => {
    if (sql.includes('FROM public.admin_demo_exchange_sessions s')) {
      assert.match(sql, /c\.is_enabled AND c\.revoked_at IS NULL/);
      return { rows: [sessionRow()] };
    }
    if (sql.includes('FROM public.admin_demo_exchange_authorizations')) {
      return { rows: [activeAuthorization] };
    }
    if (sql.includes('INSERT INTO public.admin_demo_exchange_authorizations')) {
      authorizationInserts += 1;
    }
    return { rows: [] };
  }));
  assert.equal(
    (await authorizationRepository.createAuthorization(17, 'BYBIT', '501', 600, ['START_TEST'])).id,
    '702',
  );
  await assert.rejects(
    authorizationRepository.createAuthorization(17, 'BYBIT', '501', 600, ['RECONCILE']),
    /active Admin Demo authorization already exists/,
  );
  assert.equal(authorizationInserts, 0);

  const input = {
    sessionId: '501',
    authorizationId: '702',
    entryOrderType: 'MARKET',
    limitEntryPrice: null,
    symbol: 'BTCUSDT',
    direction: 'LONG',
    quantity: '1',
    entryPrice: '100',
    stopLoss: '90',
    tp1Price: '110',
    tp2Price: '120',
    tp3Price: '130',
    tickSize: '0.1',
    entryClientOrderId: 'entry-client-1',
    stopClientOrderId: 'stop-client-1',
    tp3ClientOrderId: 'tp3-client-1',
    trailingClientOrderId: 'trail-client-1',
  };
  const execution = {
    id: '801',
    authorization_id: '702',
    entry_order_type: input.entryOrderType,
    limit_entry_price: null,
    symbol: input.symbol,
    direction: input.direction,
    quantity: '1.000000000000',
    entry_price: '100.000000000000',
    stop_loss: '90.000000000000',
    tp1_price: '110.000000000000',
    tp2_price: '120.000000000000',
    tp3_price: '130.000000000000',
    tick_size: '0.100000000000',
    entry_client_order_id: input.entryClientOrderId,
    stop_client_order_id: input.stopClientOrderId,
    tp3_client_order_id: input.tp3ClientOrderId,
    trailing_client_order_id: input.trailingClientOrderId,
  };
  const executionRepository = createAdminDemoProviderRepository(createDependencies(async (sql) => {
    if (sql.includes('FROM public.admin_demo_exchange_sessions')) {
      return { rows: [sessionRow({ session_status: 'RUNNING' })] };
    }
    if (sql.includes('FROM public.admin_demo_exchange_executions')) return { rows: [execution] };
    if (sql.includes('FROM public.admin_demo_exchange_authorizations a')) return { rows: [{ id: '702' }] };
    throw new Error(`Unexpected SQL in mock: ${sql}`);
  }));
  assert.equal(await executionRepository.reserveExecution(17, 'BYBIT', input), 'EXISTING');
  assert.equal(
    await executionRepository.reserveExecution(17, 'BYBIT', { ...input, quantity: '2' }),
    'BUSY',
  );
});

test('START_TEST consumption and execution reservation commit atomically in the provider scope', async () => {
  const calls = [];
  let transactions = 0;
  const input = {
    sessionId: '501',
    authorizationId: '702',
    entryOrderType: 'LIMIT',
    limitEntryPrice: '100',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    quantity: '1',
    entryPrice: '100',
    stopLoss: '90',
    tp1Price: '110',
    tp2Price: '120',
    tp3Price: '130',
    tickSize: '0.1',
    entryClientOrderId: 'entry-client-2',
    stopClientOrderId: 'stop-client-2',
    tp3ClientOrderId: 'tp3-client-2',
    trailingClientOrderId: 'trail-client-2',
  };
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('FROM public.admin_demo_exchange_sessions s')) {
      return { rows: [sessionRow({ session_status: 'AUTHORIZED' })] };
    }
    if (sql.includes('FROM public.admin_demo_exchange_executions')) return { rows: [] };
    if (sql.includes('UPDATE public.admin_demo_exchange_authorizations a')) {
      return { rows: [{ id: '702' }] };
    }
    if (sql.includes('INSERT INTO public.admin_demo_exchange_executions')) {
      return { rows: [{ id: '802' }] };
    }
    return { rows: [] };
  };
  const repository = createAdminDemoProviderRepository(createDependencies(query, {
    transaction: async (work) => {
      transactions += 1;
      return work(query);
    },
  }));
  assert.equal(await repository.reserveExecution(17, 'BYBIT', input), 'CREATED');
  assert.equal(transactions, 1);
  const consume = calls.find(({ sql }) => sql.includes('UPDATE public.admin_demo_exchange_authorizations a'));
  const insert = calls.find(({ sql }) => sql.includes('INSERT INTO public.admin_demo_exchange_executions'));
  assert.ok(calls.indexOf(consume) < calls.indexOf(insert));
  assert.match(consume.sql, /consumed_at IS NULL/);
  assert.match(consume.sql, /expires_at > CURRENT_TIMESTAMP/);
  assert.match(consume.sql, /'START_TEST' = ANY\(a\.permitted_actions\)/);
  assert.match(consume.sql, /a\.provider = \$4::public\.admin_demo_provider/);
  assert.match(insert.sql, /'CONFIRM'/);
  assert.ok(calls.some(({ sql }) => sql.includes("SET session_status = 'RUNNING'")));

  const expiredCalls = [];
  const expiredRepository = createAdminDemoProviderRepository(createDependencies(async (sql, values = []) => {
    expiredCalls.push({ sql, values });
    if (sql.includes('FROM public.admin_demo_exchange_sessions s')) {
      return { rows: [sessionRow({ session_status: 'AUTHORIZED' })] };
    }
    if (sql.includes('FROM public.admin_demo_exchange_executions')) return { rows: [] };
    if (sql.includes('UPDATE public.admin_demo_exchange_authorizations a')) return { rows: [] };
    throw new Error('An expired authorization must not reserve an execution.');
  }));
  assert.equal(await expiredRepository.reserveExecution(17, 'BYBIT', input), 'BUSY');
  assert.equal(expiredCalls.some(({ sql }) => sql.includes('INSERT INTO public.admin_demo_exchange_executions')), false);

  let grantConsumed = false;
  let rolledBack = false;
  const failingQuery = async (sql) => {
    if (sql.includes('FROM public.admin_demo_exchange_sessions s')) {
      return { rows: [sessionRow({ session_status: 'AUTHORIZED' })] };
    }
    if (sql.includes('FROM public.admin_demo_exchange_executions')) return { rows: [] };
    if (sql.includes('UPDATE public.admin_demo_exchange_authorizations a')) {
      grantConsumed = true;
      return { rows: [{ id: '702' }] };
    }
    if (sql.includes('INSERT INTO public.admin_demo_exchange_executions')) {
      throw new Error('injected reservation failure');
    }
    return { rows: [] };
  };
  const failingRepository = createAdminDemoProviderRepository(createDependencies(failingQuery, {
    transaction: async (work) => {
      try {
        return await work(failingQuery);
      } catch (error) {
        grantConsumed = false;
        rolledBack = true;
        throw error;
      }
    },
  }));
  await assert.rejects(failingRepository.reserveExecution(17, 'BYBIT', input), /repository operation failed/);
  assert.equal(rolledBack, true);
  assert.equal(grantConsumed, false);
});

test('execution progress persists exchange/protection identifiers, milestones, status, and safe audit events', async () => {
  const calls = [];
  const row = {
    id: '801',
    session_id: '501',
    authorization_id: '702',
    admin_user_id: 17,
    provider: 'BYBIT',
    environment: 'DEMO',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    entry_order_type: 'LIMIT',
    execution_status: 'PROTECTED',
    protection_status: 'PROTECTED',
    entry_client_order_id: 'entry-client-1',
    entry_exchange_order_id: 'exchange-entry-1',
    quantity: '0.01',
    entry_price: '100',
    stop_loss: '90',
    tp1_price: '110',
    tp2_price: '120',
    tp3_price: '130',
    tick_size: '0.1',
    stop_client_order_id: 'stop-client-1',
    tp3_client_order_id: 'tp3-client-1',
    trailing_client_order_id: 'trail-client-1',
    stop_protection_id: 'native-501-sl',
    tp3_protection_id: 'native-501-tp3',
    trailing_protection_id: 'native-501-trail-tp1',
    tp1_reached_at: '2026-01-01T00:01:00.000Z',
    tp2_reached_at: '2026-01-01T00:02:00.000Z',
    execution_mode: 'CONFIRM',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:02:00.000Z',
    closed_at: null,
  };
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('UPDATE public.admin_demo_exchange_executions e')) return { rows: [row] };
    if (sql.includes('INSERT INTO public.admin_demo_exchange_audit_events')) return { rows: [] };
    return { rows: [] };
  };
  const repository = createAdminDemoProviderRepository(createDependencies(query));
  const saved = await repository.updateExecutionProgress(17, 'BYBIT', '501', {
    executionStatus: 'PROTECTED',
    protectionStatus: 'PROTECTED',
    filledQuantity: '0.01',
    entryExchangeOrderId: 'exchange-entry-1',
    stopProtectionId: 'native-501-sl',
    tp3ProtectionId: 'native-501-tp3',
    trailingProtectionId: 'native-501-trail-tp1',
    tp1Reached: true,
    tp2Reached: true,
  }, '702');
  assert.equal(saved.executionMode, 'CONFIRM');
  assert.equal(saved.quantity, '0.01');
  assert.equal(saved.entryExchangeOrderId, 'exchange-entry-1');
  assert.equal(saved.stopProtectionId, 'native-501-sl');
  assert.equal(saved.tp3ProtectionId, 'native-501-tp3');
  assert.equal(saved.trailingProtectionId, 'native-501-trail-tp1');
  assert.equal(saved.tp1ReachedAt, row.tp1_reached_at);
  assert.equal(saved.tp2ReachedAt, row.tp2_reached_at);
  const update = calls.find(({ sql }) => sql.includes('UPDATE public.admin_demo_exchange_executions e'));
  assert.match(update.sql, /tp1_reached_at = CASE WHEN \$10::BOOLEAN/);
  assert.match(update.sql, /tp2_reached_at = CASE WHEN \$11::BOOLEAN/);
  assert.match(update.sql, /quantity = COALESCE\(\$14::NUMERIC, e\.quantity\)/);
  assert.equal(update.values[13], '0.01');
  assert.match(update.sql, /e\.provider = \$3::public\.admin_demo_provider/);
  const audit = calls.find(({ sql }) => sql.includes('INSERT INTO public.admin_demo_exchange_audit_events'));
  assert.equal(audit.values[0], '501');
  assert.equal(audit.values[1], '702');
  assert.equal(audit.values[5], 'PROTECTION_VERIFIED');
  assert.deepEqual(JSON.parse(audit.values[7]), {
    environment: 'DEMO',
    executionStatus: 'PROTECTED',
    protectionStatus: 'PROTECTED',
    milestone: 'TP2',
  });
  assert.equal(JSON.stringify(audit.values).includes('apiSecret'), false);
});

test('execution reads and reconciliation locks stay provider-scoped and require consumed reconcile grants', async () => {
  const calls = [];
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('FROM public.admin_demo_exchange_executions e')) {
      return values[2] === 'BYBIT' ? { rows: [{
        id: '801',
        session_id: '501',
        authorization_id: '702',
        admin_user_id: 17,
        provider: 'BYBIT',
        environment: 'DEMO',
        symbol: 'BTCUSDT',
        direction: 'LONG',
        entry_order_type: 'LIMIT',
        execution_status: 'ENTRY_UNKNOWN',
        protection_status: 'PENDING',
        entry_client_order_id: 'entry-client-1',
        entry_exchange_order_id: null,
        quantity: '1',
        entry_price: '100',
        stop_loss: '90',
        tp1_price: '110',
        tp2_price: '120',
        tp3_price: '130',
        tick_size: '0.1',
        stop_client_order_id: 'stop-client-1',
        tp3_client_order_id: 'tp3-client-1',
        trailing_client_order_id: 'trail-client-1',
        stop_protection_id: null,
        tp3_protection_id: null,
        trailing_protection_id: null,
        tp1_reached_at: null,
        tp2_reached_at: null,
        execution_mode: 'CONFIRM',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        closed_at: null,
      }] } : { rows: [] };
    }
    if (sql.includes('UPDATE public.admin_demo_exchange_executions')) {
      return values[2] === 'BYBIT' ? { rows: [{ id: '801' }] } : { rows: [] };
    }
    if (sql.includes('INSERT INTO public.admin_demo_exchange_audit_events')) return { rows: [] };
    return { rows: [] };
  };
  const repository = createAdminDemoProviderRepository(createDependencies(query));
  const execution = await repository.getExecution(17, 'BYBIT', '501');
  assert.equal(execution.executionStatus, 'ENTRY_UNKNOWN');
  assert.equal(await repository.getExecution(17, 'OKX', '501'), null);
  const token = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(await repository.claimReconciliation(17, 'BYBIT', '501', '702', token, 90), true);
  const claim = calls.find(({ sql }) => sql.includes('UPDATE public.admin_demo_exchange_executions e'));
  assert.match(claim.sql, /a\.consumed_at IS NOT NULL/);
  assert.match(claim.sql, /'RECONCILE' = ANY\(a\.permitted_actions\)/);
  assert.match(claim.sql, /a\.expires_at > CURRENT_TIMESTAMP/);
  assert.match(claim.sql, /e\.provider = \$3::public\.admin_demo_provider/);
  assert.match(claim.sql, /e\.reconcile_lock_until IS NULL OR e\.reconcile_lock_until <= CURRENT_TIMESTAMP/);
  assert.match(claim.sql, /SET reconcile_lock_token = \$5::UUID/);
  assert.match(claim.sql, /e\.execution_status IN \([\s\S]*'ENTRY_UNKNOWN'/);
  assert.equal(await repository.releaseReconciliation(17, 'BYBIT', '501', token), true);
  const release = calls.find(({ sql }) => sql.includes('SET reconcile_lock_token = NULL'));
  assert.match(release.sql, /reconcile_lock_token = \$5::UUID/);
  assert.equal(await repository.releaseReconciliation(17, 'OKX', '501', token), false);
});

test('authorization enforces the 15-minute ceiling and restricts permitted actions', async () => {
  const calls = [];
  const authorization = {
    id: '701',
    session_id: '501',
    admin_user_id: 17,
    provider: 'BYBIT',
    environment: 'DEMO',
    permitted_actions: ['START_TEST', 'RECONCILE'],
    expires_at: '2026-01-01T00:15:00.000Z',
    consumed_at: null,
    revoked_at: null,
  };
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('FROM public.admin_demo_exchange_sessions s')) return { rows: [sessionRow()] };
    if (sql.includes('FROM public.admin_demo_exchange_authorizations')) return { rows: [] };
    if (sql.includes('INSERT INTO public.admin_demo_exchange_authorizations')) {
      return { rows: [authorization] };
    }
    return { rows: [] };
  };
  const repository = createAdminDemoProviderRepository(createDependencies(query));

  await assert.rejects(
    repository.createAuthorization(17, 'BYBIT', '501', 901, ['START_TEST']),
    /between 1 and 900/,
  );
  await assert.rejects(
    repository.createAuthorization(17, 'BYBIT', '501', 60, ['WITHDRAW']),
    /actions are invalid/,
  );
  const created = await repository.createAuthorization(
    17, 'BYBIT', '501', 900, ['START_TEST', 'RECONCILE'],
  );
  assert.deepEqual(created.permittedActions, ['START_TEST', 'RECONCILE']);
  const insert = calls.find(({ sql }) => sql.includes('INSERT INTO public.admin_demo_exchange_authorizations'));
  assert.match(insert.sql, /CURRENT_TIMESTAMP \+ \(\$6 \* INTERVAL '1 second'\)/);
  assert.equal(insert.values[5], 900);
  assert.deepEqual(insert.values[4], ['START_TEST', 'RECONCILE']);
  assert.match(calls[0].sql, /s\.provider = \$3::public\.admin_demo_provider/);
  assert.match(calls[0].sql, /s\.environment = \$4/);
});

test('reconciliation renewal requires a consumed expired grant and an active recoverable execution', async () => {
  const calls = [];
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('FROM public.admin_demo_exchange_sessions s')) {
      return { rows: [sessionRow({ session_status: 'RECONCILIATION_REQUIRED' })] };
    }
    if (sql.includes('FROM public.admin_demo_exchange_authorizations')) {
      return {
        rows: [{
          id: '701',
          session_id: '501',
          admin_user_id: 17,
          provider: 'BYBIT',
          environment: 'DEMO',
          permitted_actions: ['START_TEST', 'RECONCILE'],
          expires_at: '2026-01-01T00:00:00.000Z',
          consumed_at: '2025-12-31T23:59:00.000Z',
          revoked_at: null,
        }],
      };
    }
    if (sql.includes('FROM public.admin_demo_exchange_executions e')) {
      return { rows: [{ id: '801', execution_status: 'PROTECTED' }] };
    }
    if (sql.includes('INSERT INTO public.admin_demo_exchange_authorizations')) {
      return {
        rows: [{
          id: '702',
          session_id: '501',
          admin_user_id: 17,
          provider: 'BYBIT',
          environment: 'DEMO',
          permitted_actions: ['RECONCILE'],
          expires_at: '2026-01-01T00:10:00.000Z',
          consumed_at: '2026-01-01T00:00:00.000Z',
          revoked_at: null,
        }],
      };
    }
    if (sql.includes('UPDATE public.admin_demo_exchange_executions')) return { rows: [{ id: '801' }] };
    return { rows: [] };
  };
  const repository = createAdminDemoProviderRepository(createDependencies(query));
  const renewed = await repository.renewReconciliationAuthorization(17, 'BYBIT', '501', '701', 600);

  assert.deepEqual(renewed.permittedActions, ['RECONCILE']);
  assert.equal(renewed.consumedAt, '2026-01-01T00:00:00.000Z');
  const oldGrantCheck = calls.find(({ sql }) =>
    sql.includes('FROM public.admin_demo_exchange_authorizations') && sql.includes('consumed_at IS NOT NULL'));
  assert.match(oldGrantCheck.sql, /expires_at <= CURRENT_TIMESTAMP/);
  assert.match(oldGrantCheck.sql, /'RECONCILE' = ANY\(permitted_actions\)/);
  const executionCheck = calls.find(({ sql }) =>
    sql.includes('FROM public.admin_demo_exchange_executions e'));
  assert.match(executionCheck.sql, /e\.authorization_id = \$5::BIGINT/);
  assert.match(executionCheck.sql, /'RECONCILIATION_REQUIRED'/);
  const insert = calls.find(({ sql }) => sql.includes('INSERT INTO public.admin_demo_exchange_authorizations'));
  assert.match(insert.sql, /ARRAY\['RECONCILE'\]::TEXT\[\]/);
  assert.match(insert.sql, /expires_at, consumed_at/);
  assert.match(insert.sql, /CURRENT_TIMESTAMP \+ \(\$5 \* INTERVAL '1 second'\), CURRENT_TIMESTAMP/);
  assert.doesNotMatch(insert.sql, /START_TEST/);
  assert.equal(insert.values[4], 600);
});

test('authorization action uses only the injected service-role RPC and fails closed', async () => {
  const calls = [];
  let response = { data: true, error: null };
  let shouldThrow = false;
  const repository = createAdminDemoProviderRepository(createDependencies(
    async () => { throw new Error('RPC must not be emulated with SQL'); },
    {
      rpc: async (functionName, parameters) => {
        calls.push({ functionName, parameters });
        if (shouldThrow) throw new Error('service role unavailable');
        return response;
      },
    },
  ));

  assert.equal(await repository.authorizeAction(17, 'GATE', '501', '701', 'RECONCILE'), true);
  assert.deepEqual(calls[0], {
    functionName: 'authorize_admin_demo_exchange_action',
    parameters: {
      p_admin_user_id: 17,
      p_admin_scope: 'ADMIN',
      p_session_id: '501',
      p_authorization_id: '701',
      p_provider: 'GATE',
      p_environment: 'TESTNET',
      p_action: 'RECONCILE',
    },
  });
  response = { data: false, error: null };
  assert.equal(await repository.authorizeAction(17, 'GATE', '501', '701', 'START_TEST'), false);
  response = { data: true, error: { code: 'PGRST' } };
  assert.equal(await repository.authorizeAction(17, 'GATE', '501', '701', 'START_TEST'), false);
  response = { data: true, error: null };
  shouldThrow = true;
  assert.equal(await repository.authorizeAction(17, 'GATE', '501', '701', 'START_TEST'), false);
  assert.equal(await repository.authorizeAction(17, 'GATE', '501', '701', 'INVALID'), false);
  assert.equal(calls.length, 4);
});

test('sessionless audit events are retained only with allowlisted, non-free-text details', async () => {
  let inserted;
  const repository = createAdminDemoProviderRepository(createDependencies(async (sql, values) => {
    assert.match(sql, /INSERT INTO public\.admin_demo_exchange_audit_events/);
    inserted = values;
    return { rows: [] };
  }));

  await repository.appendAuditEvent({
    adminUserId: 17,
    provider: 'BYBIT',
    eventType: 'CREDENTIAL_SAVED',
    eventStatus: 'SUCCEEDED',
    safeDetails: {
      environment: 'DEMO',
      direction: 'LONG',
      action: 'RECONCILE',
      permittedActions: ['RECONCILE', 'ATTACK'],
      apiKey: 'top-secret-api-key',
      passphrase: 'top-secret-passphrase',
      symbol: 'not-an-allowlisted-detail',
      message: 'untrusted free text',
      token: 'sensitive',
    },
  });

  assert.equal(inserted[0], null);
  assert.equal(inserted[1], null);
  assert.deepEqual(JSON.parse(inserted[7]), {
    environment: 'DEMO',
    direction: 'LONG',
    action: 'RECONCILE',
    permittedActions: ['RECONCILE'],
  });
  assert.equal(JSON.stringify(inserted).includes('top-secret'), false);
  assert.equal(JSON.stringify(inserted).includes('untrusted free text'), false);

  const historyRepository = createAdminDemoProviderRepository(createDependencies(async () => ({
    rows: [{
      id: '1',
      session_id: null,
      authorization_id: null,
      admin_user_id: 17,
      provider: 'BYBIT',
      environment: 'DEMO',
      event_type: 'BALANCE_READ',
      event_status: 'SUCCEEDED',
      safe_details: { environment: 'DEMO', token: 'must-not-be-returned' },
      created_at: '2026-01-01T00:00:00.000Z',
    }],
  })));
  const [event] = await historyRepository.listAuditEvents(17, 'BYBIT', 10);
  assert.equal(event.sessionId, null);
  assert.deepEqual(event.safeDetails, { environment: 'DEMO' });
});

test('missing schema errors are explicit and never fall back to another repository', async () => {
  const repository = createAdminDemoProviderRepository(createDependencies(async () => {
    throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
  }));
  await assert.rejects(
    repository.getCredentialStatus(17, 'BYBIT'),
    /schema is missing or outdated.*202611110007_admin_demo_exchange_neutral\.sql/,
  );
});

test('reconciliation lease verification scopes token and expiry and rejects stale progress writes', async () => {
  const token = '550e8400-e29b-41d4-a716-446655440000';
  const calls = [];
  let leaseCurrent = true;
  const repository = createAdminDemoProviderRepository(createDependencies(async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('SELECT e.id::TEXT FROM')) return { rows: leaseCurrent ? [{ id: '801' }] : [] };
    return { rows: [] };
  }));
  assert.equal(await repository.verifyReconciliationLease(17, 'BYBIT', '501', '702', token), true);
  const verify = calls.at(-1);
  assert.deepEqual(verify.values, ['501', 17, 'BYBIT', 'DEMO', '702', token, 0]);
  assert.match(verify.sql, /e\.reconcile_lock_token = \$6::UUID/);
  assert.match(verify.sql, /e\.reconcile_lock_until > CURRENT_TIMESTAMP/);
  assert.match(verify.sql, /e\.authorization_id = \$5::BIGINT/);
  assert.equal(await repository.verifyReconciliationLease(17, 'BYBIT', '501', '702', token, 15), true);
  assert.equal(calls.at(-1).values[6], 15);
  assert.match(calls.at(-1).sql, /a\.expires_at > CURRENT_TIMESTAMP \+ \(\$7 \* INTERVAL '1 second'\)/);
  assert.match(calls.at(-1).sql, /e\.reconcile_lock_until > CURRENT_TIMESTAMP \+ \(\$7 \* INTERVAL '1 second'\)/);
  leaseCurrent = false;
  assert.equal(await repository.verifyReconciliationLease(17, 'BYBIT', '501', '702', token), false);
  calls.length = 0;
  await assert.rejects(repository.updateExecutionProgress(17, 'BYBIT', '501', {
    executionStatus: 'CLOSED',
  }, '702', token), /unavailable/);
  assert.equal(calls.length, 1, 'stale writer must not update session or append success audit');
  assert.equal(calls[0].values[14], token);
  assert.match(calls[0].sql, /e\.reconcile_lock_token = \$15::UUID/);
  assert.match(calls[0].sql, /e\.reconcile_lock_until > CURRENT_TIMESTAMP/);
});

test('staged lifecycle audit reasons and booleans survive sanitization without free-text leakage', async () => {
  let stored;
  const repository = createAdminDemoProviderRepository(createDependencies(async (sql, values) => {
    if (sql.includes('INSERT INTO')) { stored = JSON.parse(values[7]); return { rows: [] }; }
    return { rows: [{
      id: '1', session_id: null, authorization_id: null, admin_user_id: 17,
      provider: 'BYBIT', environment: 'DEMO', event_type: 'RECONCILIATION_REQUIRED',
      event_status: 'BLOCKED', safe_details: stored, created_at: '2026-01-01T00:00:00.000Z',
    }] };
  }));
  for (const reason of ['TP2_TRAILING_UPDATE_UNSUPPORTED', 'LIFECYCLE_STATE_UNVERIFIED']) {
    await repository.appendAuditEvent({
      adminUserId: 17, provider: 'BYBIT', eventType: 'RECONCILIATION_REQUIRED', eventStatus: 'BLOCKED',
      safeDetails: { environment: 'DEMO', reason, existingProtectionRetained: true,
        partialExitSubmitted: false, protectionRemovalRequested: false, message: 'secret-raw-error', token: 'secret' },
    });
    const [event] = await repository.listAuditEvents(17, 'BYBIT', 10);
    assert.deepEqual(event.safeDetails, { environment: 'DEMO', reason, existingProtectionRetained: true,
      partialExitSubmitted: false, protectionRemovalRequested: false });
  }
  await repository.appendAuditEvent({ adminUserId: 17, provider: 'BYBIT',
    eventType: 'RECONCILIATION_REQUIRED', eventStatus: 'UNCERTAIN',
    safeDetails: { reason: 'secret-raw-error', existingProtectionRetained: 'true' } });
  assert.deepEqual(stored, {});
});
