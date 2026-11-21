import type { AdminDemoProvider } from './admin-demo-provider-contract';

const readTargets = {
  BINANCE: ['https://demo-fapi.binance.com', '/fapi/v3/account', '/fapi/v1/exchangeInfo'],
  BYBIT: ['https://api-demo.bybit.com', '/v5/account/wallet-balance', '/v5/market/instruments-info'],
  OKX: ['https://openapi.okx.com', '/api/v5/account/config', '/api/v5/account/balance', '/api/v5/public/instruments'],
  GATE: ['https://api-testnet.gateapi.io', '/api/v4/futures/usdt/accounts', '/api/v4/futures/usdt/contracts'],
} as const;

export function supportsApprovedDemoRead(provider: AdminDemoProvider): provider is keyof typeof readTargets {
  return Object.hasOwn(readTargets, provider);
}

export function createApprovedDemoReadTransport(
  provider: keyof typeof readTargets, signal: AbortSignal, upstream = fetch, observedStatus?: (value: number) => void,
): typeof fetch {
  const [origin, ...paths] = readTargets[provider];
  const allowed = new Set<string>(paths);
  const stop = new AbortController();
  const deadline = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(12_000)]);
  let calls = 0;
  return async (input, init) => {
    if (typeof input !== 'string' && !(input instanceof URL)) throw new Error('Invalid Demo read request.');
    const target = new URL(input);
    if (target.origin !== origin || target.username || target.password || target.hash || !allowed.has(target.pathname) ||
        (init?.method ?? 'GET') !== 'GET' || init?.body != null) throw new Error('Demo read target is outside the approved scope.');
    const headers = new Headers(init?.headers);
    if (provider === 'OKX' && target.pathname.startsWith('/api/v5/account/') && headers.get('x-simulated-trading') !== '1') {
      throw new Error('OKX account reads require Demo simulation mode.');
    }
    deadline.throwIfAborted();
    if (calls >= 3) throw new Error('Demo read request budget exhausted.');
    calls++;
    const upstreamSignal = AbortSignal.any([deadline, AbortSignal.timeout(4_000), ...(init?.signal ? [init.signal] : [])]);
    try {
      const response = await upstream(target, {
        method: 'GET', headers, signal: upstreamSignal, cache: 'no-store', redirect: 'manual', credentials: 'omit',
      });
      observedStatus?.(response.status);
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Demo provider returned HTTP ${response.status}.`);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          upstreamSignal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw new Error('Demo provider response exceeded the byte limit.');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return new Response(new Uint8Array(Buffer.concat(chunks)), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      stop.abort();
      throw error;
    }
  };
}
