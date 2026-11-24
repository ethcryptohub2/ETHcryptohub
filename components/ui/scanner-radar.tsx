'use client';

import { useEffect, useId, useState } from 'react';

export type ScannerRadarState =
  | 'INITIALIZING'
  | 'FETCHING_MARKET_DATA'
  | 'SCANNING'
  | 'EVALUATING'
  | 'SCAN_COMPLETED'
  | 'NO_QUALIFIED_SIGNALS'
  | 'WAITING'
  | 'RATE_LIMITED'
  | 'DEGRADED'
  | 'OFFLINE'
  | 'ERROR';

export interface ScannerRadarProps {
  state?: ScannerRadarState;
  activeSymbol?: string;
  scannedCount?: number;
  totalEligible?: number;
  strategy?: string;
  lastScanTime?: string | number | Date | null;
  rejectionReasons?: Record<string, number> | null;
  onScanNow?: () => void;
  isScanning?: boolean;
  className?: string;
  compact?: boolean;
  emptyStateTitle?: string;
  emptyStateSubtitle?: string;
  emptyStateFooter?: string;
}

interface RadarBlip {
  id: string;
  symbol: string;
  x: number;
  y: number;
  status: 'QUALIFIED' | 'WAITING' | 'REJECTED';
  score?: number;
}

const DEFAULT_BLIPS: RadarBlip[] = [
  { id: 'btc', symbol: 'BTCUSDT', x: 205, y: 110, status: 'WAITING', score: 58 },
  { id: 'eth', symbol: 'ETHUSDT', x: 105, y: 95, status: 'WAITING', score: 54 },
  { id: 'sol', symbol: 'SOLUSDT', x: 195, y: 205, status: 'WAITING', score: 52 },
  { id: 'bnb', symbol: 'BNBUSDT', x: 90, y: 175, status: 'WAITING', score: 48 },
  { id: 'avax', symbol: 'AVAXUSDT', x: 230, y: 165, status: 'WAITING', score: 45 },
  { id: 'doge', symbol: 'DOGEUSDT', x: 125, y: 220, status: 'WAITING', score: 42 },
];

const STATE_CONFIG: Record<
  ScannerRadarState,
  {
    label: string;
    description: string;
    color: string;
    badgeBackground: string;
    badgeBorder: string;
    pulseColor: string;
    pulse: boolean;
  }
