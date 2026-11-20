import watchlist from '../../deploy/market-worker/soak-watchlist.json' with { type: 'json' };

const endpoint = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const maxBytes = 1024 * 1024;
const maxAgeMs = 5000;
const selected = new Set(watchlist.symbols);

/** A ticker snapshot has no book/trade continuity and is never ingested as a MarketObservation. */
export async function fetchPublicRestSnapshot(signal: AbortSignal, transport: typeof fetch = fetch) {
  const response = await transport(endpoint, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    credentials: 'omit',
    signal,
    headers: { accept: 'application/json' },
  });
  const usedWeight = Number(response.headers.get('x-mbx-used-weight-1m'));
  if (response.status !== 200 || usedWeight >= 300 || !response.body) {
    await response.body?.cancel();
    return { state: 'UNAVAILABLE' as const, status: response.status, quotes: [] };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Public REST snapshot exceeds the byte limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const rows: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(rows) || rows.length > 5000) throw new Error('Invalid public REST snapshot.');
  const receivedAt = Date.now();
  const quotes = new Map<string, { symbol: string; price: number; observedAt: number }>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || !selected.has(row.symbol)) continue;
    if (seen.has(row.symbol)) throw new Error('Duplicate public REST snapshot symbol.');
    seen.add(row.symbol);
    const observedAt = row.closeTime;
    const price = typeof row.lastPrice === 'string' ? Number(row.lastPrice) : NaN;
    if (Number.isSafeInteger(observedAt) && observedAt <= receivedAt && receivedAt - observedAt <= maxAgeMs &&
      Number.isFinite(price) && price > 0) quotes.set(row.symbol, { symbol: row.symbol, price, observedAt });
  }
  return {
    state: quotes.size === selected.size ? 'SNAPSHOT' as const : 'INCOMPLETE' as const,
    status: response.status,
    receivedAt,
    quotes: watchlist.symbols.flatMap(symbol => quotes.get(symbol) ?? []),
  };
}
