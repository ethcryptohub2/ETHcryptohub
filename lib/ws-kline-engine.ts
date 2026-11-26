import { binanceRateLimiter } from './binance-rate-limit';
import { sharedCandleCache, type CachedCandle, type CandleTimeframe } from './candle-cache';

export type WsEngineState =
  | 'CONNECTED'
  | 'CONNECTING'
  | 'RECONNECTING'
  | 'STALE'
  | 'DISCONNECTED'
  | 'COOLDOWN';

export interface WsEngineHealth {
  state: WsEngineState;
  activeConnections: number;
  subscribedStreams: number;
  lastMessageAt: number | null;
  closedCandlesReceived: number;
  reconnectCount: number;
  error: string | null;
}

const MAX_STREAMS_PER_CONNECTION = 180; // Safely below Binance Futures 200-stream limit
const STALE_THRESHOLD_MS = 30_000;
const BASE_RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 60_000;

export function partitionStreams(symbols: readonly string[], timeframe: CandleTimeframe): string[][] {
  const streams = symbols.map((s) => `${s.toLowerCase()}@kline_${timeframe}`);
  const chunks: string[][] = [];
  for (let i = 0; i < streams.length; i += MAX_STREAMS_PER_CONNECTION) {
    chunks.push(streams.slice(i, i + MAX_STREAMS_PER_CONNECTION));
  }
  return chunks;
}

export function parseBinanceKlineEvent(payload: unknown): {
  symbol: string;
  timeframe: CandleTimeframe;
  isClosed: boolean;
  candle: CachedCandle;
} | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as { data?: unknown };
  const event = (root.data ?? payload) as {
    e?: string;
    s?: string;
    k?: {
      t?: number;
      T?: number;
      i?: string;
      o?: string;
      h?: string;
      l?: string;
      c?: string;
      v?: string;
      x?: boolean;
    };
  };
  if (event.e !== 'kline' || !event.s || !event.k) return null;
  const k = event.k;
  const timeframe = k.i as CandleTimeframe;
  if (!['1m', '3m', '5m', '15m', '1h', '4h'].includes(timeframe)) return null;

  const openTime = Number(k.t);
  const closeTime = Number(k.T);
  const high = Number(k.h);
  const low = Number(k.l);
  const close = Number(k.c);
  const volume = Number(k.v);
  if (
    ![openTime, closeTime, high, low, close, volume].every(Number.isFinite) ||
    high < low ||
    close <= 0
  ) {
    return null;
  }

  return {
    symbol: event.s.toUpperCase(),
    timeframe,
    isClosed: Boolean(k.x),
    candle: { openTime, closeTime, high, low, close, volume },
  };
}

export class BinanceWsKlineEngine {
  private sockets: WebSocket[] = [];
  private state: WsEngineState = 'DISCONNECTED';
  private lastMessageAt: number | null = null;
  private closedCandlesReceived = 0;
  private reconnectCount = 0;
  private subscribedStreams = 0;
  private error: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private onClosedCandle?: (symbol: string, timeframe: CandleTimeframe, candle: CachedCandle) => void;

  getHealth(now = Date.now()): WsEngineHealth {
    if (
      this.state === 'CONNECTED' &&
      this.lastMessageAt !== null &&
      now - this.lastMessageAt > STALE_THRESHOLD_MS
    ) {
      this.state = 'STALE';
    }
    return {
      state: this.state,
      activeConnections: this.sockets.filter((s) => s.readyState === WebSocket.OPEN).length,
      subscribedStreams: this.subscribedStreams,
      lastMessageAt: this.lastMessageAt,
      closedCandlesReceived: this.closedCandlesReceived,
      reconnectCount: this.reconnectCount,
      error: this.error,
    };
  }

  start(
    symbols: readonly string[],
    timeframe: CandleTimeframe,
    onClosedCandle?: (symbol: string, timeframe: CandleTimeframe, candle: CachedCandle) => void,
  ): void {
    this.stop();
    const cb = binanceRateLimiter.getStatus();
    if (cb.state === 'OPEN') {
      this.state = 'COOLDOWN';
      this.error = cb.reason ?? 'Binance API cooldown active; WebSocket paused.';
      return;
    }

    if (typeof WebSocket === 'undefined' || symbols.length === 0) {
      this.state = 'DISCONNECTED';
      return;
    }

    this.running = true;
    this.onClosedCandle = onClosedCandle;
    const partitions = partitionStreams(symbols, timeframe);
    this.subscribedStreams = symbols.length;
    this.state = 'CONNECTING';
    this.error = null;

    for (const chunk of partitions) {
      const url = `wss://fstream.binance.com/market/stream?streams=${chunk.join('/')}`;
      try {
        const ws = new WebSocket(url);
        this.sockets.push(ws);

        ws.onmessage = (msg) => {
          const now = Date.now();
          this.lastMessageAt = now;
          if (this.state !== 'CONNECTED') {
            this.state = 'CONNECTED';
            this.reconnectCount = 0;
            this.error = null;
          }
          try {
            const parsed = JSON.parse(typeof msg.data === 'string' ? msg.data : String(msg.data));
            const kline = parseBinanceKlineEvent(parsed);
            if (kline && kline.isClosed) {
              this.closedCandlesReceived += 1;
              sharedCandleCache.upsertClosedCandle('BINANCE', kline.symbol, kline.timeframe, kline.candle, now);
              this.onClosedCandle?.(kline.symbol, kline.timeframe, kline.candle);
            }
          } catch {
            // Ignore malformed frame
          }
        };

        ws.onerror = () => {
          this.error = 'Binance WebSocket stream error.';
        };

        ws.onclose = () => {
          if (!this.running) return;
          const activeOpen = this.sockets.some((s) => s !== ws && s.readyState === WebSocket.OPEN);
          if (!activeOpen) {
            this.state = 'RECONNECTING';
            this.scheduleReconnect(symbols, timeframe);
          }
        };
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'WebSocket initialization failed.';
        this.state = 'DISCONNECTED';
      }
    }

    this.heartbeatTimer = setInterval(() => {
      const cbNow = binanceRateLimiter.getStatus();
      if (cbNow.state === 'OPEN') {
        this.stop();
        this.state = 'COOLDOWN';
        this.error = cbNow.reason;
        return;
      }
      if (this.lastMessageAt !== null && Date.now() - this.lastMessageAt > STALE_THRESHOLD_MS) {
        this.state = 'STALE';
      }
    }, 10_000);
  }

  private scheduleReconnect(symbols: readonly string[], timeframe: CandleTimeframe): void {
    if (!this.running || this.reconnectTimer) return;
    const cb = binanceRateLimiter.getStatus();
    if (cb.state === 'OPEN') {
      this.state = 'COOLDOWN';
      this.error = cb.reason;
      return;
    }
    this.reconnectCount += 1;
    const delay = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** Math.min(4, this.reconnectCount - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) {
        this.start(symbols, timeframe, this.onClosedCandle);
      }
    }, delay);
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const ws of this.sockets) {
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.sockets = [];
    this.state = 'DISCONNECTED';
  }
}

const globalForWsEngine = globalThis as typeof globalThis & {
  __smartexitBinanceWsKlineEngine?: BinanceWsKlineEngine;
};
export const binanceWsKlineEngine =
  globalForWsEngine.__smartexitBinanceWsKlineEngine ??= new BinanceWsKlineEngine();
