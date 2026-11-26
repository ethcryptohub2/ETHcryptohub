'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

export interface LiveTickerItem {
  symbol: string;
  price: number;
  priceChangePercent24h: number;
  high24h?: number;
  low24h?: number;
  quoteVolume24h?: number;
  lastUpdated: number;
  direction: 'UP' | 'DOWN' | 'SAME';
}

export type LiveFeedStatus =
  | 'CONNECTED_WS'
  | 'POLLING_REST'
  | 'CONNECTING'
  | 'RECONNECTING'
  | 'STALE'
  | 'DISCONNECTED';

export interface LiveMarketFeedState {
  tickers: Record<string, LiveTickerItem>;
  status: LiveFeedStatus;
  lastPingTime: number | null;
  messageCount: number;
  error: string | null;
}

const WS_URL = 'wss://fstream.binance.com/ws/!miniTicker@arr';
const REST_URL = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const REST_FALLBACK_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 15_000;

export function useLiveMarketFeed(filterSymbols?: string[]) {
  const [feedState, setFeedState] = useState<LiveMarketFeedState>({
    tickers: {},
    status: 'CONNECTING',
    lastPingTime: null,
    messageCount: 0,
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const connectTimeoutRef = useRef<number | null>(null);
  const restIntervalRef = useRef<number | null>(null);
  const prevPricesRef = useRef<Record<string, number>>({});
  const isTabVisibleRef = useRef<boolean>(true);
  const reconnectAttemptRef = useRef<number>(0);
  const lastPingRef = useRef<number | null>(null);
  const restCooldownUntilRef = useRef<number>(0);

  const filterKey = filterSymbols ? [...filterSymbols].map((s) => s.toUpperCase()).sort().join(',') : '';
  const filterSetRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    filterSetRef.current = filterKey ? new Set(filterKey.split(',')) : null;
  }, [filterKey]);

  const updateTickers = useCallback((rawTickers: Array<{
    s: string;
    c: string;
    h?: string;
    l?: string;
    q?: string;
    o?: string;
  }>, sourceStatus: LiveFeedStatus) => {
    const now = Date.now();
    const newItems: Record<string, LiveTickerItem> = {};
    const activeFilter = filterSetRef.current;

    for (const item of rawTickers) {
      const sym = item.s;
      if (activeFilter && !activeFilter.has(sym)) continue;

      const price = Number.parseFloat(item.c);
      if (!Number.isFinite(price) || price <= 0) continue;

      const prev = prevPricesRef.current[sym];
      const direction: 'UP' | 'DOWN' | 'SAME' = prev === undefined ? 'SAME' : price > prev ? 'UP' : price < prev ? 'DOWN' : 'SAME';
      prevPricesRef.current[sym] = price;

      const open = item.o ? Number.parseFloat(item.o) : price;
      const changePercent = open > 0 ? ((price - open) / open) * 100 : 0;

      newItems[sym] = {
        symbol: sym,
        price,
        priceChangePercent24h: changePercent,
        high24h: item.h ? Number.parseFloat(item.h) : undefined,
        low24h: item.l ? Number.parseFloat(item.l) : undefined,
        quoteVolume24h: item.q ? Number.parseFloat(item.q) : undefined,
        lastUpdated: now,
        direction,
      };
    }

    if (Object.keys(newItems).length > 0) {
      lastPingRef.current = now;
      setFeedState((prev) => ({
        ...prev,
        status: sourceStatus,
        tickers: { ...prev.tickers, ...newItems },
        lastPingTime: now,
        messageCount: prev.messageCount + 1,
        error: null,
      }));
    }
  }, []);

  const pollRestFallback = useCallback(async () => {
    if (!isTabVisibleRef.current) return;
    const now = Date.now();
    if (now < restCooldownUntilRef.current) return;

    try {
      const response = await fetch(REST_URL, { cache: 'no-store' });
      if (response.status === 418 || response.status === 429) {
        const retryHeader = Number(response.headers.get('retry-after'));
        const cooldownMs = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader * 1000 : 120_000;
        restCooldownUntilRef.current = Date.now() + cooldownMs;
        setFeedState((prev) => ({
          ...prev,
          status: 'DISCONNECTED',
          error: 'Market data temporarily unavailable.',
        }));
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as Array<{
        symbol: string;
        lastPrice: string;
        highPrice: string;
        lowPrice: string;
        quoteVolume: string;
        openPrice: string;
      }>;

      if (Array.isArray(data)) {
        updateTickers(
          data.map((d) => ({
            s: d.symbol,
            c: d.lastPrice,
            h: d.highPrice,
            l: d.lowPrice,
            q: d.quoteVolume,
            o: d.openPrice,
          })),
          'POLLING_REST',
        );
      }
    } catch (err) {
      setFeedState((prev) => ({
        ...prev,
        status: 'DISCONNECTED',
        error: err instanceof Error ? err.message : 'REST polling failed',
      }));
    }
  }, [updateTickers]);

  const stopRestFallback = useCallback(() => {
    if (restIntervalRef.current) {
      window.clearInterval(restIntervalRef.current);
      restIntervalRef.current = null;
    }
  }, []);

  const startRestFallback = useCallback(() => {
    if (!restIntervalRef.current) {
      void pollRestFallback();
      restIntervalRef.current = window.setInterval(pollRestFallback, REST_FALLBACK_INTERVAL_MS);
    }
  }, [pollRestFallback]);

  const connectWs = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    try {
      setFeedState((prev) => ({
        ...prev,
        status: reconnectAttemptRef.current > 0 ? 'RECONNECTING' : 'CONNECTING',
      }));
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      if (connectTimeoutRef.current) window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = window.setTimeout(() => {
        if (!lastPingRef.current || Date.now() - lastPingRef.current > 8_000) {
          startRestFallback();
          setFeedState((prev) => (prev.status === 'CONNECTING' ? { ...prev, status: 'DISCONNECTED', error: 'WebSocket connection timed out.' } : prev));
        }
      }, 8_000);

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        // Stay CONNECTING until first genuine ticker payload arrives
        stopRestFallback();
      };

      ws.onmessage = (event) => {
        if (connectTimeoutRef.current) {
          window.clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        try {
          const parsed = JSON.parse(event.data);
          if (Array.isArray(parsed)) {
            updateTickers(parsed, 'CONNECTED_WS');
          }
        } catch {
          // ignore malformed ws frame
        }
      };

      ws.onerror = () => {
        startRestFallback();
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (isTabVisibleRef.current) {
          startRestFallback();
          reconnectAttemptRef.current += 1;
          const delayMs = Math.min(60_000, 3_000 * 2 ** Math.min(4, reconnectAttemptRef.current - 1));
          setFeedState((prev) => ({ ...prev, status: 'RECONNECTING' }));
          if (reconnectTimeoutRef.current) window.clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = window.setTimeout(connectWs, delayMs);
        } else {
          setFeedState((prev) => ({ ...prev, status: 'DISCONNECTED' }));
        }
      };
    } catch {
      startRestFallback();
    }
  }, [startRestFallback, stopRestFallback, updateTickers]);

  useEffect(() => {
    const handleVisibility = () => {
      isTabVisibleRef.current = document.visibilityState === 'visible';
      if (isTabVisibleRef.current) {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          connectWs();
        }
      } else {
        if (wsRef.current) {
          wsRef.current.onclose = null;
          wsRef.current.close();
          wsRef.current = null;
        }
        stopRestFallback();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    const initTimer = window.setTimeout(connectWs, 0);

    // Heartbeat & stale-data detection every 5s
    const staleTimer = window.setInterval(() => {
      if (!isTabVisibleRef.current) return;
      const last = lastPingRef.current;
      if (last && Date.now() - last > STALE_THRESHOLD_MS) {
        setFeedState((prev) => (prev.status === 'CONNECTED_WS' ? { ...prev, status: 'STALE' } : prev));
      }
    }, 5_000);

    return () => {
      window.clearTimeout(initTimer);
      window.clearInterval(staleTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
      if (connectTimeoutRef.current) {
        window.clearTimeout(connectTimeoutRef.current);
      }
      stopRestFallback();
    };
  }, [connectWs, stopRestFallback]);

  return feedState;
}
