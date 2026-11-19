import assert from 'node:assert/strict';
import test from 'node:test';
import { addWatchSymbol } from './watchlist.ts';
test('temporary watchlists normalize/deduplicate symbols without modifying another account list', () => {
  const one = ['BTCUSDT'], two = ['ETHUSDT'];
  assert.deepEqual(addWatchSymbol(one, ' btcusdt '), one);
  assert.deepEqual(addWatchSymbol(one, '币usdt'), ['BTCUSDT','币USDT']);
  assert.deepEqual(two, ['ETHUSDT']); assert.deepEqual(one, ['BTCUSDT']);
  assert.throws(() => addWatchSymbol(one, '../tenant'), /valid/);
  assert.throws(() => addWatchSymbol(Array.from({ length: 50 }, (_, i) => `S${i}USDT`), 'BTCUSDT'), /50/);
});
