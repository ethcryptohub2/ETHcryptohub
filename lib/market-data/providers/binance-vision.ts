import { inflateRawSync } from 'node:zlib';
import type { NormalizedCandle, ProviderTimeframe } from '../provider-types';

const VISION_BASE_URL = 'https://data.binance.vision/data/futures/um/daily/klines';
const downloadedArchives = new Set<string>();

/**
 * Extracts the first file from a standard PKZIP buffer using Node's built-in zlib.
 */
export function extractFirstCsvFromZipBuffer(buffer: Buffer): string {
  // PKZIP local file header signature: 0x50 0x4b 0x03 0x04
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Invalid Binance Vision ZIP archive header.');
  }
  const compressionMethod = buffer.readUInt16LE(8);
  const compressedSize = buffer.readUInt32LE(18);
  const fileNameLength = buffer.readUInt16LE(26);
  const extraFieldLength = buffer.readUInt16LE(28);
  const dataOffset = 30 + fileNameLength + extraFieldLength;

  // If compressedSize is 0 (data descriptor bit 3 set), locate central directory / data descriptor
  let payloadSlice: Buffer;
  if (compressedSize > 0 && dataOffset + compressedSize <= buffer.length) {
    payloadSlice = buffer.subarray(dataOffset, dataOffset + compressedSize);
  } else {
    const ddIdx = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), dataOffset);
    const cdIdx = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), dataOffset);
    const endOffset = ddIdx > dataOffset ? ddIdx : cdIdx > dataOffset ? cdIdx : buffer.length;
    payloadSlice = buffer.subarray(dataOffset, endOffset);
  }

  if (compressionMethod === 0) {
    return payloadSlice.toString('utf8');
  }
  if (compressionMethod === 8) {
    return inflateRawSync(payloadSlice).toString('utf8');
  }
  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

export function parseBinanceVisionCsv(csvText: string): NormalizedCandle[] {
  const lines = csvText.split(/\r?\n/);
  const candles: NormalizedCandle[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('open_time')) continue;
    const cols = line.split(',');
    if (cols.length < 7) continue;
    const openTime = Number(cols[0]);
    const open = Number(cols[1]);
    const high = Number(cols[2]);
    const low = Number(cols[3]);
    const close = Number(cols[4]);
    const volume = Number(cols[5]);
    const closeTime = Number(cols[6]);
    const quoteVolume = cols.length >= 8 ? Number(cols[7]) : undefined;
    if (
      ![openTime, open, high, low, close, volume, closeTime].every(Number.isFinite) ||
      high < low ||
      close <= 0
    ) {
      continue;
    }
    candles.push({
      openTime,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: quoteVolume !== undefined && Number.isFinite(quoteVolume) ? quoteVolume : undefined,
      closeTime,
      isClosed: true,
    });
  }
  return candles.sort((a, b) => a.openTime - b.openTime);
}

export async function fetchBinanceVisionDailyArchive(
  symbol: string,
  timeframe: ProviderTimeframe,
  dateStr: string, // YYYY-MM-DD
  request: typeof fetch = globalThis.fetch,
): Promise<NormalizedCandle[]> {
  const upperSymbol = symbol.toUpperCase();
  const archiveKey = `${upperSymbol}:${timeframe}:${dateStr}`;
  if (downloadedArchives.has(archiveKey)) {
    return [];
  }

  const url = `${VISION_BASE_URL}/${upperSymbol}/${timeframe}/${upperSymbol}-${timeframe}-${dateStr}.zip`;
  const response = await request(url, {
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Binance Vision archive unavailable (${response.status}) for ${archiveKey}.`);
  }
  const arrayBuf = await response.arrayBuffer();
  const csv = extractFirstCsvFromZipBuffer(Buffer.from(arrayBuf));
  const candles = parseBinanceVisionCsv(csv);
  if (candles.length > 0) {
    downloadedArchives.add(archiveKey);
  }
  return candles;
}

export function resetBinanceVisionArchiveLog(): void {
  downloadedArchives.clear();
}
