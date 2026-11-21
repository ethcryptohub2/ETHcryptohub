import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fundingForFill, readHistoricalFunding, readHistoricalKlines, replayHistoricalArchive } from './replay-scanner-archive.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const day = 86_400_000;
const trainingStart = '2026-07-01T00:00:00Z';
const start = Date.parse(trainingStart);

function csv(interval, count) {
  return Array.from({ length: count }, (_, index) => {
    const open = start + index * interval;
    return [open, 100, 101, 99, 100, 1000, open + interval - 1, 100000, 100, 500, 50000, 0].join(',');
  }).join('\n');
}

test('funding evidence must be checksum-pinned, ordered, and cover the unambiguous fill interval', t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'scanner-funding-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = 'BTCUSDT-funding.json';
  const interval = 300_000;
  const event = { timestamp: start + interval * 2, markPrice: 100, rate: 0.0001 };
  const content = JSON.stringify([event]);
  writeFileSync(path.join(folder, file), content);
  const metadata = { file, sha256: hash(content), from: trainingStart, through: '2026-07-02T00:00:00Z',
    provenance: 'Synthetic settlement fixture only' };
  const funding = readHistoricalFunding(folder, 'BTCUSDT', metadata);
  assert.deepEqual(fundingForFill(funding, start + interval - 1, start + 4 * interval - 1, interval), [event]);
  assert.equal(fundingForFill(funding, start + 3 * interval - 1, start + 4 * interval - 1, interval), null);
  assert.equal(fundingForFill(funding, start + interval - 1, start + day, interval), null);
  assert.equal(fundingForFill(null, start + interval - 1, start + day, interval), null);
  assert.throws(() => readHistoricalFunding(folder, 'BTCUSDT', { ...metadata, sha256: '0'.repeat(64) }), /checksum mismatch/);
  const duplicate = JSON.stringify([event, event]);
  writeFileSync(path.join(folder, file), duplicate);
  assert.throws(() => readHistoricalFunding(folder, 'BTCUSDT', { ...metadata, sha256: hash(duplicate) }), /duplicate/);
});

test('read-only archive replay applies both strategies in validation and test without fabricated signals', async t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'scanner-archive-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const files = {};
  for (const minutes of [5, 15]) {
    const interval = minutes * 60_000;
    const content = csv(interval, (5 * day) / interval);
    const file = `BTCUSDT-${minutes}m.csv`;
    writeFileSync(path.join(folder, file), content);
    files[`${minutes}m`] = [{ file, sha256: hash(content) }];
  }
  const manifest = { trainingStart, validationStart: '2026-07-04T00:00:00Z',
    testStart: '2026-07-05T00:00:00Z', end: '2026-07-06T00:00:00Z',
    startingEquity: 5000, tradeNotional: 1000, instruments: [{ symbol: 'BTCUSDT',
      eligibleFrom: trainingStart, eligibleThrough: '2026-07-06T00:00:00Z', provenance: 'Synthetic fixture only', files }] };
  const manifestPath = path.join(folder, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const report = await replayHistoricalArchive(manifestPath);
  assert.equal(report.simulation, true);
  assert.equal(report.realExchangePerformance, false);
  assert.match(report.assumptions.pricing, /Prior fully closed/);
  assert.deepEqual(report.segments.map(({ name, strategy, counts }) => [name, strategy, counts.wait]), [
    ['validation', 'STANDARD', 96], ['validation', 'HIGH_RISK', 288],
    ['test', 'STANDARD', 96], ['test', 'HIGH_RISK', 288],
  ]);
  assert.ok(report.segments.every(segment => segment.counts.qualified === 0 && segment.accountedTrades === 0));

  const input = path.join(folder, files['5m'][0].file);
  assert.throws(() => readHistoricalKlines(input, '0'.repeat(64), 300_000), /checksum mismatch/);
  const gaps = csv(300_000, 3).split('\n').filter((_, index) => index !== 1).join('\n');
  writeFileSync(input, gaps);
  assert.throws(() => readHistoricalKlines(input, hash(gaps), 300_000), /discontinuous/);
});
