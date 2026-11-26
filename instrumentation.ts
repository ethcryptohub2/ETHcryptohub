export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { ensureBinanceCooldownHydrated } = await import('./lib/binance-rate-limit-db');
      const cb = await ensureBinanceCooldownHydrated();
      const { startFiveMinuteScheduler } = await import('./lib/scanner-scheduler');
      startFiveMinuteScheduler();

      if (cb.state !== 'OPEN') {
        const { getEnabledScannerSymbols } = await import('./lib/scanner-coins');
        const { binanceWsKlineEngine } = await import('./lib/ws-kline-engine');
        const symbols = await getEnabledScannerSymbols().catch(() => []);
        if (symbols.length > 0) {
          binanceWsKlineEngine.start(symbols.slice(0, 180), '15m');
        }
      }
    } catch (err) {
      console.warn('[Instrumentation] Scanner boot initialization deferred:', err instanceof Error ? err.message : err);
    }
  }
}
