import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { parseHistoricalKlines, readHistoricalFunding } from './replay-scanner-archive.mjs';

const MiB = 1024 * 1024;
const symbols = ['BTCUSDT', 'ETHUSDT'];
const intervals = { '5m': 300_000, '15m': 900_000 };
const months = ['2026-07', '2026-08', '2026-09'];
const boundaries = ['2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function readLocalFile(filename, limit) {
  const info = lstatSync(filename);
  if (!info.isFile() || info.size > limit) throw new Error('Input must be a bounded regular file.');
  const bytes = readFileSync(filename);
  if (bytes.length > limit) throw new Error('Input exceeds its size limit.');
  return bytes;
}

function localDirectory(directory) {
  if (!path.isAbsolute(directory) || /^[\\/]{2}/.test(directory)) throw new Error('Use a local absolute directory.');
  const resolved = realpathSync(directory);
  if (/^[\\/]{2}/.test(resolved) || !lstatSync(resolved).isDirectory()) throw new Error('Use a local directory.');
  return resolved;
}

export function unpackArchiveCsv(zip, csvName) {
  // Only standard single-file ZIP archives are needed. Do not materialize arbitrary entries.
  if (zip.length < 98) throw new Error('Archive does not contain one standard ZIP entry.');
  let end = zip.length - 22;
  const minimum = Math.max(0, end - 65_535);
  for (; end >= minimum; end--) {
    if (zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length) break;
  }
  if (end < minimum || zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0 ||
      zip.readUInt16LE(end + 8) !== 1 || zip.readUInt16LE(end + 10) !== 1) {
    throw new Error('Archive must contain exactly one file on a single ZIP disk.');
  }
  const central = zip.readUInt32LE(end + 16);
  const centralLength = zip.readUInt32LE(end + 12);
  if (centralLength < 46 || centralLength !== end - central || zip.readUInt32LE(central) !== 0x02014b50) {
    throw new Error('Invalid ZIP central directory.');
  }
  const flags = zip.readUInt16LE(central + 8);
  const method = zip.readUInt16LE(central + 10);
  const checksum = zip.readUInt32LE(central + 16);
  const compressedSize = zip.readUInt32LE(central + 20);
  const size = zip.readUInt32LE(central + 24);
  const nameLength = zip.readUInt16LE(central + 28);
  const extraLength = zip.readUInt16LE(central + 30);
  const commentLength = zip.readUInt16LE(central + 32);
  if ((flags & ~0x080e) !== 0 || ![0, 8].includes(method) || size < 1 || size > 16 * MiB ||
      compressedSize < 1 || compressedSize > central || zip.readUInt16LE(central + 34) !== 0 ||
      zip.readUInt32LE(central + 42) !== 0 || centralLength !== 46 + nameLength + extraLength + commentLength ||
      zip.toString('utf8', central + 46, central + 46 + nameLength) !== csvName) {
    throw new Error('Archive entry name, compression, flags or size does not match the approved CSV.');
  }
  if (zip.readUInt32LE(0) !== 0x04034b50 || zip.readUInt16LE(6) !== flags ||
      zip.readUInt16LE(8) !== method || zip.readUInt16LE(26) !== nameLength ||
      zip.toString('utf8', 30, 30 + nameLength) !== csvName) {
    throw new Error('ZIP local and central entries disagree.');
  }
  const offset = 30 + nameLength + zip.readUInt16LE(28);
  const compressedEnd = offset + compressedSize;
  if (flags & 8) {
    let descriptor = compressedEnd;
    if (central - descriptor === 16 && zip.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4;
    if (central - descriptor !== 12 || zip.readUInt32LE(descriptor) !== checksum ||
        zip.readUInt32LE(descriptor + 4) !== compressedSize || zip.readUInt32LE(descriptor + 8) !== size) {
      throw new Error('Invalid ZIP data descriptor.');
    }
  } else if (compressedEnd !== central || zip.readUInt32LE(14) !== checksum ||
      zip.readUInt32LE(18) !== compressedSize || zip.readUInt32LE(22) !== size) {
    throw new Error('ZIP local sizes or checksum do not match.');
  }
  const compressed = zip.subarray(offset, compressedEnd);
  const csv = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: size });
  if (csv.length !== size || crc32(csv) !== checksum) throw new Error('Extracted CSV failed ZIP integrity checks.');
  return csv;
}

function checkedZip(source, filename) {
  const checksum = readLocalFile(path.join(source, `${filename}.CHECKSUM`), 512).toString('utf8').trim();
  const fields = /^([a-fA-F0-9]{64})[ \t]+\*?([A-Za-z0-9_.-]+)$/.exec(checksum);
  if (fields?.[2] !== filename) throw new Error(`Checksum must name ${filename}.`);
  const zip = readLocalFile(path.join(source, filename), 8 * MiB);
  const sha256 = digest(zip);
  if (sha256 !== fields[1].toLowerCase()) throw new Error(`Archive checksum mismatch for ${filename}.`);
  return { zip, sha256 };
}

