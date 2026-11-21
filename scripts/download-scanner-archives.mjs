import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const origin = 'https://data.binance.vision';
const maxBytes = 64 * 1024 * 1024;
const maxDuration = 10 * 60_000;

export const scannerArchiveNames = ['BTCUSDT', 'ETHUSDT'].flatMap(symbol =>
  ['5m', '15m'].flatMap(interval => ['2026-07', '2026-08', '2026-09'].map(month => ({
    symbol, interval, file: `${symbol}-${interval}-${month}.zip`,
  }))));

export async function downloadScannerArchives(destination, request = fetch) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS certificate verification must be enabled.');
  const deadline = AbortSignal.timeout(maxDuration);
  let bytesReceived = 0;
  let requests = 0;
  await mkdir(destination);
  async function download(url, limit) {
    deadline.throwIfAborted();
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(30_000)]);
    requests++;
    const response = await request(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Archive request stopped at HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        bytesReceived += value.byteLength;
        if (length > limit || bytesReceived > maxBytes) throw new Error('Archive download exceeded the byte limit.');
        chunks.push(value);
      }
      signal.throwIfAborted();
      return Buffer.concat(chunks, length);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  for (const { symbol, interval, file } of scannerArchiveNames) {
    const url = `${origin}/data/futures/um/monthly/klines/${symbol}/${interval}/${file}`;
    const checksum = await download(`${url}.CHECKSUM`, 1024);
    const match = /^([a-f0-9]{64})[ \t]+\*?([^\s]+)[ \t]*$/i.exec(checksum.toString('ascii').trim());
    if (!match || match[2] !== file) throw new Error(`Invalid checksum document for ${file}.`);
    const archive = await download(url, maxBytes);
    if (createHash('sha256').update(archive).digest('hex') !== match[1].toLowerCase()) {
      throw new Error(`Archive checksum mismatch for ${file}.`);
    }
    deadline.throwIfAborted();
    await writeFile(path.join(destination, file), archive, { flag: 'wx' });
    await writeFile(path.join(destination, `${file}.CHECKSUM`), checksum, { flag: 'wx' });
  }
  return { requests, bytesReceived, verifiedArchives: scannerArchiveNames.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--verify-only') {
    console.log(JSON.stringify({ requests: scannerArchiveNames.length * 2, maxBytes, maxDuration, sent: false }));
  } else if (args.length === 3 && args[0] === '--execute-approved' && args[1] === '--eligibility-confirmed' && path.isAbsolute(args[2])) {
    downloadScannerArchives(args[2])
      .then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  } else {
    console.error('Use --verify-only or --execute-approved --eligibility-confirmed <new absolute directory>.');
    process.exitCode = 1;
  }
}
