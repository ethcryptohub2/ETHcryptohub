import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadScannerArchives, scannerArchiveNames } from './download-scanner-archives.mjs';

test('archive acquisition is fixed, unsigned, and checksum-verified before writing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smartexit-archive-download-'));
  try {
    const body = 'synthetic archive bytes';
    const sha = createHash('sha256').update(body).digest('hex');
    const requests = [];
    const destination = path.join(root, 'download');
    const result = await downloadScannerArchives(destination, async (input, options) => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://data.binance.vision');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      const file = url.pathname.split('/').at(-1);
      requests.push(file);
      return new Response(file.endsWith('.CHECKSUM') ? `${sha}  ${file.slice(0, -9)}\n` : body);
    });
    assert.deepEqual(requests, scannerArchiveNames.flatMap(({ file }) => [`${file}.CHECKSUM`, file]));
    assert.equal(result.requests, 24);
    assert.equal((await readFile(path.join(destination, requests[1]), 'utf8')), body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider denial stops before the archive request and leaves no unverified file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smartexit-archive-denial-'));
  try {
    const destination = path.join(root, 'download');
    let requests = 0;
    await assert.rejects(downloadScannerArchives(destination, async () => {
      requests++;
      return new Response('denied', { status: 451 });
    }), /HTTP 451/);
    assert.equal(requests, 1);
    assert.deepEqual(await readdir(destination), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