export function prepareScannerArchives(sourceDir, outputDir, evidencePath) {
  const source = localDirectory(sourceDir);
  if (!path.isAbsolute(outputDir) || /^[\\/]{2}/.test(outputDir)) throw new Error('Use a local absolute output directory.');
  const output = path.join(localDirectory(path.dirname(outputDir)), path.basename(outputDir));
  if (path.relative(source, output) === '') throw new Error('Output must be a new directory.');
  const evidenceFile = path.resolve(evidencePath);
  const evidenceDirectory = path.dirname(evidenceFile);
  if (process.platform === 'win32' ? evidenceDirectory.toLowerCase() !== source.toLowerCase() : evidenceDirectory !== source) {
    throw new Error('Place the eligibility evidence JSON beside the archives.');
  }
  const evidence = JSON.parse(readLocalFile(evidenceFile, 16 * 1024));
  const { instruments, startingEquity, tradeNotional } = evidence;
  if (!Array.isArray(instruments) || instruments.length !== symbols.length ||
      !Number.isFinite(startingEquity) || !Number.isFinite(tradeNotional) || tradeNotional <= 0 ||
      tradeNotional * symbols.length > startingEquity) throw new Error('Invalid eligibility evidence or simulation inputs.');
  const outputFiles = [];
  let zipBytes = 0, csvBytes = 0;
  const reviewedInstruments = symbols.map(symbol => {
    const entries = instruments.filter(item => item?.symbol === symbol);
    const item = entries[0];
    const validUtc = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value;
    if (entries.length !== 1 || !validUtc(item.eligibleFrom) || !validUtc(item.eligibleThrough) ||
        Date.parse(item.eligibleFrom) > Date.parse(boundaries[0]) || Date.parse(item.eligibleThrough) < Date.parse(boundaries.at(-1)) ||
        typeof item.provenance !== 'string' || !item.provenance.trim() || item.provenance.length > 200) {
      throw new Error(`Complete dated eligibility evidence is required for ${symbol}.`);
    }
    const files = Object.fromEntries(Object.entries(intervals).map(([timeframe, interval]) => [timeframe, months.map((month, index) => {
      const base = `${symbol}-${timeframe}-${month}`;
      const archive = `${base}.zip`;
      const file = `${base}.csv`;
      const { zip, sha256: archiveSha256 } = checkedZip(source, archive);
      zipBytes += zip.length;
      if (zipBytes > 64 * MiB) throw new Error('Archive aggregate exceeds its compressed file limit.');
      const csv = unpackArchiveCsv(zip, file);
      csvBytes += csv.length;
      if (csvBytes > 64 * MiB) throw new Error('Archive aggregate exceeds its extracted file limit.');
      const bars = parseHistoricalKlines(csv, interval);
      if (bars[0]?.openTime !== Date.parse(boundaries[index]) ||
          bars.at(-1)?.closeTime !== Date.parse(boundaries[index + 1]) - 1) {
        throw new Error(`Candle coverage does not match ${month}.`);
      }
      outputFiles.push([file, csv]);
      return { file, sha256: digest(csv), archive, archiveSha256 };
    })]));
    let funding = null;
    if (item.funding !== undefined) {
      const fundingFile = `${symbol}-funding.json`;
      const bytes = readLocalFile(path.join(source, fundingFile), MiB);
      funding = readHistoricalFunding(source, symbol, item.funding);
      if (digest(bytes) !== funding.evidence.sha256) throw new Error('Funding file changed during preparation.');
      outputFiles.push([fundingFile, bytes]);
    }
    return { symbol, eligibleFrom: item.eligibleFrom, eligibleThrough: item.eligibleThrough,
      provenance: item.provenance, files, ...(funding ? { funding: funding.evidence } : {}) };
  });
  const [trainingStart, validationStart, testStart, end] = boundaries;
  const manifest = { trainingStart, validationStart, testStart, end, startingEquity, tradeNotional,
    instruments: reviewedInstruments };
  mkdirSync(output);
  for (const [name, contents] of outputFiles) writeFileSync(path.join(output, name), contents, { flag: 'wx' });
  const manifestPath = path.join(output, 'scanner-archive-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { manifestPath, archives: symbols.length * months.length * Object.keys(intervals).length, zipBytes, csvBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    console.error('Usage: node scripts/prepare-scanner-archives.mjs <absolute-input-directory> <new-absolute-output-directory> <eligibility-evidence.json>');
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(prepareScannerArchives(...args), null, 2));
    } catch (error) {
      console.error(`Offline archive preparation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      process.exitCode = 1;
    }
  }
}
