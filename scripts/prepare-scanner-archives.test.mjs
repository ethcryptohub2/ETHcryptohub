import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { prepareScannerArchives, unpackArchiveCsv } from './prepare-scanner-archives.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function zipEntry(name, csv, { descriptor = false } = {}) {
  const filename = Buffer.from(name);
  const compressed = deflateRawSync(csv);
  const crc = crc32(csv);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(descriptor ? 8 : 0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(filename.length, 26);
  const tail = Buffer.alloc(descriptor ? 16 : 0);
  if (descriptor) {
    tail.writeUInt32LE(0x08074b50);
    tail.writeUInt32LE(crc, 4);
    tail.writeUInt32LE(compressed.length, 8);
    tail.writeUInt32LE(csv.length, 12);
  } else {
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(csv.length, 22);
  }
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(descriptor ? 8 : 0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(csv.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + compressed.length + tail.length, 16);
  return Buffer.concat([local, filename, compressed, tail, central, filename, end]);
}

test('ZIP loader reads only the named CSV and rejects traversal names, malformed data, and multiple entries', () => {
  const content = Buffer.from('example\n');
  const archive = zipEntry('BTCUSDT-5m-2026-07.csv', content, { descriptor: true });
  assert.deepEqual(unpackArchiveCsv(archive, 'BTCUSDT-5m-2026-07.csv'), content);
  assert.throws(() => unpackArchiveCsv(zipEntry('../malicious.csv', content), 'malicious.csv'), /entry name/);
  const malformed = Buffer.from(archive);
  malformed[30 + 'BTCUSDT-5m-2026-07.csv'.length] ^= 255;
  assert.throws(() => unpackArchiveCsv(malformed, 'BTCUSDT-5m-2026-07.csv'));
  const multi = Buffer.from(archive);
  multi.writeUInt16LE(2, multi.length - 12);
  assert.throws(() => unpackArchiveCsv(multi, 'BTCUSDT-5m-2026-07.csv'), /exactly one/);
});

test('offline acquisition validates all 12 archives before writing a replay-ready manifest', t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'prepare-scanner-archives-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const source = path.join(folder, 'input');
  const output = path.join(folder, 'reviewed');
  mkdirSync(source);
  const boundaries = ['2026-07', '2026-08', '2026-09', '2026-10'].map(month => month + '-01T00:00:00Z');
  const instruments = ['BTCUSDT', 'ETHUSDT'].map(symbol => ({
    symbol, eligibleFrom: boundaries[0], eligibleThrough: boundaries.at(-1), provenance: 'Synthetic tests only',
  }));
  const funding = JSON.stringify([{ timestamp: Date.parse(boundaries[1]), markPrice: 101, rate: 0.0001 }]);
  instruments[0].funding = { file: 'BTCUSDT-funding.json', sha256: digest(funding),
    from: boundaries[0], through: boundaries.at(-1), provenance: 'Synthetic settlements only' };
  writeFileSync(path.join(source, instruments[0].funding.file), funding);
  const evidence = path.join(source, 'eligibility.json');
  writeFileSync(evidence, JSON.stringify({ instruments, startingEquity: 5000, tradeNotional: 1000 }));
  for (const { symbol } of instruments) {
    for (const minutes of [5, 15]) {
      const interval = minutes * 60_000;
      for (let index = 0; index < 3; index++) {
        const start = Date.parse(boundaries[index]);
        const stop = Date.parse(boundaries[index + 1]);
        const base = `${symbol}-${minutes}m-${boundaries[index].slice(0, 7)}`;
        const csv = Buffer.from(Array.from({ length: (stop - start) / interval }, (_, i) => {
          const open = start + i * interval;
          return [open, 100, 101, 99, 100, 1000, open + interval - 1, 100000, 100, 500, 50000, 0].join(',');
        }).join('\n'));
        const archive = zipEntry(`${base}.csv`, csv);
        const file = `${base}.zip`;
        writeFileSync(path.join(source, file), archive);
        writeFileSync(path.join(source, file + '.CHECKSUM'), `${digest(archive)}  ${file}\n`);
      }
    }
  }
  const last = path.join(source, 'ETHUSDT-15m-2026-09.zip.CHECKSUM');
  const original = readFileSync(last);
  writeFileSync(last, `${'0'.repeat(64)}  ETHUSDT-15m-2026-09.zip\n`);
  assert.throws(() => prepareScannerArchives(source, output, evidence), /checksum mismatch/);
  assert.equal(existsSync(output), false);
  writeFileSync(last, original);
  const report = prepareScannerArchives(source, output, evidence);
  assert.equal(report.archives, 12);
  const manifest = JSON.parse(readFileSync(report.manifestPath));
  const [entry] = manifest.instruments[0].files['5m'];
  assert.equal(digest(readFileSync(path.join(output, entry.file))), entry.sha256);
  assert.equal(digest(readFileSync(path.join(source, entry.archive))), entry.archiveSha256);
  assert.deepEqual(manifest.instruments[0].funding, instruments[0].funding);
  assert.equal(digest(readFileSync(path.join(output, instruments[0].funding.file))), instruments[0].funding.sha256);
  assert.throws(() => prepareScannerArchives(source, output, evidence), /EEXIST/);
});
