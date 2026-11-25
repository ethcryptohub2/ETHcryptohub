'use client';

import React from 'react';
import { useLiveMarketFeed } from '../lib/live-market-feed';

const CORE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'XRPUSDT'];

function formatPrice(val: number): string {
  if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (val >= 1) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return val.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

export function LiveMarketTickerBar({ className = '' }: { className?: string }) {
  const { tickers, status, lastPingTime } = useLiveMarketFeed(CORE_SYMBOLS);

  const isConnected = status === 'CONNECTED_WS';
  const isPolling = status === 'POLLING_REST';

  return (
    <aside
      className={`live-market-ticker-bar ${className}`}
      aria-label="Live Binance USDⓈ-M Futures Tickers"
      style={{
        background: 'var(--surface-subtle, rgba(255, 255, 255, 0.03))',
        border: '1px solid var(--surface-border, rgba(255, 255, 255, 0.08))',
        borderRadius: 8,
        padding: '8px 14px',
        marginBottom: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          className="live-pulse-badge"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontWeight: 700,
            color: isConnected ? '#10b981' : isPolling ? '#f59e0b' : '#9ca3af',
            fontSize: 11,
            letterSpacing: '0.04em',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: isConnected ? '#10b981' : isPolling ? '#f59e0b' : '#9ca3af',
              boxShadow: isConnected ? '0 0 8px #10b981' : 'none',
              animation: isConnected ? 'pulse-glow 2s infinite' : 'none',
            }}
          />
          {isConnected ? 'LIVE FEED: BINANCE USDⓈ-M WS' : isPolling ? 'LIVE FEED: REST POLLING' : 'FEED: CONNECTING…'}
        </span>
        {lastPingTime && (
          <span className="muted mono" style={{ fontSize: 10 }} suppressHydrationWarning>
            {new Date(lastPingTime).toLocaleTimeString('en-US')}
          </span>
        )}
      </div>

      <div
        className="ticker-items-scroll"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        {CORE_SYMBOLS.map((symbol) => {
          const item = tickers[symbol];
          const isUp = item && item.priceChangePercent24h >= 0;
          const tickColor = item?.direction === 'UP' ? '#10b981' : item?.direction === 'DOWN' ? '#ef4444' : undefined;

          return (
            <div
              key={symbol}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '2px 6px',
                borderRadius: 4,
                transition: 'background-color 0.25s ease',
                backgroundColor: tickColor ? `${tickColor}15` : 'transparent',
              }}
            >
              <strong className="mono" style={{ fontSize: 12 }}>
                {symbol.replace('USDT', '')}
              </strong>
              <span
                className="mono"
                style={{
                  fontWeight: 600,
                  color: tickColor ?? 'var(--text, #ffffff)',
                  transition: 'color 0.2s ease',
                }}
              >
                {item ? formatPrice(item.price) : '—'}
              </span>
              {item && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: isUp ? '#10b981' : '#ef4444',
                  }}
                >
                  {isUp ? '+' : ''}{item.priceChangePercent24h.toFixed(2)}%
                </span>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