> = {
  INITIALIZING: {
    label: 'INITIALIZING',
    description: 'Initializing quant scanner pipeline and loading symbol universe...',
    color: '#60a5fa',
    badgeBackground: 'rgba(59, 130, 246, 0.1)',
    badgeBorder: '#3b82f6',
    pulseColor: 'rgba(59, 130, 246, 0.5)',
    pulse: true,
  },
  FETCHING_MARKET_DATA: {
    label: 'FETCHING MARKET DATA',
    description: 'Streaming real-time order books, ticker volume, and candle feeds from Binance USDⓈ-M...',
    color: '#38bdf8',
    badgeBackground: 'rgba(56, 189, 248, 0.1)',
    badgeBorder: '#0284c7',
    pulseColor: 'rgba(56, 189, 248, 0.5)',
    pulse: true,
  },
  SCANNING: {
    label: 'SCANNING LIQUIDITY',
    description: 'Scanning active perpetual markets against multi-timeframe indicator stack...',
    color: '#3b82f6',
    badgeBackground: 'rgba(37, 99, 235, 0.12)',
    badgeBorder: '#2563eb',
    pulseColor: 'rgba(37, 99, 235, 0.6)',
    pulse: true,
  },
  EVALUATING: {
    label: 'EVALUATING CONFLUENCE',
    description: 'Calculating EMA alignment, Supertrend direction, ADX momentum, and RSI trigger levels...',
    color: '#a855f7',
    badgeBackground: 'rgba(168, 85, 247, 0.12)',
    badgeBorder: '#9333ea',
    pulseColor: 'rgba(168, 85, 247, 0.5)',
    pulse: true,
  },
  SCAN_COMPLETED: {
    label: 'SCAN COMPLETED',
    description: 'Market scan cycle completed successfully. Signals evaluated and updated.',
    color: '#10b981',
    badgeBackground: 'rgba(16, 185, 129, 0.12)',
    badgeBorder: '#059669',
    pulseColor: 'rgba(16, 185, 129, 0.4)',
    pulse: false,
  },
  NO_QUALIFIED_SIGNALS: {
    label: 'NO QUALIFIED SIGNALS',
    description: 'No trading setups currently meet the strict score threshold (≥60) and risk requirements.',
    color: '#f59e0b',
    badgeBackground: 'rgba(245, 158, 11, 0.12)',
    badgeBorder: '#d97706',
    pulseColor: 'rgba(245, 158, 11, 0.4)',
    pulse: true,
  },
  WAITING: {
    label: 'MARKET MONITORING',
    description: 'Market analysis continues automatically. Waiting for new candle closes or volatility triggers.',
    color: '#6366f1',
    badgeBackground: 'rgba(99, 102, 241, 0.1)',
    badgeBorder: '#4f46e5',
    pulseColor: 'rgba(99, 102, 241, 0.4)',
    pulse: false,
  },
  RATE_LIMITED: {
    label: 'RATE LIMITED',
    description: 'Exchange rate limit protection activated. Backing off temporarily before next cycle.',
    color: '#f97316',
    badgeBackground: 'rgba(249, 115, 22, 0.12)',
    badgeBorder: '#ea580c',
    pulseColor: 'rgba(249, 115, 22, 0.4)',
    pulse: true,
  },
  DEGRADED: {
    label: 'DEGRADED FEED',
    description: 'Feed latency detected or partial cache available. Re-synchronizing market feeds.',
    color: '#eab308',
    badgeBackground: 'rgba(234, 179, 8, 0.12)',
    badgeBorder: '#ca8a04',
    pulseColor: 'rgba(234, 179, 8, 0.4)',
    pulse: true,
  },
  OFFLINE: {
    label: 'OFFLINE',
    description: 'Market data feed disconnected. Attempting automatic reconnection...',
    color: '#ef4444',
    badgeBackground: 'rgba(239, 68, 68, 0.12)',
    badgeBorder: '#dc2626',
    pulseColor: 'rgba(239, 68, 68, 0.4)',
    pulse: false,
  },
  ERROR: {
    label: 'SCAN ERROR',
    description: 'Scan evaluation encountered an unexpected error. Try running a manual scan.',
    color: '#ef4444',
    badgeBackground: 'rgba(239, 68, 68, 0.12)',
    badgeBorder: '#dc2626',
    pulseColor: 'rgba(239, 68, 68, 0.5)',
    pulse: true,
  },
};

