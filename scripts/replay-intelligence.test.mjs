import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runOfflineReplay } from './replay-intelligence.mjs';

test('offline replay is runnable without any network, credentials, worker activation or invented performance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartexit-offline-replay-'));
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('Network is forbidden in offline replay.'); };
  try {
    const file = join(directory, 'events.json'); await writeFile(file, '[]');
    const result = await runOfflineReplay(file);
    assert.equal(result.simulation, true); assert.equal(result.realExchangePerformance, false);
    assert.equal(result.reports.STANDARD.completedTrades, 0);
    assert.equal(result.reports.HIGH_RISK.netExpectancy, null);
    await writeFile(file, '[{"type":"TRADE","at":2,"symbol":"BTCUSDT","price":1,"quantity":1},{"type":"TRADE","at":1,"symbol":"BTCUSDT","price":1,"quantity":1}]');
    await assert.rejects(runOfflineReplay(file), /ordered/);
    await assert.rejects(runOfflineReplay(file, { activateWorker: true }), /supported/);
  } finally {
    globalThis.fetch = previous;
    if (!resolve(directory).startsWith(resolve(join(tmpdir(), 'smartexit-offline-replay-')))) throw Error('Unsafe test cleanup path.');
    await rm(directory, { recursive: true, force: true });
  }
});
