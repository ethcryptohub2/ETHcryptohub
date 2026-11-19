import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_MIGRATIONS,
  EXPECTED_VERIFICATION_FILES,
  queryLocalMigrationStatus,
  validateMigrations,
} from './validate-migrations.mjs';

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-exit-migrations-'));
  try {
    const verificationDirectory = path.join(directory, 'verification');
    await mkdir(verificationDirectory);
    await run(directory, verificationDirectory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeExpectedFiles(directory, verificationDirectory) {
    for (const name of EXPECTED_MIGRATIONS) await writeFile(path.join(directory, name), '');
    for (const name of EXPECTED_VERIFICATION_FILES) await writeFile(path.join(verificationDirectory, name), '-- read only');
}

test('migration validator finds migration and verification files but leaves database status unknown', async () => {
  await withDirectory(async (directory, verificationDirectory) => {
    await writeExpectedFiles(directory, verificationDirectory);
    const report = await validateMigrations(directory, verificationDirectory);
    assert.equal(report.valid, true);
    assert.equal(report.status, 'UNKNOWN');
    assert.match(report.migrationStatusMessage, /no database was queried/);
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.missingVerificationFiles, []);
    assert.deepEqual(report.misplacedVerificationFiles, []);
  });
});

test('migration validator reports missing files and never infers applied status', async () => {
  await withDirectory(async (directory, verificationDirectory) => {
    await writeFile(path.join(directory, EXPECTED_MIGRATIONS[0]), '');
    const report = await validateMigrations(directory, verificationDirectory);
    assert.equal(report.valid, false);
    assert.deepEqual(report.missing, EXPECTED_MIGRATIONS.slice(1));
    assert.deepEqual(report.missingVerificationFiles, EXPECTED_VERIFICATION_FILES);
    assert.equal(report.status, 'UNKNOWN');
  });
});

test('password recovery migration requires its matching verification SQL', async () => {
  await withDirectory(async (directory, verificationDirectory) => {
    await writeExpectedFiles(directory, verificationDirectory);
    await rm(path.join(directory, '202611140001_password_recovery.sql'));
    await rm(path.join(verificationDirectory, '202611140001_password_recovery.sql'));

    const report = await validateMigrations(directory, verificationDirectory);

    assert.deepEqual(report.missing, ['202611140001_password_recovery.sql']);
    assert.deepEqual(report.missingVerificationFiles, ['202611140001_password_recovery.sql']);
  });
});

test('news platform migration requires its matching RLS verification SQL', async () => {
  await withDirectory(async (directory, verificationDirectory) => {
    await writeExpectedFiles(directory, verificationDirectory);
    await rm(path.join(verificationDirectory, '202611070003_news_platform.sql'));

    const report = await validateMigrations(directory, verificationDirectory);

    assert.deepEqual(report.missingVerificationFiles, ['202611070003_news_platform.sql']);
  });
});

test('local database verification is read-only and restricted to localhost', () => {
  let command;
  let args;
  let options;
  const result = queryLocalMigrationStatus((spawnCommand, spawnArgs, spawnOptions) => {
    command = spawnCommand;
    args = spawnArgs;
    options = spawnOptions;
    return {
      status: 0,
      stdout: `${JSON.stringify(EXPECTED_MIGRATIONS.map((name) => name.slice(0, 12)))}\n`,
    };
  });

  assert.equal(command, 'psql');
  assert.ok(args.includes('--host=127.0.0.1'));
  assert.ok(args.includes('--no-password'));
  assert.match(args.at(-1), /BEGIN READ ONLY/);
  assert.match(args.at(-1), /COMMIT/);
  assert.doesNotMatch(args.at(-1), /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
  assert.equal(options.timeout, 5000);
  assert.equal(options.env.PGPASSFILE, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.equal(result.status, 'APPLIED');
  assert.deepEqual(result.missingVersions, []);
});

test('local database verification reports missing versions and unavailable databases safely', () => {
  const missing = queryLocalMigrationStatus(() => ({ status: 0, stdout: '[]\n' }));
  assert.equal(missing.status, 'MISSING');
  assert.deepEqual(missing.appliedVersions, []);
  assert.equal(missing.missingVersions.length, EXPECTED_MIGRATIONS.length);

  const unavailable = queryLocalMigrationStatus(() => ({ status: 2, stdout: '', stderr: 'not exposed' }));
  assert.equal(unavailable.status, 'UNKNOWN');
  assert.match(unavailable.message, /localhost-only/);
});

test('localhost ledger query normalizes MCP filename identities without changing history', () => {
  const result = queryLocalMigrationStatus((command, args) => {
    assert.equal(command, 'psql');
    const sql = args.at(-1);
    assert.match(sql, /substring\(name FROM '\^\(\[0-9\]\{12\}\)_'\)/);
    assert.match(sql, /COALESCE\(substring/);
    assert.match(sql, /version::text/);
    assert.match(sql, /WHERE migration_version IN/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
    return { status: 0, stdout: '["202611100002"]\n' };
  });
  assert.equal(result.status, 'MISSING');
  assert.deepEqual(result.appliedVersions, ['202611100002']);
  assert.ok(result.missingVersions.includes('202611100003'));
});

test('migration validator rejects duplicate versions and malformed migration names', async () => {
  await withDirectory(async (directory, verificationDirectory) => {
    await writeExpectedFiles(directory, verificationDirectory);
    await writeFile(path.join(directory, '202611100001_duplicate.sql'), '');
    await writeFile(path.join(directory, '202611100006-malformed.sql'), '');
    const report = await validateMigrations(directory, verificationDirectory);
    assert.equal(report.valid, false);
    assert.equal(report.duplicateVersions[0]?.version, '202611100001');
    assert.deepEqual(report.invalidNames, ['202611100006-malformed.sql']);
  });
});

test('migration validator requires the expected versioned dependency sequence', async () => {
  await withDirectory(async (directory, verificationDirectory) => {
    const incorrectlyVersioned = EXPECTED_MIGRATIONS.map((name) =>
      name.startsWith('202611100002_') ? name.replace('202611100002', '202611100000') : name,
    );
    for (const name of incorrectlyVersioned) await writeFile(path.join(directory, name), '');
    for (const name of EXPECTED_VERIFICATION_FILES) await writeFile(path.join(verificationDirectory, name), '-- read only');
    const report = await validateMigrations(directory, verificationDirectory);
    assert.equal(report.valid, false);
    assert.ok(report.missing.includes('202611100002_binance_demo_environments.sql'));
  });
});

test('multi-exchange safety migrations run after their data backfills', async () => {
  const foundation = EXPECTED_MIGRATIONS.indexOf('202611100003_multi_exchange_foundation.sql');
  const exchangeSafety = EXPECTED_MIGRATIONS.indexOf('202611100004_exchange_execution_defaults_disabled.sql');
  const strategies = EXPECTED_MIGRATIONS.indexOf('202611110001_strategy_profiles.sql');
  const adminGrant = EXPECTED_MIGRATIONS.indexOf('202611110005_admin_binance_demo_rpc_grant.sql');
  const finalSafety = EXPECTED_MIGRATIONS.indexOf('202611110006_multi_exchange_execution_defaults_disabled.sql');
  assert.ok(foundation >= 0 && foundation < exchangeSafety && exchangeSafety < strategies);
  assert.ok(adminGrant >= 0 && adminGrant < finalSafety);

  const migrationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
  const exchangeSafetySql = await readFile(
    path.join(migrationDirectory, '202611100004_exchange_execution_defaults_disabled.sql'),
    'utf8',
  );
  const foundationSql = await readFile(
    path.join(migrationDirectory, '202611100003_multi_exchange_foundation.sql'),
    'utf8',
  );
  const finalSafetySql = await readFile(
    path.join(migrationDirectory, '202611110006_multi_exchange_execution_defaults_disabled.sql'),
    'utf8',
  );
  assert.match(foundationSql, /SELECT user_id, 'BINANCE', 'DEMO', order_size_mode/i);
  assert.match(foundationSql, /risk_percentage, default_leverage, 'CONFIRM', FALSE/i);
  assert.match(foundationSql, /SELECT user_id, 'BINANCE', 'LIVE', order_size_mode/i);
  assert.match(foundationSql, /'BINANCE', FALSE, FALSE, 'binance-futures-v1'/i);
  assert.doesNotMatch(foundationSql, /demo_auto_trade_enabled|live_auto_trade_enabled/);
  assert.match(exchangeSafetySql, /customer_enabled\s*=\s*FALSE/i);
  assert.match(exchangeSafetySql, /demo_enabled\s*=\s*FALSE/i);
  assert.match(exchangeSafetySql, /testnet_enabled\s*=\s*FALSE/i);
  assert.match(exchangeSafetySql, /live_enabled\s*=\s*FALSE/i);
  assert.match(exchangeSafetySql, /auto_trade_enabled\s*=\s*FALSE/i);
  assert.match(exchangeSafetySql, /execution_mode\s*=\s*'CONFIRM'/i);
  assert.match(finalSafetySql, /enabled\s*=\s*FALSE/i);
  assert.match(finalSafetySql, /auto_execution_enabled\s*=\s*FALSE/i);
  assert.match(finalSafetySql, /demo_auto_trade_enabled\s*=\s*FALSE/i);
  assert.match(finalSafetySql, /live_auto_trade_enabled\s*=\s*FALSE/i);
  assert.doesNotMatch(`${exchangeSafetySql}\n${finalSafetySql}`, /\b(?:INSERT|UPDATE|DELETE)\s+[^;]*credential/i);
});

test('verification SQL in the migration directory is rejected', async () => {
  await withDirectory(async (directory, verificationDirectory) => {
    await writeExpectedFiles(directory, verificationDirectory);
    await writeFile(path.join(directory, '202611110004_verification.sql'), '-- SELECT only');
    const report = await validateMigrations(directory, verificationDirectory);
    assert.equal(report.valid, false);
    assert.deepEqual(report.misplacedVerificationFiles, ['202611110004_verification.sql']);
  });
});
