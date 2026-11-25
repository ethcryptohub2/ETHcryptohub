process.env.WORKER_SKIP_ENV_FILE = 'true';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import {
  acquireDbLease,
  acquireWorkerLock,
  assertDemoSafety,
  checkKillSwitch,
  executeBusinessTick,
  isWorkerSafeMode,
  loadCheckpoint,
  runWorkerLoop,
  saveCheckpoint,
  writeWorkerHeartbeat,
} from './demo-trading-worker.mjs';

const TEST_DIR = path.resolve('storage/test-demo-worker');

function createMockLeaseTransport(options = {}) {
  const state = {
    current: options.initialLease ?? null,
    acquireCalls: 0,
    renewCalls: 0,
    releaseCalls: 0,
    lastRenewPayload: null,
  };
  return {
    state,
    mode: 'DB',
    leaseMod: {
      async acquireWorkerLease(info) {
        state.acquireCalls += 1;
        if (options.rejectAcquire) {
          return { ok: false, error: 'Another active worker holds the lease.' };
        }
        if (state.current && state.current.workerId !== info.workerId && state.current.status === 'ACTIVE' && Date.parse(state.current.expiresAt) > Date.now()) {
          return { ok: false, lease: state.current, error: `Another active worker (${state.current.workerId}) holds the lease.` };
        }
        state.current = { ...info, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString(), tickCount: 1, status: 'ACTIVE' };
        return { ok: true, lease: state.current };
      },
      async renewWorkerLease(info) {
        state.renewCalls += 1;
        state.lastRenewPayload = info;
        if (typeof options.renewShouldSucceed === 'function' && !options.renewShouldSucceed(state.renewCalls, info)) {
          return false;
        }
        if (!state.current || state.current.workerId !== info.workerId) return false;
        state.current = { ...state.current, ...info, status: (info.consecutiveFailures ?? 0) > 0 ? 'DEGRADED' : 'ACTIVE' };
        return true;
      },
      async releaseWorkerLease(workerId) {
        state.releaseCalls += 1;
        if (state.current && state.current.workerId === workerId) {
          state.current = { ...state.current, status: 'STOPPED' };
        }
      },
    },
  };
}

test.beforeEach(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DIR, { recursive: true });
});

test.afterEach(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  delete process.env.SMARTEXIT_EMERGENCY_STOP;
  delete process.env.WORKER_SAFE_MODE;
  delete process.env.DEMO_ORDER_DISPATCH_ENABLED;
});