function formatLastScanTime(time: string | number | Date | null | undefined): string {
  if (!time) return 'Never';
  const timestamp = typeof time === 'string' || typeof time === 'number' ? new Date(time) : time;
  if (isNaN(timestamp.getTime())) return 'Never';
  return timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ScannerRadar({
  state = 'NO_QUALIFIED_SIGNALS',
  activeSymbol,
  scannedCount,
  totalEligible,
  strategy = 'STANDARD',
  lastScanTime,
  rejectionReasons,
  onScanNow,
  isScanning = false,
  className = '',
  compact = false,
  emptyStateTitle = 'Scanning the market for qualified trading setups.',
  emptyStateSubtitle = 'No qualified signals found yet.',
  emptyStateFooter = 'Market analysis continues automatically.',
}: ScannerRadarProps) {
  const gradientId = useId();
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [hoveredBlip, setHoveredBlip] = useState<RadarBlip | null>(null);
  const [hudAzimuth, setHudAzimuth] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(media.matches);
    const onChange = (event: MediaQueryListEvent) => setPrefersReducedMotion(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const config = STATE_CONFIG[state] ?? STATE_CONFIG.NO_QUALIFIED_SIGNALS;

  const handleMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    let degrees = (Math.atan2(y, x) * 180) / Math.PI + 90;
    if (degrees < 0) degrees += 360;
    setHudAzimuth(Math.round(degrees));
  };

  const handleMouseLeave = () => {
    setHudAzimuth(null);
    setHoveredBlip(null);
  };

  const sweepGradientId = `radar-sweep-grad-${gradientId}`;
  const glowGradientId = `radar-glow-grad-${gradientId}`;

  return (
    <div
      className={`scanner-radar-card ${className}`}
      role="region"
      aria-label="Market Scanner Status Radar"
    >
      {/* Top Connection & State Badges */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          marginBottom: compact ? 12 : 20,
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        {/* Pulsing connection status badge */}
        <div
          className={config.pulse && !prefersReducedMotion ? 'pulse-glow-badge' : ''}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 12px',
            borderRadius: 99,
            background: config.badgeBackground,
            border: `1px solid ${config.badgeBorder}`,
            fontFamily: "'DM Mono', monospace",
            fontSize: 11,
            fontWeight: 600,
            color: config.color,
            ['--pulse-color' as string]: config.pulseColor,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: config.color,
              boxShadow: `0 0 8px ${config.color}`,
              display: 'inline-block',
            }}
          />
          <span>BINANCE USDⓈ-M · {config.label}</span>
        </div>

        {/* Live HUD / Coordinates Pill */}
        <div
          style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 11,
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          {hudAzimuth !== null ? (
            <span style={{ color: 'var(--accent-strong)' }}>BEARING: {hudAzimuth.toString().padStart(3, '0')}°</span>
          ) : (
            <span>STRATEGY: {strategy}</span>
          )}
          {lastScanTime && (
            <span>LAST SCAN: {formatLastScanTime(lastScanTime)}</span>
          )}
        </div>
      </div>

      {/* Interactive SVG Radar Graphic */}
      <div style={{ position: 'relative', width: compact ? 200 : 260, height: compact ? 200 : 260, margin: '0 auto 16px' }}>
        <svg
          viewBox="0 0 300 300"
          className="scanner-radar-svg"
          style={{ width: '100%', height: '100%', overflow: 'visible', cursor: 'crosshair' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          aria-hidden="true"
        >
          <defs>
            <radialGradient id={glowGradientId} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={config.color} stopOpacity="0.16" />
              <stop offset="60%" stopColor={config.color} stopOpacity="0.04" />
              <stop offset="100%" stopColor={config.color} stopOpacity="0" />
            </radialGradient>

            <linearGradient id={sweepGradientId} x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor={config.color} stopOpacity="0" />
              <stop offset="70%" stopColor={config.color} stopOpacity="0.12" />
              <stop offset="100%" stopColor={config.color} stopOpacity="0.35" />
            </linearGradient>
          </defs>

          {/* Radar background glow & container circle */}
          <circle cx="150" cy="150" r="140" fill={`url(#${glowGradientId})`} />
          <circle cx="150" cy="150" r="140" fill="none" stroke="var(--surface-border)" strokeWidth="1.5" />

          {/* Concentric distance rings */}
          <circle cx="150" cy="150" r="35" fill="none" stroke="var(--surface-border)" strokeDasharray="3 3" strokeWidth="1" />
          <circle cx="150" cy="150" r="70" fill="none" stroke="var(--surface-border)" strokeWidth="1" opacity="0.75" />
          <circle cx="150" cy="150" r="105" fill="none" stroke="var(--surface-border)" strokeDasharray="3 3" strokeWidth="1" />
          <circle cx="150" cy="150" r="140" fill="none" stroke={config.color} strokeWidth="1.5" opacity="0.65" />

          {/* Radar crosshairs & tick marks */}
          <line x1="10" y1="150" x2="290" y2="150" stroke="var(--surface-border)" strokeWidth="1" strokeDasharray="4 4" />
          <line x1="150" y1="10" x2="150" y2="290" stroke="var(--surface-border)" strokeWidth="1" strokeDasharray="4 4" />

          {/* Cardinal / Azimuth indicators */}
          <text x="150" y="24" textAnchor="middle" fill="var(--text-muted)" fontSize="9" fontFamily="'DM Mono', monospace">000°</text>
          <text x="276" y="153" textAnchor="start" fill="var(--text-muted)" fontSize="9" fontFamily="'DM Mono', monospace">090°</text>
          <text x="150" y="284" textAnchor="middle" fill="var(--text-muted)" fontSize="9" fontFamily="'DM Mono', monospace">180°</text>
          <text x="24" y="153" textAnchor="end" fill="var(--text-muted)" fontSize="9" fontFamily="'DM Mono', monospace">270°</text>

          {/* Sweep Animation Beam */}
          <g
            className={prefersReducedMotion ? '' : 'radar-sweep-beam'}
            style={{
              transformOrigin: '150px 150px',
              transform: prefersReducedMotion ? 'rotate(45deg)' : undefined,
            }}
          >
            {/* 45-degree sweeping sector */}
            <path
              d="M 150 150 L 290 150 A 140 140 0 0 0 248.99 51.01 Z"
              fill={`url(#${sweepGradientId})`}
            />
            {/* Leading sweep line */}
            <line
              x1="150"
              y1="150"
              x2="290"
              y2="150"
              stroke={config.color}
              strokeWidth="2"
              strokeLinecap="round"
            />
            {/* Leading edge light point */}
            <circle cx="288" cy="150" r="2.5" fill="#ffffff" />
          </g>

          {/* Dynamic Radar Market Blips */}
          {DEFAULT_BLIPS.map((blip) => {
            const isHovered = hoveredBlip?.id === blip.id;
            const blipColor = isScanning ? '#38bdf8' : blip.status === 'QUALIFIED' ? '#10b981' : '#f59e0b';
            return (
              <g
                key={blip.id}
                onMouseEnter={() => setHoveredBlip(blip)}
                onMouseLeave={() => setHoveredBlip(null)}
                style={{ cursor: 'pointer' }}
              >
                {/* Ping ring on hover */}
                {isHovered && (
                  <circle
                    cx={blip.x}
                    cy={blip.y}
                    r="12"
                    fill="none"
                    stroke={blipColor}
                    strokeWidth="1.5"
                    opacity="0.8"
                  />
                )}
                {/* Core dot */}
                <circle
                  cx={blip.x}
                  cy={blip.y}
                  r={isHovered ? 4.5 : 3}
                  fill={blipColor}
                  opacity={isScanning ? 0.9 : 0.6}
                  className={!prefersReducedMotion && isScanning ? 'animate-pulse-glow' : ''}
                />
                {/* Symbol label on hover */}
                {isHovered && (
                  <text
                    x={blip.x}
                    y={blip.y - 12}
                    textAnchor="middle"
                    fill="var(--text-primary)"
                    fontSize="10"
                    fontWeight="700"
                    fontFamily="'DM Mono', monospace"
                  >
                    {blip.symbol} ({blip.score})
                  </text>
                )}
              </g>
            );
          })}

          {/* Center Hub */}
          <circle cx="150" cy="150" r="10" fill="none" stroke={config.color} strokeWidth="1.5" opacity="0.4" />
          <circle cx="150" cy="150" r="5" fill={config.color} />
          <circle cx="150" cy="150" r="2" fill="#ffffff" />
        </svg>

        {/* Floating Tooltip if Blip is Hovered */}
        {hoveredBlip && (
          <div
            style={{
              position: 'absolute',
              bottom: 8,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'var(--surface-raised)',
              border: '1px solid var(--surface-border)',
              borderRadius: 6,
              padding: '4px 10px',
              fontFamily: "'DM Mono', monospace",
              fontSize: 10,
              color: 'var(--text-primary)',
              whiteSpace: 'nowrap',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              pointerEvents: 'none',
              zIndex: 10,
            }}
          >
            <strong>{hoveredBlip.symbol}</strong>: Score {hoveredBlip.score}/100 · Setup: {hoveredBlip.status}
          </div>
        )}
      </div>

      {/* Animated Empty State Headline & Messaging */}
      <div style={{ maxWidth: 580, margin: '0 auto' }}>
        <h3
          style={{
            margin: '0 0 8px',
            fontSize: compact ? 16 : 19,
            fontWeight: 700,
            color: 'var(--text-primary)',
            letterSpacing: '-0.02em',
          }}
        >
          {emptyStateTitle}
        </h3>

        <p
          style={{
            margin: '0 0 6px',
            fontSize: 14,
            fontWeight: 500,
            color: config.color,
          }}
        >
          {emptyStateSubtitle}
        </p>

        <p
          className="muted"
          style={{
            margin: '0 0 16px',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {config.description} {emptyStateFooter}
        </p>

        {/* Live scanning progress meta if active */}
        {(activeSymbol || (scannedCount !== undefined && totalEligible !== undefined)) && (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 16px',
              borderRadius: 8,
              background: 'var(--surface-raised)',
              border: '1px solid var(--surface-border)',
              fontFamily: "'DM Mono', monospace",
              fontSize: 12,
              marginBottom: 16,
              color: 'var(--text-secondary)',
            }}
          >
            {activeSymbol && (
              <span>
                CURRENT PAIR: <strong style={{ color: 'var(--accent-strong)' }}>{activeSymbol}</strong>
              </span>
            )}
            {scannedCount !== undefined && totalEligible !== undefined && (
              <span>
                PROCESSED: <strong>{scannedCount}</strong> / {totalEligible}
              </span>
            )}
          </div>
        )}

        {/* Rejection reasons summary when available */}
        {rejectionReasons && Object.keys(rejectionReasons).length > 0 && (
          <div style={{ marginTop: 12, marginBottom: 18 }}>
            <span
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                color: 'var(--text-muted)',
                letterSpacing: '0.06em',
                display: 'block',
                marginBottom: 8,
                textTransform: 'uppercase',
              }}
            >
              Rejection Breakdown (Signals Awaiting Qualification)
            </span>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {rejectionReasons.insufficientScore ? (
                <span className="scanner-rejection-chip">
                  Score &lt; 60 ({rejectionReasons.insufficientScore})
                </span>
              ) : null}
              {rejectionReasons.trendConflict ? (
                <span className="scanner-rejection-chip">
                  EMA Trend Misaligned ({rejectionReasons.trendConflict})
                </span>
              ) : null}
              {rejectionReasons.momentumConflict ? (
                <span className="scanner-rejection-chip">
                  RSI / Momentum Conflict ({rejectionReasons.momentumConflict})
                </span>
              ) : null}
              {rejectionReasons.supertrendConflict ? (
                <span className="scanner-rejection-chip">
                  Supertrend Conflict ({rejectionReasons.supertrendConflict})
                </span>
              ) : null}
              {rejectionReasons.pivotProximity ? (
                <span className="scanner-rejection-chip">
                  Pivot Proximity ({rejectionReasons.pivotProximity})
                </span>
              ) : null}
              {rejectionReasons.dataUnavailable ? (
                <span className="scanner-rejection-chip">
                  Data Syncing ({rejectionReasons.dataUnavailable})
                </span>
              ) : null}
            </div>
          </div>
        )}

        {/* Action Controls */}
        {onScanNow && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 6 }}>
            <button
              type="button"
              className="button"
              onClick={onScanNow}
              disabled={isScanning}
              style={{
                minWidth: 140,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {isScanning ? (
                <>
                  <svg
                    style={{
                      width: 15,
                      height: 15,
                      animation: prefersReducedMotion ? 'none' : 'radar-sweep 1s linear infinite',
                    }}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
                  </svg>
                  <span>Scanning Market…</span>
                </>
              ) : (
                <>
                  <svg style={{ width: 15, height: 15 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="8" />
                    <line x1="12" y1="2" x2="12" y2="4" />
                    <line x1="12" y1="20" x2="12" y2="22" />
                    <line x1="2" y1="12" x2="4" y2="12" />
                    <line x1="20" y1="12" x2="22" y2="12" />
                  </svg>
                  <span>Start Scan Now</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
