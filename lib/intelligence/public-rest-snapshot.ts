import watchlist from '../../deploy/market-worker/soak-watchlist.json' with { type: 'json' };

const endpoint = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const maxBytes = 1024 * 1024;
const maxAgeMs = 5000;
const selected = new Set(watchlist.symbols);

/** A ticker snapshot has no book/trade continuity and is never ingested as a MarketObservation. */
export async function fetchPublicRestSnapshot(signal: AbortSignal, transport: typeof fetch = fetch) {
  const started = performance.now();
  const response = await transport(endpoint, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    credentials: 'omit',
    signal,
    headers: { accept: 'application/json' },
  });
  const weightHeader = response.headers.get('x-mbx-used-weight-1m');
  const usedWeight = weightHeader !== null && /^\d+$/.test(weightHeader) ? Number(weightHeader) : NaN;
  if (response.status !== 200 || !Number.isSafeInteger(usedWeight) || usedWeight >= 300 || !response.body) {
    await response.body?.cancel().catch(() => {});
    const reasons: Record<number, string> = { 403: 'PROVIDER_DENIED', 418: 'PROVIDER_RATE_LIMIT',
      429: 'PROVIDER_RATE_LIMIT', 451: 'PROVIDER_REGION_RESTRICTION' };
    const reason = response.status === 200 ? 'WEIGHT_GUARD_OR_MISSING_BODY' : reasons[response.status] ?? 'PROVIDER_HTTP_ERROR';
    return { state: 'UNAVAILABLE' as const, status: response.status, reason,
      providerLatencyMs: Math.round(performance.now() - started), quoteCount: 0, quotes: [] };
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
    providerLatencyMs: Math.round(performance.now() - started),
    quoteCount: quotes.size,
    receivedAt,
    quotes: watchlist.symbols.flatMap(symbol => quotes.get(symbol) ?? []),
  };
}
