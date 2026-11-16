import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_MIGRATIONS = [
  '202611070003_news_platform.sql',
  '202611100001_live_futures_trading.sql',
  '202611100002_binance_demo_environments.sql',
  '202611100003_multi_exchange_foundation.sql',
  '202611110001_strategy_profiles.sql',
  '202611110002_binance_protection_lifecycle.sql',
  '202611110003_binance_credential_environment_confirmation.sql',
  '202611110004_admin_binance_demo_testing.sql',
  '202611110005_admin_binance_demo_rpc_grant.sql',
  '202611140001_password_recovery.sql',
];

export const EXPECTED_VERIFICATION_FILES = EXPECTED_MIGRATIONS.map((name) => name);

const migrationPattern = /^(\d{12})_.+\.sql$/;
const localDatabaseVersions = EXPECTED_MIGRATIONS.map((name) => name.slice(0, 12));

export function queryLocalMigrationStatus(run = spawnSync) {
  const expectedVersions = localDatabaseVersions.map((version) => `'${version}'`).join(', ');
  const sql = [
    'BEGIN READ ONLY;',
    `SELECT COALESCE(json_agg(version::text ORDER BY version::text), '[]'::json)::text`,
    'FROM supabase_migrations.schema_migrations',
    `WHERE version::text IN (${expectedVersions});`,
    'COMMIT;',
  ].join(' ');
  const result = run('psql', [
    '-X',
    '-q',
    '-A',
    '-t',
    '--no-password',
    '--set=ON_ERROR_STOP=1',
    '--host=127.0.0.1',
    '--port=54322',
    '--username=postgres',
    '--dbname=postgres',
    '--command',
    sql,
  ], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      PGPASSFILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  });

  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return {
      status: 'UNKNOWN',
      appliedVersions: [],
      missingVersions: localDatabaseVersions,
      message: 'Local database status is UNKNOWN; the localhost-only query did not succeed.',
    };
  }

  try {
    const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '[]';
    const appliedVersions = JSON.parse(output);
    if (!Array.isArray(appliedVersions) || !appliedVersions.every((version) => typeof version === 'string')) {
      throw new Error('Unexpected migration version result.');
    }
    const applied = new Set(appliedVersions);
    const missingVersions = localDatabaseVersions.filter((version) => !applied.has(version));
    return {
      status: missingVersions.length === 0 ? 'APPLIED' : 'MISSING',
      appliedVersions: localDatabaseVersions.filter((version) => applied.has(version)),
      missingVersions,
      message: missingVersions.length === 0
        ? 'Local database migration status: all expected migrations are applied.'
        : `Local database migration status: ${missingVersions.length} expected migration(s) are missing.`,
    };
  } catch {
    return {
      status: 'UNKNOWN',
      appliedVersions: [],
      missingVersions: localDatabaseVersions,
      message: 'Local database status is UNKNOWN; the localhost-only query returned an invalid result.',
    };
  }
}

export async function validateMigrations(directory, verificationDirectory = path.resolve(directory, '..', 'verification')) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  const verificationEntries = (await readdir(verificationDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  const versionFiles = new Map();
  const invalidNames = [];

  for (const name of entries) {
    const match = migrationPattern.exec(name);
    if (!match) continue;
    const files = versionFiles.get(match[1]) ?? [];
    files.push(name);
    versionFiles.set(match[1], files);
  }

  for (const name of entries) {
    if (name.startsWith('202') && !migrationPattern.test(name)) invalidNames.push(name);
  }

  const missing = EXPECTED_MIGRATIONS.filter((name) => !entries.includes(name));
  const missingVerificationFiles = EXPECTED_VERIFICATION_FILES.filter((name) => !verificationEntries.includes(name));
  const misplacedVerificationFiles = entries.filter((name) => /verification/i.test(name));
  const duplicateVersions = [...versionFiles.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([version, files]) => ({ version, files }));
  const dependencyOrder = EXPECTED_MIGRATIONS.map((name) => entries.indexOf(name));
  const orderValid = dependencyOrder.every((index, position) =>
    index >= 0 && (position === 0 || index > dependencyOrder[position - 1]),
  );

  return {
    valid: missing.length === 0 && missingVerificationFiles.length === 0 &&
      misplacedVerificationFiles.length === 0 && duplicateVersions.length === 0 &&
      invalidNames.length === 0 && orderValid,
    status: 'UNKNOWN',
    migrationStatusMessage: 'Migration status is UNKNOWN; no database was queried.',
    expected: EXPECTED_MIGRATIONS,
    missing,
    missingVerificationFiles,
    misplacedVerificationFiles,
    verificationFiles: verificationEntries,
    duplicateVersions,
    invalidNames,
    orderValid,
    files: entries,
  };
}

function printReport(report, localStatus = null) {
  console.log(`Migration files: ${report.valid ? 'VALID' : 'INVALID'}`);
  console.log(localStatus?.message ?? report.migrationStatusMessage);
  for (const name of report.expected) {
    const version = name.slice(0, 12);
    const status = localStatus
      ? localStatus.status === 'UNKNOWN'
        ? 'UNKNOWN'
        : localStatus.appliedVersions.includes(version) ? 'APPLIED' : 'MISSING'
      : 'UNKNOWN';
    console.log(`${report.files.includes(name) ? 'FOUND' : 'MISSING'} ${name} (database status: ${status})`);
  }
  for (const name of EXPECTED_VERIFICATION_FILES) {
    console.log(`${report.verificationFiles.includes(name) ? 'FOUND' : 'MISSING'} verification/${name} (read-only; never applied by migration tooling)`);
  }
  for (const duplicate of report.duplicateVersions) {
    console.error(`Duplicate version ${duplicate.version}: ${duplicate.files.join(', ')}`);
  }
  for (const name of report.invalidNames) console.error(`Invalid migration filename: ${name}`);
  for (const name of report.misplacedVerificationFiles) console.error(`Verification SQL must remain outside migrations/: ${name}`);
  for (const name of report.missingVerificationFiles) console.error(`Missing read-only verification SQL: ${name}`);
  if (!report.orderValid) console.error('Required migration dependency order is incorrect.');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.cwd(), 'supabase', 'migrations');
  try {
    const report = await validateMigrations(directory);
    const localStatus = process.argv.includes('--verify-local-db') ? queryLocalMigrationStatus() : null;
    printReport(report, localStatus);
    if (!report.valid || (localStatus && localStatus.status !== 'APPLIED')) process.exitCode = 1;
  } catch {
    console.error('Migration validation failed: migration directory could not be inspected.');
    process.exitCode = 1;
  }
}