test('assertDemoSafety rejects real-money LIVE and unknown environments', () => {
  assert.throws(
    () => assertDemoSafety('LIVE'),
    /SECURITY VIOLATION: demo-trading-worker is strictly isolated to DEMO/,
  );
  assert.throws(
    () => assertDemoSafety('PRODUCTION_REAL_MONEY'),
    /SECURITY VIOLATION: demo-trading-worker is strictly isolated to DEMO/,
  );
  assert.throws(
    () => assertDemoSafety('OTHER'),
    /SECURITY VIOLATION: demo-trading-worker is strictly isolated to DEMO/,
  );
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

test('checkpoint persistence saves and restores cursor and execution counters', async () => {
  const initial = await loadCheckpoint(TEST_DIR);
  assert.equal(initial, null);

  await saveCheckpoint(TEST_DIR, { cycleCount: 5, cursor: 175, totalTradesExecuted: 12 });
  const restored = await loadCheckpoint(TEST_DIR);
  assert.equal(restored.cycleCount, 5);
  assert.equal(restored.cursor, 175);
  assert.equal(restored.totalTradesExecuted, 12);
});

test('checkKillSwitch detects file and environment triggers', async () => {
  const clean = await checkKillSwitch(TEST_DIR);
  assert.equal(clean.triggered, false);

  await fs.writeFile(path.join(TEST_DIR, 'kill-switch'), 'STOP');
  const triggeredFile = await checkKillSwitch(TEST_DIR);
  assert.equal(triggeredFile.triggered, true);
  assert.match(triggeredFile.reason, /Emergency kill switch file present/);

  await fs.unlink(path.join(TEST_DIR, 'kill-switch'));

  process.env.SMARTEXIT_EMERGENCY_STOP = 'true';
  const triggeredEnv = await checkKillSwitch(TEST_DIR);
  assert.equal(triggeredEnv.triggered, true);
  assert.match(triggeredEnv.reason, /SMARTEXIT_EMERGENCY_STOP=true/);
});

test('SafeMode defaults to read-only and never invokes mutating reconciliation or automatic orders', async () => {
  assert.equal(isWorkerSafeMode({}, {}), true);

  let scanOptionsObserved = null;
  let mutatingReconcileCalled = 0;
  let readOnlyInspectCalled = 0;

  const res = await executeBusinessTick('DEMO', {
    safeMode: true,
    dependencies: {
      runSignalScan: async (_tf, opts) => {
        scanOptionsObserved = opts;
        return {
          scannedAt: '2026-11-25T18:00:00.000Z',
          completedAt: '2026-11-25T18:00:01.000Z',
          durationMs: 1000,
          batchSize: 35,
          cursor: 70,
          batchIndex: 3,
          totalBatches: 15,
          cycleId: 'CYCLE-1-FULL-RUN',
          candidates: 35,
          qualifiedCount: 2,
          newSignals: 1,
          timeframe: '15m',
          exchange: 'BINANCE',
        };
      },
      tradingExecution: {
        inspectDemoProtectionStatus: async () => {
          readOnlyInspectCalled += 1;
          return { openCount: 1, protectionFailures: 0, executedTotal: 4 };
        },
        reconcileBinanceDemoProtection: async () => {
          mutatingReconcileCalled += 1;
          return { processed: 0, results: [] };
        },
      },
    },
  });

  assert.equal(res.status, 'OK');
  assert.equal(res.safeMode, true);
  assert.deepEqual(scanOptionsObserved, { executeAutomaticTrades: false, deliverNotifications: false });
  assert.equal(readOnlyInspectCalled, 1);
  assert.equal(mutatingReconcileCalled, 0);
  assert.equal(res.cursor, 70);
  assert.equal(res.totalTradesExecuted, 4);
});

test('Dispatch mode enables automatic trades and integrates Binance protection reconciliation', async () => {
  let scanOptionsObserved = null;
  let mutatingReconcileCalled = 0;

  const res = await executeBusinessTick('DEMO', {
    safeMode: false,
    dependencies: {
      runSignalScan: async (_tf, opts) => {
        scanOptionsObserved = opts;
        return {
          scannedAt: '2026-11-25T18:00:00.000Z',
          completedAt: '2026-11-25T18:00:01.000Z',
          durationMs: 950,
          batchSize: 50,
          cursor: 100,
          batchIndex: 3,
          totalBatches: 11,
          cycleId: 'CYCLE-2-FULL-RUN',
          candidates: 50,
          qualifiedCount: 3,
          newSignals: 2,
          timeframe: '15m',
          exchange: 'BINANCE',
        };
      },
      tradingExecution: {
        reconcileBinanceDemoProtection: async () => {
          mutatingReconcileCalled += 1;
          return { processed: 1, results: [{ id: '10', status: 'PROTECTED' }] };
        },
        inspectDemoProtectionStatus: async () => ({ openCount: 1, protectionFailures: 0, executedTotal: 5 }),
      },
    },
  });

  assert.equal(res.status, 'OK');
  assert.deepEqual(scanOptionsObserved, { executeAutomaticTrades: true, deliverNotifications: true });
  assert.equal(mutatingReconcileCalled, 1);
  assert.equal(res.totalTradesExecuted, 5);
});

test('runWorkerLoop refuses startup when distributed DB lease is held by another worker', async () => {
  const leaseTransport = createMockLeaseTransport({
    initialLease: {
      workerId: 'aws-lightsail-worker-1',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  await assert.rejects(
    runWorkerLoop({
      storageDir: TEST_DIR,
      environment: 'DEMO',
      workerId: 'local-windows-worker-2',
      once: true,
      safeMode: true,
      requireDbLease: true,
      leaseTransport,
    }),
    /Another active worker/,
  );

  // Lock must be cleaned up when lease fails
  const lockFiles = await fs.readdir(TEST_DIR);
  assert.equal(lockFiles.includes('worker.lock'), false);
});

test('runWorkerLoop stops immediately if distributed DB lease is lost before a tick', async () => {
  let tickRuns = 0;
  const leaseTransport = createMockLeaseTransport({
    renewShouldSucceed: (renewCount) => renewCount === 1, // fails on pre-tick 2 renewal
  });

  await assert.rejects(
    runWorkerLoop({
      storageDir: TEST_DIR,
      environment: 'DEMO',
      workerId: 'worker-test-lease-loss',
      safeMode: true,
      requireDbLease: true,
      tickIntervalMs: 10,
      maxTicks: 3,
      leaseTransport,
      dependencies: {
        runSignalScan: async () => {
          tickRuns += 1;
          return {
            scannedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 5,
            batchSize: 35,
            cursor: 35,
            batchIndex: 1,
            totalBatches: 15,
            cycleId: 'CYCLE-1-FULL-RUN',
            candidates: 35,
            qualifiedCount: 0,
            newSignals: 0,
          };
        },
        tradingExecution: {
          inspectDemoProtectionStatus: async () => ({ openCount: 0, protectionFailures: 0, executedTotal: 0 }),
        },
      },
    }),
    /lease was lost/i,
  );

  assert.equal(tickRuns, 1);
  assert.equal(leaseTransport.state.releaseCalls, 1);
});

test('runWorkerLoop never masks failed business ticks as healthy and updates lease error state', async () => {
  const leaseTransport = createMockLeaseTransport();

  await assert.rejects(
    runWorkerLoop({
      storageDir: TEST_DIR,
      environment: 'DEMO',
      workerId: 'worker-test-failure',
      once: true,
      safeMode: true,
      requireDbLease: true,
      leaseTransport,
      dependencies: {
        runSignalScan: async () => {
          throw new Error('Simulated scanner failure');
        },
        tradingExecution: {
          inspectDemoProtectionStatus: async () => ({ openCount: 0, protectionFailures: 0, executedTotal: 0 }),
        },
      },
    }),
    /Simulated scanner failure/,
  );

  assert.equal(leaseTransport.state.lastRenewPayload.consecutiveFailures, 1);
  assert.match(leaseTransport.state.lastRenewPayload.lastError, /Simulated scanner failure/);
  const hb = JSON.parse(await fs.readFile(path.join(TEST_DIR, 'worker-heartbeat.json'), 'utf8'));
  assert.equal(hb.consecutiveFailures, 1);
});

test('runWorkerLoop executes successfully in single-cycle mocked SafeMode with real cursor & trade counts', async () => {
  const leaseTransport = createMockLeaseTransport();

  await runWorkerLoop({
    storageDir: TEST_DIR,
    environment: 'DEMO',
    workerId: 'worker-test-success',
    once: true,
    safeMode: true,
    requireDbLease: true,
    leaseTransport,
    dependencies: {
      runSignalScan: async () => ({
        scannedAt: '2026-11-25T18:00:00.000Z',
        completedAt: '2026-11-25T18:00:02.000Z',
        durationMs: 2000,
        batchSize: 35,
        cursor: 35,
        batchIndex: 2,
        totalBatches: 15,
        cycleId: 'CYCLE-1-FULL-RUN',
        candidates: 35,
        qualifiedCount: 1,
        newSignals: 5,
      }),
      tradingExecution: {
        inspectDemoProtectionStatus: async () => ({ openCount: 0, protectionFailures: 0, executedTotal: 2 }),
      },
    },
  });

  const heartbeat = JSON.parse(await fs.readFile(path.join(TEST_DIR, 'worker-heartbeat.json'), 'utf8'));
  assert.equal(heartbeat.status, 'STOPPED');
  assert.equal(heartbeat.reason, 'Completed single cycle');
  assert.equal(heartbeat.loopCount, 1);
  assert.equal(heartbeat.consecutiveFailures, 0);

  const checkpoint = await loadCheckpoint(TEST_DIR);
  assert.equal(checkpoint.cycleCount, 1);
  assert.equal(checkpoint.cursor, 35);
  // Must use actual executed trades (2), NOT newSignals (5)
  assert.equal(checkpoint.totalTradesExecuted, 2);
});

test('worker-health API and acquireDbLease reject hardcoded fallback secrets', async () => {
  const savedSecret = process.env.WORKER_SECRET;
  const savedCron = process.env.CRON_SECRET;
  const savedAppUrl = process.env.APP_URL;
  try {
    process.env.WORKER_SECRET = 'a'.repeat(32);
    delete process.env.CRON_SECRET;
    process.env.APP_URL = 'https://example.invalid';

    // Direct check of worker-health POST route rejects legacy hardcoded secret
    const routePath = path.resolve('app/api/admin/worker-health/route.ts');
    const compiled = ts.transpileModule(readFileSync(routePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const routeMod = new Module(routePath);
    routeMod.filename = routePath;
    routeMod.paths = Module._nodeModulePaths(path.dirname(routePath));
    const originalLoad = Module._load;
    try {
      Module._load = function load(request, parent, isMain) {
        if (request.endsWith('/lib/auth')) {
          return {
            AuthError: class extends Error { status = 403; },
            requireAdmin: async () => { throw new Error('Not admin'); },
            safeEqual: (a, b) => a === b,
          };
        }
        if (request.endsWith('/lib/worker-lease')) {
          return {
            getWorkerHealthStatus: async () => ({}),
            acquireWorkerLease: async () => ({ ok: true }),
            renewWorkerLease: async () => true,
            releaseWorkerLease: async () => {},
          };
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      routeMod._compile(compiled.outputText, routePath);
    } finally {
      Module._load = originalLoad;
    }

    const fakeReq = (secret) => ({
      headers: new Headers(secret ? { 'x-worker-secret': secret } : {}),
      json: async () => ({ action: 'acquire', workerId: 'w1' }),
    });

    const resHardcoded = await routeMod.exports.POST(fakeReq('staging-worker-daemon'));
    assert.equal(resHardcoded.status, 403);

    const resValid = await routeMod.exports.POST(fakeReq('a'.repeat(32)));
    assert.equal(resValid.status, 200);

    const missingTransport = await acquireDbLease({ workerId: 'w1', hostname: 'h', pid: 1, version: '1.0.0' }, { leaseTransport: { mode: 'NONE' } });
    assert.equal(missingTransport.ok, false);
  } finally {
    if (savedSecret === undefined) delete process.env.WORKER_SECRET;
    else process.env.WORKER_SECRET = savedSecret;
    if (savedCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedCron;
    if (savedAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = savedAppUrl;
  }
});
