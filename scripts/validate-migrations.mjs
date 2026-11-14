import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_MIGRATIONS = [
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

function printReport(report) {
  console.log(`Migration files: ${report.valid ? 'VALID' : 'INVALID'}`);
  console.log(report.migrationStatusMessage);
  for (const name of report.expected) {
    console.log(`${report.files.includes(name) ? 'FOUND' : 'MISSING'} ${name} (database status: UNKNOWN)`);
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
    printReport(report);
    if (!report.valid) process.exitCode = 1;
  } catch {
    console.error('Migration validation failed: migration directory could not be inspected.');
    process.exitCode = 1;
  }
}
