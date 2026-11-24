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

export interface LiveMarketFeedState {
  tickers: Record<string, LiveTickerItem>;
  status: 'CONNECTED_WS' | 'POLLING_REST' | 'CONNECTING' | 'OFFLINE';
  lastPingTime: number | null;
  messageCount: number;
  error: string | null;
}

const WS_URL = 'wss://fstream.binance.com/ws/!miniTicker@arr';
const REST_URL = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const REST_FALLBACK_INTERVAL_MS = 5_000;

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
  const restIntervalRef = useRef<number | null>(null);
  const prevPricesRef = useRef<Record<string, number>>({});
  const isTabVisibleRef = useRef<boolean>(true);

  const filterSet = filterSymbols ? new Set(filterSymbols.map((s) => s.toUpperCase())) : null;

  const updateTickers = useCallback((rawTickers: Array<{
    s: string; // symbol
    c: string; // close / current price
    h?: string; // high
    l?: string; // low
    q?: string; // quote volume
    o?: string; // open
  }>) => {
    const now = Date.now();
    const newItems: Record<string, LiveTickerItem> = {};

    for (const item of rawTickers) {
      const sym = item.s;
      if (filterSet && !filterSet.has(sym)) continue;

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
      setFeedState((prev) => ({
        ...prev,
        tickers: { ...prev.tickers, ...newItems },
        lastPingTime: now,
        messageCount: prev.messageCount + 1,
        error: null,
      }));
    }
  }, [filterSymbols]);

  const pollRestFallback = useCallback(async () => {
    if (!isTabVisibleRef.current) return;
    try {
      const response = await fetch(REST_URL, { cache: 'no-store' });
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
        );
        setFeedState((prev) => ({ ...prev, status: 'POLLING_REST' }));
      }
    } catch (err) {
      setFeedState((prev) => ({
        ...prev,
        status: 'OFFLINE',
        error: err instanceof Error ? err.message : 'REST polling failed',
      }));
    }
  }, [updateTickers]);

  const connectWs = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    try {
      setFeedState((prev) => ({ ...prev, status: 'CONNECTING' }));
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setFeedState((prev) => ({ ...prev, status: 'CONNECTED_WS', error: null }));
        if (restIntervalRef.current) {
          window.clearInterval(restIntervalRef.current);
          restIntervalRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (Array.isArray(parsed)) {
            updateTickers(parsed);
          }
        } catch {}
      };

      ws.onerror = () => {
        setFeedState((prev) => ({ ...prev, status: 'POLLING_REST' }));
        if (!restIntervalRef.current) {
          void pollRestFallback();
          restIntervalRef.current = window.setInterval(pollRestFallback, REST_FALLBACK_INTERVAL_MS);
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (isTabVisibleRef.current) {
          // Schedule reconnect in 3s
          if (!restIntervalRef.current) {
            void pollRestFallback();
            restIntervalRef.current = window.setInterval(pollRestFallback, REST_FALLBACK_INTERVAL_MS);
          }
          reconnectTimeoutRef.current = window.setTimeout(connectWs, 3_000);
        }
      };
    } catch {
      setFeedState((prev) => ({ ...prev, status: 'POLLING_REST' }));
      if (!restIntervalRef.current) {
        void pollRestFallback();
        restIntervalRef.current = window.setInterval(pollRestFallback, REST_FALLBACK_INTERVAL_MS);
      }
    }
  }, [pollRestFallback, updateTickers]);

  useEffect(() => {
    const handleVisibility = () => {
      isTabVisibleRef.current = document.visibilityState === 'visible';
      if (isTabVisibleRef.current) {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          connectWs();
        }
      } else {
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        if (restIntervalRef.current) {
          window.clearInterval(restIntervalRef.current);
          restIntervalRef.current = null;
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    connectWs();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
      if (restIntervalRef.current) {
        window.clearInterval(restIntervalRef.current);
      }
    };
  }, [connectWs]);

  return feedState;
}
