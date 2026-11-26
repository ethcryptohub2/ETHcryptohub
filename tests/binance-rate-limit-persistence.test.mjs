import test from 'node:test';
import assert from 'node:assert/strict';
import { binanceRateLimiter } from '../lib/binance-rate-limit.ts';

test('BinanceRateLimitCoordinator persists and hydrates active 418 cooldown across simulated restarts', async () => {
  binanceRateLimiter.reset();
  let persistedRecord = null;
  const now = Date.now();

  binanceRateLimiter.registerPersistence({
    load: async () => persistedRecord,
    save: async (status) => {
      persistedRecord = status;
    },
  });

  binanceRateLimiter.trip(418, '300', 'IP banned until 1795932271334', now);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(persistedRecord);
  assert.equal(persistedRecord.state, 'OPEN');
  assert.equal(persistedRecord.statusCode, 418);

  // Simulate process restart by resetting in-memory state and creating a fresh hydration check
  const saved = { ...persistedRecord };
  binanceRateLimiter.reset();
  assert.equal(binanceRateLimiter.getStatus(now).state, 'CLOSED');

  // Re-register persistence and hydrate
  binanceRateLimiter.registerPersistence({
    load: async () => saved,
    save: async (status) => {
      persistedRecord = status;
    },
  });
  const hydrated = await binanceRateLimiter.hydrate(now + 1000);
  assert.equal(hydrated.state, 'OPEN');
  assert.equal(hydrated.statusCode, 418);
  assert.equal(hydrated.cooldownUntil, saved.cooldownUntil);

  binanceRateLimiter.reset();
});
