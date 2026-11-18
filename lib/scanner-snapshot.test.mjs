import assert from 'node:assert/strict';
import test from 'node:test';
import { savedScannerCandidate, scannerSyncIsRecent } from './scanner-snapshot.ts';

const now = Date.parse('2026-11-19T00:00:00Z');
const recent = new Date(now - 60_000).toISOString();
const saved = { symbol: 'BTCUSDT', status: 'READY', side: 'LONG', price: 100, priceChangePercent24h: 1,
  lastCandleCloseAt: recent, warnings: [], setup: { entryPrice: 100 } };

test('stale saved scans cannot expose actionable entries or pretend cached prices are current', () => {
  const result = savedScannerCandidate(saved, '2026-11-15T00:00:00Z', 1800, now);
  assert.equal(result.status, 'STALE');
  assert.equal(result.side, 'WAIT');
  assert.equal(result.setup, null);
  assert.equal(result.price, null);
  assert.equal(result.priceChangePercent24h, null);
  assert.equal(saved.setup.entryPrice, 100);
});
test('invalid/future timestamps and old candles fail closed even with recently saved rows', () => {
  for (const timestamp of ['bad', new Date(now + 1000).toISOString()]) {
    assert.equal(savedScannerCandidate(saved, timestamp, 1800, now).status, 'STALE');
  }
  for (const lastCandleCloseAt of [null, 'bad', '2026-11-15T00:00:00Z', new Date(now + 1000).toISOString()]) {
    assert.equal(savedScannerCandidate({ ...saved, lastCandleCloseAt }, recent, 1800, now).setup, null);
  }
});
test('recent saved data retains its measured values without resurrecting unavailable or stale scans', () => {
  assert.equal(savedScannerCandidate(saved, recent, 1800, now).price, 100);
  for (const status of ['STALE', 'DATA_UNAVAILABLE']) {
    const result = savedScannerCandidate({ ...saved, status }, recent, 1800, now);
    assert.equal(result.status, status);
    assert.equal(result.setup, null);
  }
});

test('an unchanged successful response loses actionable data when the client clock crosses its freshness limit', () => {
  const received = savedScannerCandidate(saved, recent, 1800, now);
  const beforeExpiry = savedScannerCandidate(received, received.scannedAt, 1800, now + 1_740_000);
  assert.equal(beforeExpiry.status, 'READY');
  assert.equal(beforeExpiry.setup.entryPrice, 100);
  const afterExpiry = savedScannerCandidate(received, received.scannedAt, 1800, now + 1_740_001);
  assert.equal(afterExpiry.status, 'STALE');
  assert.equal(afterExpiry.side, 'WAIT');
  assert.equal(afterExpiry.setup, null);
  assert.equal(afterExpiry.price, null);
  assert.equal(afterExpiry.priceChangePercent24h, null);
  assert.equal(received.status, 'READY');
  assert.equal(received.setup.entryPrice, 100);
});
test('scanner sync health rejects stale, malformed and future timestamps', () => {
  assert.equal(scannerSyncIsRecent(recent, now), true);
  for (const time of ['bad', '2026-11-15T00:00:00Z', new Date(now + 1000)]) assert.equal(scannerSyncIsRecent(time, now), false);
});
