import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EXPECTED_MIGRATIONS,
  EXPECTED_VERIFICATION_FILES,
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
    const incorrectlyVersioned = EXPECTED_MIGRATIONS.map((name, index) =>
      index === 1 ? name.replace('202611100002', '202611100000') : name,
    );
    for (const name of incorrectlyVersioned) await writeFile(path.join(directory, name), '');
    for (const name of EXPECTED_VERIFICATION_FILES) await writeFile(path.join(verificationDirectory, name), '-- read only');
    const report = await validateMigrations(directory, verificationDirectory);
    assert.equal(report.valid, false);
    assert.ok(report.missing.includes(EXPECTED_MIGRATIONS[1]));
  });
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
