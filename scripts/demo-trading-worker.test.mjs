import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  acquireWorkerLock,
  assertDemoSafety,
  checkKillSwitch,
  loadCheckpoint,
  runWorkerLoop,
  saveCheckpoint,
  writeWorkerHeartbeat,
} from './demo-trading-worker.mjs';

const TEST_DIR = path.resolve('storage/test-demo-worker');

test.beforeEach(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DIR, { recursive: true });
});

test.afterEach(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

test('assertDemoSafety rejects real-money LIVE environment', () => {
  assert.throws(
    () => assertDemoSafety('LIVE'),
    /SECURITY VIOLATION: demo-trading-worker is strictly isolated to DEMO/,
  );
  assert.throws(
    () => assertDemoSafety('PRODUCTION_REAL_MONEY'),
    /SECURITY VIOLATION: demo-trading-worker is strictly isolated to DEMO/,
  );
  // DEMO and TESTNET must not throw
  assert.doesNotThrow(() => assertDemoSafety('DEMO'));
  assert.doesNotThrow(() => assertDemoSafety('TESTNET'));
});

test('acquireWorkerLock prevents duplicate process execution', async () => {
  const lock1 = await acquireWorkerLock(TEST_DIR, 1234);
  assert.ok(lock1);

  await assert.rejects(
    async () => acquireWorkerLock(TEST_DIR, 5678),
    /Another demo trading worker instance is already running/,
  );

  await lock1.release();

  // Now lock2 can be acquired
  const lock2 = await acquireWorkerLock(TEST_DIR, 5678);
  assert.ok(lock2);
  await lock2.release();
});

test('writeWorkerHeartbeat records valid JSON telemetry', async () => {
  await writeWorkerHeartbeat(TEST_DIR, { status: 'RUNNING', testField: 'telemetry_ok' });
  const raw = await fs.readFile(path.join(TEST_DIR, 'worker-heartbeat.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.status, 'RUNNING');
  assert.equal(parsed.testField, 'telemetry_ok');
  assert.equal(typeof parsed.timestamp, 'number');
  assert.equal(parsed.pid, process.pid);
});

test('checkpoint persistence saves and restores cursor state', async () => {
  const initial = await loadCheckpoint(TEST_DIR);
  assert.equal(initial, null);

  await saveCheckpoint(TEST_DIR, { cycleCount: 5, cursor: 70, totalTradesExecuted: 12 });
  const restored = await loadCheckpoint(TEST_DIR);
  assert.equal(restored.cycleCount, 5);
  assert.equal(restored.cursor, 70);
  assert.equal(restored.totalTradesExecuted, 12);
});

test('checkKillSwitch detects file and environment triggers', async () => {
  const clean = await checkKillSwitch(TEST_DIR);
  assert.equal(clean.triggered, false);

  // File trigger
  await fs.writeFile(path.join(TEST_DIR, 'kill-switch'), 'STOP');
  const triggeredFile = await checkKillSwitch(TEST_DIR);
  assert.equal(triggeredFile.triggered, true);
  assert.match(triggeredFile.reason, /Emergency kill switch file present/);

  await fs.unlink(path.join(TEST_DIR, 'kill-switch'));

  // Environment trigger
  process.env.SMARTEXIT_EMERGENCY_STOP = 'true';
  const triggeredEnv = await checkKillSwitch(TEST_DIR);
  assert.equal(triggeredEnv.triggered, true);
  assert.match(triggeredEnv.reason, /SMARTEXIT_EMERGENCY_STOP=true/);
  delete process.env.SMARTEXIT_EMERGENCY_STOP;
});

test('runWorkerLoop executes successfully in single-cycle mode', async () => {
  await runWorkerLoop({
    storageDir: TEST_DIR,
    environment: 'DEMO',
    once: true,
  });

  const heartbeat = JSON.parse(await fs.readFile(path.join(TEST_DIR, 'worker-heartbeat.json'), 'utf8'));
  assert.equal(heartbeat.status, 'STOPPED');
  assert.equal(heartbeat.reason, 'Completed single cycle');
  assert.equal(heartbeat.loopCount, 1);

  const checkpoint = await loadCheckpoint(TEST_DIR);
  assert.equal(checkpoint.cycleCount, 1);
  assert.equal(checkpoint.cursor, 35);
});
