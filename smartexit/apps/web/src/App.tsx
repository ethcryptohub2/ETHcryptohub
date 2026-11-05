import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  api,
  money,
  price,
  type FuturesMarkets,
  type Health,
  type MarketScannerResponse,
  type NearNetwork,
  type NearStatus,
  type PaperPortfolio,
  type PaperUser,
  type RiskData,
  type RiskSettings,
  type ScannerCandidate,
  type Trade,
  type TradeEvent,
} from './api';

type Screen = 'dashboard' | 'scanner' | 'create' | 'risk' | 'near' | 'live';
type ScannerPrefill = NonNullable<ScannerCandidate['setup']> & {
  symbol: string;
  quoteAsset: string;
  side: 'LONG' | 'SHORT';
  notes: string;
};

const icon = {
  brand: 'S',
  dashboard: '◫',
  scanner: '◎',
  create: '+',
  risk: '⌁',
  near: '↗',
  live: '◉',
  shield: '◇',
  refresh: '↻',
};

function formatAssetAmount(value: number, asset: string): string {
  return asset === 'USDT'
    ? money(value)
    : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(value)} ${asset}`;
}

function initialScreen(): Screen {
  const requestedScreen = new URLSearchParams(window.location.search).get('screen');
  return requestedScreen === 'scanner' || requestedScreen === 'create' ? requestedScreen : 'dashboard';
}

function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [tradePrefill, setTradePrefill] = useState<ScannerPrefill | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<string | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [events, setEvents] = useState<TradeEvent[]>([]);
  const [risk, setRisk] = useState<RiskData | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [user, setUser] = useState<PaperUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [portfolio, setPortfolio] = useState<PaperPortfolio | null>(null);
  const [livePrices, setLivePrices] = useState<Record<string, { price: number; updatedAt: number }>>({});
  const [marketFeedStatus, setMarketFeedStatus] = useState<'connecting' | 'live' | 'reconnecting'>(
    'connecting',
  );
  const [marketFeedError, setMarketFeedError] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const tradesRef = useRef(trades);
  const marketUpdateInFlight = useRef(false);

  useEffect(() => {
    let active = true;
    void api<PaperUser | null>('/auth/me')
      .then(({ data }) => {
        if (active) setUser(data);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Unable to check the signed-in account.'),
      )
      .finally(() => {
        if (active) setAuthLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    tradesRef.current = trades;
  }, [trades]);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      setError('');
      const [tradeResponse, eventResponse, riskResponse, healthResponse, portfolioResponse] =
        await Promise.all([
          api<Trade[]>('/trades?limit=200'),
          api<TradeEvent[]>('/events?limit=12'),
          api<RiskData>('/risk'),
          api<Health>('/health'),
          api<PaperPortfolio>('/portfolio'),
        ]);
      setTrades(tradeResponse.data);
      setEvents(eventResponse.data);
      setRisk(riskResponse.data);
      setHealth(healthResponse.data);
      setPortfolio(portfolioResponse.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load dashboard data.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!user) return;
    let reconnectTimer = 0;
    let disposed = false;
    let retryDelay = 1000;
    let socket: WebSocket | null = null;
    let fallbackTimer = 0;
    let fallbackInFlight = false;
    let lastSocketMessageAt = 0;
    let lastLiveUpdateAt = 0;
    const processPriceUpdates = (updates: Map<string, number>) => {
      if (updates.size === 0) return;
      const receivedAt = Date.now();
      lastLiveUpdateAt = receivedAt;
      setLivePrices((current) => {
        const next = { ...current };
        for (const [symbol, tickerPrice] of updates) {
          next[symbol] = { price: tickerPrice, updatedAt: receivedAt };
        }
        return next;
      });
      setMarketFeedStatus('live');
      setMarketFeedError('');
      if (risk?.settings.killSwitchEnabled || marketUpdateInFlight.current) return;
      const currentOpenTrades = tradesRef.current.filter((trade) =>
        ['OPEN', 'TP1_HIT_TRAILING', 'TP2_HIT_TRAILING'].includes(trade.status),
      );
      const requiredSymbols = new Set(
        currentOpenTrades.flatMap((trade) =>
          trade.quoteAsset === 'USDT' ? [trade.symbol] : [trade.symbol, `${trade.quoteAsset}USDT`],
        ),
      );
      const prices = [...updates]
        .filter(([symbol]) => requiredSymbols.has(symbol))
        .map(([symbol, tickerPrice]) => ({ symbol, price: tickerPrice }));
      if (prices.length === 0) return;
      marketUpdateInFlight.current = true;
      void api<{ trades: Trade[]; portfolio: PaperPortfolio }>('/trades/market-prices', {
        method: 'POST',
        body: JSON.stringify({ prices }),
      })
        .then((result) => {
          const updated = new Map(result.data.trades.map((trade) => [trade.id, trade]));
          const statusChanged = result.data.trades.some(
            (trade) => currentOpenTrades.find((current) => current.id === trade.id)?.status !== trade.status,
          );
          setTrades((current) => current.map((trade) => updated.get(trade.id) ?? trade));
          setPortfolio(result.data.portfolio);
          if (statusChanged) void refresh();
        })
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : 'Automatic paper price processing failed.'),
        )
        .finally(() => {
          marketUpdateInFlight.current = false;
        });
    };
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
      socket.onopen = () => {
        retryDelay = 1000;
        if (Date.now() - lastLiveUpdateAt > 3000) setMarketFeedStatus('connecting');
      };
      socket.onmessage = (event) => {
        if (disposed) return;
        let tickers: Array<{ s?: string; c?: string }>;
        lastSocketMessageAt = Date.now();
        try {
          tickers = JSON.parse(String(event.data)) as Array<{ s?: string; c?: string }>;
        } catch {
          setMarketFeedError('The Binance live-price stream sent invalid data.');
          return;
        }
        const updates = new Map<string, number>();
        for (const ticker of tickers) {
          const tickerPrice = Number(ticker.c);
          if (ticker.s && Number.isFinite(tickerPrice) && tickerPrice > 0) {
            updates.set(ticker.s, tickerPrice);
          }
        }
        processPriceUpdates(updates);
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (disposed) return;
        if (Date.now() - lastLiveUpdateAt > 3000) setMarketFeedStatus('reconnecting');
        reconnectTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
    };
    const pollRestPrices = async () => {
      if (disposed || fallbackInFlight || Date.now() - lastSocketMessageAt < 2500) return;
      fallbackInFlight = true;
      const pollStartedAt = Date.now();
      try {
        const response = await fetch('https://fapi.binance.com/fapi/v1/ticker/price', {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Binance returned HTTP ${response.status}.`);
        const tickers: unknown = await response.json();
        if (disposed) return;
        if (!Array.isArray(tickers)) throw new Error('Binance returned an invalid price response.');
        if (lastSocketMessageAt >= pollStartedAt) return;
        const updates = new Map<string, number>();
        for (const ticker of tickers) {
          if (
            typeof ticker === 'object' &&
            ticker !== null &&
            'symbol' in ticker &&
            typeof ticker.symbol === 'string' &&
            'price' in ticker
          ) {
            const tickerPrice = Number(ticker.price);
            if (Number.isFinite(tickerPrice) && tickerPrice > 0) {
              updates.set(ticker.symbol, tickerPrice);
            }
          }
        }
        if (updates.size === 0) throw new Error('Binance returned no valid contract prices.');
        processPriceUpdates(updates);
      } catch (reason) {
        if (!disposed && Date.now() - lastSocketMessageAt >= 2500) {
          setMarketFeedStatus('reconnecting');
          setMarketFeedError(
            reason instanceof Error ? reason.message : 'Unable to load live prices from Binance.',
          );
        }
      } finally {
        fallbackInFlight = false;
      }
    };
    connect();
    fallbackTimer = window.setInterval(() => void pollRestPrices(), 1000);
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(fallbackTimer);
      socket?.close();
    };
  }, [user, risk?.settings.killSwitchEnabled, refresh]);

  const activeTrade = selectedTrade ? (trades.find((trade) => trade.id === selectedTrade) ?? null) : null;
  const openTrades = trades.filter((trade) =>
    ['OPEN', 'TP1_HIT_TRAILING', 'TP2_HIT_TRAILING'].includes(trade.status),
  );
  const todayTrades = useMemo(
    () => trades.filter((trade) => trade.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)),
    [trades],
  );
  const navTo = (destination: Screen) => {
    setSelectedTrade(null);
    setScreen(destination);
    setError('');
  };
  const clearTradePrefill = useCallback(() => setTradePrefill(null), []);
  const fillTradeSetup = (candidate: ScannerCandidate) => {
    if (
      !candidate.setup ||
      candidate.status !== 'READY' ||
      scannerSignalExpiresAt(candidate) <= Date.now() ||
      (candidate.side !== 'LONG' && candidate.side !== 'SHORT')
    ) {
      return;
    }
    setTradePrefill({
      ...candidate.setup,
      symbol: candidate.symbol,
      quoteAsset: candidate.quoteAsset,
      side: candidate.side,
      notes: `${candidate.rationale} Candle closed: ${candidate.lastCandleCloseAt ?? 'unavailable'}. Score ${candidate.score.value ?? 'unavailable'}/100 (${candidate.score.coverage}% factor coverage).`,
    });
    navTo('create');
  };

  const signOut = () => {
    const form = document.getElementById('ethcryptohub-logout-form');
    if (form instanceof HTMLFormElement) {
      form.requestSubmit();
      return;
    }
    setError('Sign out is unavailable. Return to ETHcryptohub and try again.');
  };

  if (authLoading) {
    return (
      <div className="loading-state">
        <span className="spinner" /> Checking your paper account…
      </div>
    );
  }

  if (!user) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="eyebrow">ETHCRYPTOHUB SESSION REQUIRED</div>
          <h1>Your session needs attention.</h1>
          <p>{error || 'Sign in to ETHcryptohub to access your SmartExit paper trading desk.'}</p>
          <a className="button button-primary login-button" href="/login.php">
            Return to sign in →
          </a>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">{icon.brand}</div>
          <span>
            smart<span className="brand-light">exit</span>
          </span>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={screen === 'dashboard' && !activeTrade ? 'nav-item active' : 'nav-item'}
            onClick={() => navTo('dashboard')}
          >
            <span>{icon.dashboard}</span> Overview
          </button>
          <button
            className={screen === 'scanner' ? 'nav-item active' : 'nav-item'}
            onClick={() => navTo('scanner')}
          >
            <span>{icon.scanner}</span> Market scanner
          </button>
          <button
            className={screen === 'create' ? 'nav-item active' : 'nav-item'}
            onClick={() => navTo('create')}
          >
            <span>{icon.create}</span> Trade intents <span className="nav-soon">PAPER</span>
          </button>
          <button
            className={screen === 'risk' ? 'nav-item active' : 'nav-item'}
            onClick={() => navTo('risk')}
          >
            <span>{icon.risk}</span> Risk guardian
          </button>
          <button
            className={screen === 'near' ? 'nav-item active' : 'nav-item'}
            onClick={() => navTo('near')}
          >
            <span>{icon.near}</span> NEAR Intents <span className="nav-soon">STATUS</span>
          </button>
          <button
            className={screen === 'live' ? 'nav-item active' : 'nav-item'}
            onClick={() => navTo('live')}
          >
            <span>{icon.live}</span> Live trades <span className="nav-soon">NOT SET</span>
          </button>
        </nav>
        <div className="workspace-label">ACCOUNT</div>
        <nav aria-label="Account navigation">
          <a className="nav-item" href="/settings.php">
            <span>⚙</span> Profile settings
          </a>
          <a className="nav-item" href="/binance-settings.php">
            <span>⌘</span> Binance API
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-status">
            <span className="status-dot" /> Local database{' '}
            {health?.database === 'connected' ? 'connected' : 'checking'}
          </div>
          <p>
            Built for clarity.
            <br />
            Designed for discipline.
          </p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>SMARTEXIT</span>
            <i>/</i>
            {activeTrade ? 'TRADE DETAIL' : screen.toUpperCase()}
          </div>
          <div className="topbar-actions">
            <a className="button button-outline app-home-link" href="/dashboard.php">
              ETHcryptohub
            </a>
            <span className="mode-pill">
              <span /> {marketFeedStatus === 'live' ? 'LIVE PRICES · PAPER' : 'PAPER MODE'}
            </span>
            <button className="icon-button" aria-label="Refresh dashboard" onClick={() => void refresh()}>
              {icon.refresh}
            </button>
            <span className="wallet-account">
              {user.nearAccountId.startsWith('php-user-')
                ? 'ETHcryptohub account'
                : shortAccount(user.nearAccountId)}
            </span>
            <button className="button button-outline sign-out-button" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </header>
        <div className="paper-notice">
          <span className="notice-icon">{icon.shield}</span>
          <strong>Simulation only</strong>
          <span>— No live exchange orders are sent. Prices and P&L are simulated.</span>
        </div>
        {error && (
          <div role="alert" className="alert error-alert">
            <strong>Something needs attention</strong>
            <span>{error}</span>
            <button onClick={() => void refresh()}>Retry</button>
          </div>
        )}
        {loading && !risk ? (
          <div className="loading-state">
            <span className="spinner" /> Loading your paper desk…
          </div>
        ) : (
          <>
            {activeTrade ? (
              <TradeDetail
                trade={activeTrade}
                events={events.filter((event) => event.tradeId === activeTrade.id)}
                onBack={() => setSelectedTrade(null)}
                onUpdated={refresh}
              />
            ) : (
              screen === 'dashboard' && (
                <Dashboard
                  trades={trades}
                  openTrades={openTrades}
                  todayTrades={todayTrades}
                  portfolio={portfolio}
                  livePrices={livePrices}
                  marketFeedStatus={marketFeedStatus}
                  marketFeedError={marketFeedError}
                  risk={risk}
                  events={events}
                  health={health}
                  onSelect={setSelectedTrade}
                  onCreate={() => navTo('create')}
                  onScan={() => navTo('scanner')}
                />
              )
            )}
            {screen === 'create' && !activeTrade && (
              <CreateTrade
                livePrices={livePrices}
                prefill={tradePrefill}
                onPrefillApplied={clearTradePrefill}
                onCreated={async (trade) => {
                  await refresh();
                  setScreen('dashboard');
                  setSelectedTrade(trade.id);
                }}
                onCancel={() => navTo('dashboard')}
              />
            )}
            {screen === 'scanner' && !activeTrade && <MarketScannerScreen onFillSetup={fillTradeSetup} />}
            {screen === 'risk' && !activeTrade && risk && (
              <RiskSettingsScreen risk={risk} onSaved={refresh} />
            )}
            {screen === 'near' && !activeTrade && (
              <NearIntentsScreen onStartPaperTrade={() => navTo('create')} />
            )}
            {screen === 'live' && !activeTrade && <LiveTradesScreen />}
          </>
        )}
        <footer className="page-footer">
          <span>
            SmartExit <b>·</b> Safety-first paper trading
          </span>
          <span>Not financial advice · Fees, slippage &amp; funding not modeled</span>
        </footer>
      </main>
    </div>
  );
}

function Dashboard(props: {
  trades: Trade[];
  openTrades: Trade[];
  todayTrades: Trade[];
  portfolio: PaperPortfolio | null;
  livePrices: Record<string, { price: number; updatedAt: number }>;
  marketFeedStatus: 'connecting' | 'live' | 'reconnecting';
  marketFeedError: string;
  risk: RiskData | null;
  events: TradeEvent[];
  health: Health | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onScan: () => void;
}) {
  const {
    trades,
    openTrades,
    todayTrades,
    portfolio,
    livePrices,
    marketFeedStatus,
    marketFeedError,
    risk,
    events,
    health,
    onSelect,
    onCreate,
    onScan,
  } = props;
  const dailyUse =
    risk && risk.daily.lossLimit > 0
      ? Math.min(
          100,
          Math.max(0, (Math.abs(Math.min(0, risk.daily.realizedPnl)) / risk.daily.lossLimit) * 100),
        )
      : 0;
  const closedTrades = trades.filter(
    (trade) => !['OPEN', 'TP1_HIT_TRAILING', 'TP2_HIT_TRAILING'].includes(trade.status),
  );
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            YOUR PAPER DESK <span className="live-dot" /> LIVE SIMULATION
          </div>
          <h1>
            Good trading starts
            <br className="heading-break" /> with a clear plan.
          </h1>
          <p>Practice your exit rules. Your capital stays untouched.</p>
        </div>
        <div className="scanner-actions">
          <button className="button button-outline" onClick={onScan}>
            View READY setups
          </button>
          <button className="button button-primary" onClick={onCreate}>
            <span>+</span> Create paper trade
          </button>
        </div>
      </div>
      <div className="summary-grid">
        <SummaryCard
          label="USDT PAPER EQUITY"
          value={portfolio ? money(portfolio.totalEquity) : '—'}
          detail={
            portfolio
              ? `USDT cash ${money(portfolio.cashBalance)} · P&L ${money(portfolio.realizedPnl + portfolio.unrealizedPnl)}${
                  portfolio.assetBalances.some((balance) => balance.asset !== 'USDT')
                    ? ` · Other: ${portfolio.assetBalances
                        .filter((balance) => balance.asset !== 'USDT')
                        .map(
                          (balance) =>
                            `${formatAssetAmount(balance.cashBalance + balance.unrealizedPnl, balance.asset)}`,
                        )
                        .join(', ')}`
                    : ''
                }`
              : 'Portfolio unavailable'
          }
          iconText="◎"
          tone="green"
        />
        <SummaryCard
          label="LIVE MARKET FEED"
          value={
            marketFeedStatus === 'live'
              ? 'Connected'
              : marketFeedStatus === 'reconnecting'
                ? 'Reconnecting'
                : 'Connecting'
          }
          detail={
            marketFeedError
              ? marketFeedError
              : marketFeedStatus === 'live'
                ? 'Prices, paper exits and P&L update every second'
                : 'Waiting for Binance WebSocket or REST price feed'
          }
          iconText="↻"
          tone={marketFeedStatus === 'live' ? 'green' : 'amber'}
        />
        <SummaryCard
          label="OPEN POSITIONS"
          value={String(openTrades.length).padStart(2, '0')}
          detail={risk ? `of ${risk.settings.maxOpenPositions} allowed` : 'Risk settings unavailable'}
          iconText="↗"
          tone="blue"
        />
        <SummaryCard
          label="REALIZED TODAY"
          value={money(risk?.daily.realizedPnl ?? 0)}
          detail={`${todayTrades.length} new ${todayTrades.length === 1 ? 'position' : 'positions'} today`}
          iconText="↗"
          tone={(risk?.daily.realizedPnl ?? 0) < 0 ? 'red' : 'green'}
        />
        <SummaryCard
          label="DAILY RISK USED"
          value={`${dailyUse.toFixed(0)}%`}
          detail={
            risk
              ? `${money(Math.max(0, risk.daily.lossLimit - Math.abs(Math.min(0, risk.daily.realizedPnl))))} loss room left`
              : 'Risk settings unavailable'
          }
          iconText="⌁"
          tone="amber"
          progress={dailyUse}
        />
        <SummaryCard
          label="SYSTEM STATUS"
          value={health?.database === 'connected' ? 'Ready' : 'Offline'}
          detail={risk?.settings.killSwitchEnabled ? 'Kill switch is engaged' : 'Local storage connected'}
          iconText="◇"
          tone={health?.database === 'connected' ? 'green' : 'red'}
        />
      </div>
      <div className="section-heading">
        <div>
          <h2>
            Open positions <span className="count-badge">{openTrades.length}</span>
          </h2>
          <p>Your simulated trades, managed by the rules you set.</p>
        </div>
        <button className="text-button" onClick={onCreate}>
          + New position
        </button>
      </div>
      <div className="table-card">
        {openTrades.length === 0 ? (
          <EmptyState
            title="No open positions yet"
            message="Create a paper trade to test your exit plan. No exchange is connected."
            action="Create paper trade"
            onAction={onCreate}
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>MARKET</th>
                  <th>SIDE</th>
                  <th>ENTRY / CURRENT</th>
                  <th>EXIT PROGRESS</th>
                  <th>PROTECTIVE STOP</th>
                  <th>SIMULATED P&amp;L</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {openTrades.map((trade) => (
                  <tr key={trade.id} onClick={() => onSelect(trade.id)} className="clickable-row">
                    <td>
                      <strong className="market-symbol">{trade.symbol}</strong>
                      <small>USDⓈ-M · Paper</small>
                    </td>
                    <td>
                      <span className={`side-pill ${trade.side.toLowerCase()}`}>{trade.side}</span>
                    </td>
                    <td>
                      <span>{price(trade.entryPrice)}</span>
                      <small className="current-price">
                        Now {price(livePrices[trade.symbol]?.price ?? trade.currentPrice)}
                      </small>
                    </td>
                    <td>
                      <span className="progress-pill">
                        {trade.status === 'OPEN'
                          ? 'TP 0 / 3'
                          : trade.status.replace('_HIT_TRAILING', '').replace('TP', 'TP ') + ' / 3'}
                      </span>
                      <small>{trade.trailingActive ? 'Trailing active' : 'Waiting for TP1'}</small>
                    </td>
                    <td>
                      {price(trade.trailingStop ?? trade.initialStop)}
                      <small>{trade.trailingActive ? 'Trailing stop' : 'Initial stop'}</small>
                    </td>
                    <td className={pnl(trade) >= 0 ? 'positive' : 'negative'}>
                      {formatAssetAmount(pnl(trade), trade.quoteAsset)}
                      <small>Unrealized · quote asset</small>
                    </td>
                    <td>
                      <button
                        className="row-arrow"
                        aria-label={`View ${trade.symbol} details`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(trade.id);
                        }}
                      >
                        ↗
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="section-heading">
        <div>
          <h2>Live trades · disabled</h2>
          <p>Binance market data is live; order execution remains paper-only.</p>
        </div>
        <span className="nav-soon">NO ORDERS</span>
      </div>
      <div className="table-card">
        <div className="empty-state">
          <div className="empty-icon">◉</div>
          <h3>Real-money execution is disabled</h3>
          <p>Signals can be reviewed and copied into paper trades. No live Binance orders are triggered.</p>
        </div>
      </div>
      <div className="section-heading closed-positions-heading">
        <div>
          <h2>
            Closed positions <span className="count-badge">{closedTrades.length}</span>
          </h2>
          <p>Completed and cancelled paper trades.</p>
        </div>
      </div>
      <div className="table-card">
        {closedTrades.length === 0 ? (
          <div className="quiet-empty closed-empty">
            Closed positions will appear here when a paper trade ends.
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>MARKET</th>
                  <th>SIDE</th>
                  <th>ENTRY / EXIT</th>
                  <th>RESULT</th>
                  <th>SIMULATED P&amp;L</th>
                  <th>CLOSED</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {closedTrades.map((trade) => (
                  <tr key={trade.id} onClick={() => onSelect(trade.id)} className="clickable-row">
                    <td>
                      <strong className="market-symbol">{trade.symbol}</strong>
                      <small>USDⓈ-M · Paper</small>
                    </td>
                    <td>
                      <span className={`side-pill ${trade.side.toLowerCase()}`}>{trade.side}</span>
                    </td>
                    <td>
                      <span>{price(trade.entryPrice)}</span>
                      <small>Exit {trade.exitPrice === null ? '—' : price(trade.exitPrice)}</small>
                    </td>
                    <td>
                      <span className="status-pill status-closed">{trade.status.replaceAll('_', ' ')}</span>
                    </td>
                    <td className={(trade.realizedPnl ?? 0) >= 0 ? 'positive' : 'negative'}>
                      {formatAssetAmount(trade.realizedPnl ?? 0, trade.quoteAsset)}
                      <small>Realized · quote asset</small>
                    </td>
                    <td>{trade.closedAt ? new Date(trade.closedAt).toLocaleString() : '—'}</td>
                    <td>
                      <button
                        className="row-arrow"
                        aria-label={`View ${trade.symbol} details`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(trade.id);
                        }}
                      >
                        ↗
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="lower-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h3>Recent activity</h3>
              <p>An auditable record of simulation events.</p>
            </div>
            <span className="event-mark">↻</span>
          </div>
          {events.length === 0 ? (
            <p className="quiet-empty">Events will appear here after you create a trade.</p>
          ) : (
            <EventList events={events.slice(0, 5)} />
          )}
        </section>
        <section className="panel market-note">
          <div className="panel-heading">
            <div>
              <h3>Made for deliberate exits.</h3>
              <p>Rules, not reactions.</p>
            </div>
            <span className="compass">✳</span>
          </div>
          <p>
            TP1 activates your trailing stop. TP2 is a milestone, not a partial sale. The full simulated
            position closes at TP3 or a protective stop.
          </p>
          <div className="health-line">
            <span className="status-dot" /> DATABASE{' '}
            <b>{health?.database === 'connected' ? 'CONNECTED' : 'UNAVAILABLE'}</b>
          </div>
        </section>
      </div>
      {trades.length > 0 && (
        <div className="subtle-count">Showing {Math.min(trades.length, 200)} most recent paper trades</div>
      )}
    </section>
  );
}

const SCANNER_TIMEFRAME_MS: Record<ScannerCandidate['timeframe'], number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

function scannerSignalExpiresAt(candidate: ScannerCandidate): number {
  const candleCloseAt = candidate.lastCandleCloseAt ? Date.parse(candidate.lastCandleCloseAt) : NaN;
  return Number.isFinite(candleCloseAt) ? candleCloseAt + SCANNER_TIMEFRAME_MS[candidate.timeframe] : 0;
}

function formatSignalCountdown(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function LiveTradesScreen() {
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">EXECUTION STATUS · DISABLED</div>
          <h1>Live trades</h1>
          <p>Real-money execution is disabled. No valid READY signal means no trade; no order is sent from this page.</p>
        </div>
        <span className="mode-pill">LIVE ORDERS OFF</span>
      </div>
      <div className="scanner-safety-note">
        Mainnet execution requires a fresh signal, an explicit final order confirmation, verified Binance
        Futures permissions, available-margin and 1% equity-risk checks, duplicate-order protection, and
        confirmed protective orders. Do not grant withdrawal permission to an API key.
      </div>
      <div className="table-card">
        <div className="empty-state">
          <div className="empty-icon">◉</div>
          <h3>Live execution is not enabled</h3>
          <p>
            Configure and test your account connection in Binance API settings. This does not enable trading:
            live order submission remains disabled until its safeguards are implemented and explicitly enabled.
          </p>
          <a className="button button-outline" href="/binance-settings.php">
            Open Binance API settings
          </a>
        </div>
      </div>
    </section>
  );
}

function MarketScannerScreen({ onFillSetup }: { onFillSetup: (candidate: ScannerCandidate) => void }) {
  const [controls, setControls] = useState({
    timeframe: '15m' as ScannerCandidate['timeframe'],
    minimumVolume: 10_000_000,
    limit: 1000,
    atrPeriod: 10,
    multiplier: 3,
    maxAgeSeconds: 1800,
    minimumScore: 60,
  });
  const [data, setData] = useState<MarketScannerResponse | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [sideFilter, setSideFilter] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [marketFilter, setMarketFilter] = useState<'ALL' | 'TOP_GAINER' | 'TOP_LOSER' | 'TOP_VOLUME'>('ALL');
  const [sortBy, setSortBy] = useState<'score' | 'volume' | 'newest'>('score');
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const requestId = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    const currentRequestId = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      Object.entries(controls).forEach(([key, value]) => params.set(key, String(value)));
      params.set('quoteAsset', 'USDT');
      const result = await api<MarketScannerResponse>(`/market-scanner/candidates?${params}`);
      if (currentRequestId !== requestId.current) return;
      setData(result.data);
      const readyCandidates = result.data.candidates.filter(
        (candidate) => candidate.status === 'READY' && scannerSignalExpiresAt(candidate) > Date.now(),
      );
      setSelectedSymbol((current) =>
        current && readyCandidates.some((candidate) => candidate.symbol === current)
          ? current
          : (readyCandidates[0]?.symbol ?? ''),
      );
    } catch (reason) {
      if (currentRequestId !== requestId.current) return;
      setError(reason instanceof Error ? reason.message : 'Market scanner could not load live data.');
    } finally {
      if (currentRequestId === requestId.current) setLoading(false);
    }
  }, [controls]);

  useEffect(() => {
    if (paused) return;
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load, paused]);

  const readyCandidates = (data?.candidates ?? []).filter(
    (candidate) => candidate.status === 'READY' && scannerSignalExpiresAt(candidate) > now,
  );
  const candidates = readyCandidates
    .filter((candidate) => sideFilter === 'ALL' || candidate.side === sideFilter)
    .filter((candidate) => marketFilter === 'ALL' || candidate.marketRank.includes(marketFilter))
    .sort((left, right) => {
      if (sortBy === 'volume') return right.quoteVolume24h - left.quoteVolume24h;
      if (sortBy === 'newest') {
        return Date.parse(right.lastCandleCloseAt ?? '') - Date.parse(left.lastCandleCloseAt ?? '');
      }
      return (right.score.value ?? -1) - (left.score.value ?? -1);
    });
  const selected =
    candidates.find((candidate) => candidate.symbol === selectedSymbol) ?? candidates[0] ?? null;
  const setControl = <K extends keyof typeof controls>(key: K, value: (typeof controls)[K]) =>
    setControls((current) => ({ ...current, [key]: value }));

  return (
    <section className="page scanner-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            PAPER TRADING <span className="eyebrow-separator">/</span> BINANCE USDⓈ-M FUTURES
          </div>
          <h1>Market scanner.</h1>
          <p>Scans every eligible Binance USDT-M perpetual using completed candles. A score is not a probability of profit.</p>
        </div>
        <div className="scanner-actions">
          <button className="button button-outline" onClick={() => setPaused((current) => !current)}>
            {paused ? 'Resume refresh' : 'Pause refresh'}
          </button>
          <button className="button button-primary" onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
      </div>
      <div className="scanner-safety-note">
        Scanner proposals are review-only. Selecting “Fill Paper Trade Form” does not create a position or
        send an exchange order. Signals use Binance public prices and completed candles; they do not include
        verified news sentiment, liquidation heatmaps, or smart-money flow data, and cannot guarantee returns.
      </div>
      <section className="panel scanner-controls" aria-label="Scanner controls">
        <label className="field">
          <span>Quote asset</span>
          <select value="USDT" disabled aria-label="Quote asset">
            <option value="USDT">USDT</option>
          </select>
        </label>
        <label className="field">
          <span>Market type</span>
          <select value="USDⓈ-M FUTURES" disabled aria-label="Market type">
            <option>USDⓈ-M FUTURES</option>
          </select>
        </label>
        <label className="field">
          <span>Timeframe</span>
          <select
            value={controls.timeframe}
            onChange={(event) => {
              const timeframe = event.target.value as ScannerCandidate['timeframe'];
              setControls((current) => ({
                ...current,
                timeframe,
                maxAgeSeconds:
                  timeframe === '5m' ? 600 : timeframe === '15m' ? 1800 : timeframe === '1h' ? 7200 : 28800,
              }));
            }}
          >
            {(['5m', '15m', '1h', '4h'] as const).map((timeframe) => (
              <option key={timeframe}>{timeframe}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Minimum 24h volume</span>
          <input
            type="number"
            min="0"
            value={controls.minimumVolume}
            onChange={(event) => setControl('minimumVolume', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>ATR period</span>
          <input
            type="number"
            min="2"
            max="50"
            value={controls.atrPeriod}
            onChange={(event) => setControl('atrPeriod', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>Supertrend multiplier</span>
          <input
            type="number"
            min="0.5"
            max="10"
            step="0.1"
            value={controls.multiplier}
            onChange={(event) => setControl('multiplier', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>Minimum setup score</span>
          <input
            type="number"
            min="0"
            max="100"
            value={controls.minimumScore}
            onChange={(event) => setControl('minimumScore', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>Maximum data age (seconds)</span>
          <input
            type="number"
            min="30"
            max="86400"
            value={controls.maxAgeSeconds}
            onChange={(event) => setControl('maxAgeSeconds', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>Side</span>
          <select
            value={sideFilter}
            onChange={(event) => setSideFilter(event.target.value as typeof sideFilter)}
          >
            {['ALL', 'LONG', 'SHORT'].map((side) => (
              <option key={side}>{side}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Market list</span>
          <select
            value={marketFilter}
            onChange={(event) => setMarketFilter(event.target.value as typeof marketFilter)}
          >
            <option value="ALL">All candidates</option>
            <option value="TOP_GAINER">Top gainers</option>
            <option value="TOP_LOSER">Top losers</option>
            <option value="TOP_VOLUME">Top volume</option>
          </select>
        </label>
        <label className="field">
          <span>Sort by</span>
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>
            <option value="score">Setup score</option>
            <option value="volume">24h volume</option>
            <option value="newest">Newest signal</option>
          </select>
        </label>
      </section>
      {error && (
        <div role="alert" className="alert error-alert">
          <strong>Live scanner data unavailable</strong>
          <span>{error}</span>
          <button onClick={() => void load()}>Retry</button>
        </div>
      )}
      <div className="scanner-meta" role="status">
        <span className={data?.status === 'LIVE' ? 'scanner-live' : 'scanner-degraded'}>
          {data?.status === 'LIVE' ? 'LIVE DATA' : (data?.status ?? 'CONNECTING')}
        </span>
        <span>
          {data
            ? `${readyCandidates.length} READY signals · WAIT, stale, and unavailable signals hidden`
            : 'Waiting for Binance data'}
        </span>
        <span>{data ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()}` : ''}</span>
        <span>{paused ? 'Automatic refresh paused' : 'Refreshes every 30 seconds'}</span>
      </div>
      <div className="scanner-layout">
        <section className="scanner-results" aria-label="Ranked market candidates">
          {loading && !data ? (
            <div className="panel scanner-empty">Loading live Binance candles…</div>
          ) : candidates.length === 0 ? (
            <div className="panel scanner-empty">
              {readyCandidates.length === 0
                ? 'No active READY signals right now. WAIT and stale signals are hidden; refresh for the latest completed-candle analysis.'
                : 'No READY signals match these filters. No setup is forced when evidence is missing or conflicting.'}
            </div>
          ) : (
            candidates.map((candidate) => (
              <button
                type="button"
                key={candidate.symbol}
                className={`panel scanner-candidate${selectedSymbol === candidate.symbol ? ' selected' : ''}`}
                onClick={() => {
                  setSelectedSymbol(candidate.symbol);
                  void load();
                }}
              >
                <span className="scanner-candidate-top">
                  <strong>{candidate.symbol}</strong>
                  <span className={`scanner-badge ${candidate.side.toLowerCase()}`}>{candidate.side}</span>
                </span>
                <span className="scanner-rank-tags">
                  {candidate.marketRank.map((rank) => (
                    <span key={rank}>{rank.replace('_', ' ')}</span>
                  ))}
                </span>
                <span className="scanner-candidate-stats">
                  <span>
                    Price <b>{candidate.price === null ? '—' : price(candidate.price)}</b>
                  </span>
                  <span>
                    24h volume{' '}
                    <b>
                      {formatVolume(candidate.quoteVolume24h)} {candidate.quoteAsset}
                    </b>
                  </span>
                  <span>
                    EMA trend <b>{candidate.ema.direction}</b>
                  </span>
                  <span>
                    Relative volume{' '}
                    <b>
                      {candidate.relativeVolume === null ? '—' : `${candidate.relativeVolume.toFixed(2)}×`}
                    </b>
                  </span>
                </span>
                <span className="scanner-candidate-bottom">
                  <span>
                    Score {candidate.score.value ?? '—'} / 100 · {candidate.score.coverage}% coverage
                  </span>
                  <span className="scanner-countdown">
                    READY · {formatSignalCountdown(scannerSignalExpiresAt(candidate) - now)}
                  </span>
                </span>
              </button>
            ))
          )}
        </section>
        <aside className="panel scanner-detail">
          {selected ? (
            <>
              <div className="scanner-detail-heading">
                <div>
                  <div className="eyebrow">CANDIDATE REVIEW</div>
                  <h2>{selected.symbol}</h2>
                </div>
                <span className={`scanner-badge ${selected.side.toLowerCase()}`}>{selected.side}</span>
              </div>
              <p className="scanner-rationale">{selected.rationale}</p>
              <div className="scanner-detail-grid">
                <div>
                  <span>Supertrend</span>
                  <strong>{selected.supertrend.direction}</strong>
                </div>
                <div>
                  <span>EMA 9 / 20 / 50 / 100 / 200</span>
                  <strong>
                    {selected.ema.ema9 === null ||
                    selected.ema.ema20 === null ||
                    selected.ema.ema50 === null ||
                    selected.ema.ema100 === null ||
                    selected.ema.ema200 === null
                      ? 'Unavailable'
                      : `${price(selected.ema.ema9)} / ${price(selected.ema.ema20)} / ${price(selected.ema.ema50)} / ${price(selected.ema.ema100)} / ${price(selected.ema.ema200)}`}
                  </strong>
                </div>
                <div>
                  <span>ATR ({selected.supertrend.period})</span>
                  <strong>{selected.supertrend.atr === null ? '—' : price(selected.supertrend.atr)}</strong>
                </div>
                <div>
                  <span>Support / resistance</span>
                  <strong>
                    {selected.supportResistance.support === null
                      ? '—'
                      : price(selected.supportResistance.support)}{' '}
                    /{' '}
                    {selected.supportResistance.resistance === null
                      ? '—'
                      : price(selected.supportResistance.resistance)}
                  </strong>
                </div>
                <div>
                  <span>24h change</span>
                  <strong>
                    {selected.priceChangePercent24h === null
                      ? '—'
                      : `${selected.priceChangePercent24h.toFixed(2)}%`}
                  </strong>
                </div>
                <div>
                  <span>Relative volume</span>
                  <strong>
                    {selected.relativeVolume === null ? '—' : `${selected.relativeVolume.toFixed(2)}×`}
                  </strong>
                </div>
                <div>
                  <span>Score / coverage</span>
                  <strong>
                    {selected.score.value ?? '—'} / 100 · {selected.score.coverage}%
                  </strong>
                </div>
                <div>
                  <span>Last completed candle</span>
                  <strong>
                    {selected.lastCandleCloseAt
                      ? new Date(selected.lastCandleCloseAt).toLocaleString()
                      : 'Unavailable'}
                  </strong>
                </div>
              </div>
              <h3>Technical confirmation</h3>
              <div className="scanner-detail-grid">
                <div>
                  <span>RSI (14)</span>
                  <strong>{selected.indicators.rsi14 === null ? '—' : selected.indicators.rsi14.toFixed(1)}</strong>
                </div>
                <div>
                  <span>MACD (12 / 26 / 9)</span>
                  <strong>
                    {selected.indicators.macdHistogram === null
                      ? '—'
                      : `Histogram ${selected.indicators.macdHistogram.toPrecision(5)}`}
                  </strong>
                </div>
                <div>
                  <span>Rolling VWAP (20 candles)</span>
                  <strong>
                    {selected.indicators.rollingVwap20 === null ? '—' : price(selected.indicators.rollingVwap20)}
                  </strong>
                </div>
                <div>
                  <span>Bollinger Bands (20, 2σ)</span>
                  <strong>
                    {selected.indicators.bollingerBands20 === null
                      ? '—'
                      : `${price(selected.indicators.bollingerBands20.lower)} / ${price(selected.indicators.bollingerBands20.middle)} / ${price(selected.indicators.bollingerBands20.upper)}`}
                  </strong>
                </div>
                <div>
                  <span>ADX (14)</span>
                  <strong>{selected.indicators.adx14 === null ? '—' : selected.indicators.adx14.toFixed(1)}</strong>
                </div>
              </div>
              <h3>Score breakdown</h3>
              <div className="scanner-breakdown">
                {selected.score.contributions.map((factor) => (
                  <div key={factor.factor}>
                    <span>
                      {factor.factor} <small>{factor.weight}% weight</small>
                    </span>
                    <strong>
                      {factor.value.toFixed(0)}/100 · +{factor.contribution}
                    </strong>
                  </div>
                ))}
                <p>
                  Available factor weights are normalized. Missing swing levels are excluded, not treated as
                  positive evidence. This score is not a probability of profit.
                </p>
              </div>
              {selected.setup && (
                <>
                  <h3>Proposed paper setup</h3>
                  <div className="scanner-levels">
                    <span>
                      Entry{' '}
                      <b>
                        {price(selected.setup.entryPrice)} {selected.quoteAsset}
                      </b>
                    </span>
                    <span>
                      Quantity{' '}
                      <b>
                        {selected.setup.quantity} {selected.baseAsset}
                      </b>
                    </span>
                    <span>
                      Initial stop <b>{price(selected.setup.initialStop)}</b>
                    </span>
                    <span>
                      Trailing distance <b>{selected.setup.trailingPercent.toFixed(2)}%</b>
                    </span>
                    <span>
                      TP1 / 1R <b>{price(selected.setup.tp1)}</b>
                    </span>
                    <span>
                      TP2 / 2R <b>{price(selected.setup.tp2)}</b>
                    </span>
                    <span>
                      TP3 / 3R <b>{price(selected.setup.tp3)}</b>
                    </span>
                    <span>
                      Estimated risk{' '}
                      <b>
                        {price(selected.setup.estimatedRisk)} {selected.quoteAsset}
                      </b>
                    </span>
                  </div>
                  <p className="scanner-stale-note">
                    Reference prices may change before you submit. Review and edit every value in the trade
                    form.
                  </p>
                  <button
                    className="button button-primary scanner-fill"
                    onClick={() => onFillSetup(selected)}
                  >
                    Fill Paper Trade Form
                  </button>
                </>
              )}
              {selected.warnings.length > 0 && (
                <div className="scanner-warnings">
                  <strong>Data notes and warnings</strong>
                  <ul>
                    {selected.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="scanner-empty">
              Select a candidate to review its signal evidence and risk proposal.
            </div>
          )}
        </aside>
      </div>
      {data && (
        <small className="scanner-source">
          Source: {data.source}. Candles use completed Binance USDⓈ-M futures klines. Public market data only.
        </small>
      )}
    </section>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  iconText,
  tone,
  progress,
}: {
  label: string;
  value: string;
  detail: string;
  iconText: string;
  tone: string;
  progress?: number;
}) {
  return (
    <article className="summary-card">
      <div className="card-topline">
        <span>{label}</span>
        <span className={`metric-icon ${tone}`}>{iconText}</span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail">{detail}</div>
      {progress !== undefined && (
        <div className="progress-track">
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
    </article>
  );
}

function CreateTrade({
  onCreated,
  onCancel,
  livePrices,
  prefill,
  onPrefillApplied,
}: {
  onCreated: (trade: Trade) => Promise<void>;
  onCancel: () => void;
  livePrices: Record<string, { price: number; updatedAt: number }>;
  prefill: ScannerPrefill | null;
  onPrefillApplied: () => void;
}) {
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [markets, setMarkets] = useState<FuturesMarkets | null>(null);
  const [marketsError, setMarketsError] = useState('');
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [symbolSearch, setSymbolSearch] = useState('');
  const [quoteAsset, setQuoteAsset] = useState('USDT');
  const [minimumVolume, setMinimumVolume] = useState('0');
  const [values, setValues] = useState({
    symbol: 'BTCUSDT',
    entryPrice: '',
    quantity: '0.01',
    initialStop: '64000',
    tp1: '66000',
    tp2: '67000',
    tp3: '68000',
    trailingPercent: '1',
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const entry = Number(values.entryPrice);
  const quantity = Number(values.quantity);
  const stop = Number(values.initialStop);
  const estRisk = entry > 0 && stop > 0 && quantity > 0 ? Math.abs(entry - stop) * quantity : null;
  const set = (key: keyof typeof values, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const loadMarkets = async () => {
    setMarketsLoading(true);
    setMarketsError('');
    try {
      const result = await api<FuturesMarkets>('/markets/futures-symbols');
      setMarkets(result.data);
      setQuoteAsset((current) =>
        result.data.symbols.some((item) => item.quoteAsset === current)
          ? current
          : (result.data.symbols[0]?.quoteAsset ?? 'USDT'),
      );
      if (!result.data.symbols.some((item) => item.symbol === values.symbol)) {
        set(
          'symbol',
          result.data.symbols.find((item) => item.quoteAsset === 'USDT')?.symbol ??
            result.data.symbols[0]?.symbol ??
            '',
        );
      }
    } catch (reason) {
      setMarketsError(reason instanceof Error ? reason.message : 'Binance futures symbols are unavailable.');
    } finally {
      setMarketsLoading(false);
    }
  };

  useEffect(() => {
    void loadMarkets();
  }, []);

  useEffect(() => {
    if (!prefill) return;
    setSide(prefill.side);
    setQuoteAsset(prefill.quoteAsset);
    setValues((current) => ({
      ...current,
      symbol: prefill.symbol,
      entryPrice: String(prefill.entryPrice),
      quantity: String(prefill.quantity),
      initialStop: String(prefill.initialStop),
      trailingPercent: String(prefill.trailingPercent),
      tp1: String(prefill.tp1),
      tp2: String(prefill.tp2),
      tp3: String(prefill.tp3),
      notes: prefill.notes,
    }));
    onPrefillApplied();
  }, [prefill, onPrefillApplied]);

  const availableQuoteAssets = [...new Set(markets?.symbols.map((item) => item.quoteAsset) ?? [])].sort();
  const visibleMarkets = (markets?.symbols ?? [])
    .filter((item) => item.quoteAsset === quoteAsset)
    .filter((item) => item.quoteVolume24h >= Number(minimumVolume))
    .filter((item) => item.symbol.toLowerCase().includes(symbolSearch.trim().toLowerCase()))
    .sort(
      (left, right) => right.quoteVolume24h - left.quoteVolume24h || left.symbol.localeCompare(right.symbol),
    );

  useEffect(() => {
    if (visibleMarkets.length > 0 && !visibleMarkets.some((item) => item.symbol === values.symbol)) {
      set('symbol', visibleMarkets[0]!.symbol);
    }
  }, [quoteAsset, minimumVolume, symbolSearch, markets]);

  const selectedMarket = markets?.symbols.find((item) => item.symbol === values.symbol) ?? null;
  const currentMarketPrice = livePrices[values.symbol]?.price ?? selectedMarket?.lastPrice ?? null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<Trade>('/trades', {
        method: 'POST',
        body: JSON.stringify({
          ...values,
          quoteAsset: selectedMarket?.quoteAsset ?? 'USDT',
          side,
          entryPrice: entry,
          quantity,
          initialStop: stop,
          tp1: Number(values.tp1),
          tp2: Number(values.tp2),
          tp3: Number(values.tp3),
          trailingPercent: Number(values.trailingPercent),
        }),
      });
      await onCreated(result.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Trade could not be created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page form-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            PAPER TRADING <span className="eyebrow-separator">/</span> NEW POSITION
          </div>
          <h1>Plan your exit.</h1>
          <p>Set your levels up front. The backend checks every rule.</p>
        </div>
        <span className="form-step">
          01 <i>/</i> 01
        </span>
      </div>
      <form className="form-layout" onSubmit={(event) => void submit(event)}>
        <div className="form-main panel">
          <div className="form-section">
            <h3>Position details</h3>
            <p>All values are simulated. No live orders will be placed.</p>
            <div className="field-grid">
              <div className="field full market-selector">
                <span>Binance USDⓈ-M futures contract</span>
                {marketsError ? (
                  <>
                    <div className="market-error" role="alert">
                      <span>
                        {marketsError} Pair data is not available; manually entered symbols are unverified.
                      </span>
                      <button type="button" onClick={() => void loadMarkets()} disabled={marketsLoading}>
                        {marketsLoading ? 'Retrying…' : 'Retry'}
                      </button>
                    </div>
                    <input
                      aria-label="Manual unverified market symbol"
                      value={values.symbol}
                      onChange={(event) => set('symbol', event.target.value.toUpperCase())}
                      required
                      minLength={2}
                      maxLength={20}
                      autoComplete="off"
                    />
                  </>
                ) : (
                  <>
                    <div className="market-filters">
                      <label className="field">
                        <span>Quote asset</span>
                        <select
                          aria-label="Filter by quote asset"
                          value={quoteAsset}
                          onChange={(event) => setQuoteAsset(event.target.value)}
                          disabled={marketsLoading || availableQuoteAssets.length === 0}
                        >
                          {availableQuoteAssets.map((asset) => (
                            <option key={asset} value={asset}>
                              {asset}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>Minimum 24h volume ({quoteAsset})</span>
                        <select
                          aria-label="Filter by minimum 24-hour volume"
                          value={minimumVolume}
                          onChange={(event) => setMinimumVolume(event.target.value)}
                          disabled={marketsLoading}
                        >
                          <option value="0">All volumes</option>
                          <option value="100000">100K+</option>
                          <option value="1000000">1M+</option>
                          <option value="10000000">10M+</option>
                          <option value="100000000">100M+</option>
                        </select>
                      </label>
                    </div>
                    <label className="field">
                      <span>Find a pair</span>
                      <input
                        aria-label="Search futures pairs"
                        value={symbolSearch}
                        onChange={(event) => setSymbolSearch(event.target.value.toUpperCase())}
                        placeholder="Search symbols"
                        autoComplete="off"
                      />
                    </label>
                    <label className="field">
                      <span>Pair · {visibleMarkets.length} shown, highest volume first</span>
                      <select
                        aria-label="Select Binance futures pair"
                        value={
                          visibleMarkets.some((item) => item.symbol === values.symbol) ? values.symbol : ''
                        }
                        onChange={(event) => set('symbol', event.target.value)}
                        required
                        disabled={marketsLoading || visibleMarkets.length === 0}
                      >
                        {marketsLoading ? (
                          <option value="">Loading Binance markets…</option>
                        ) : visibleMarkets.length === 0 ? (
                          <option value="">No pairs match these filters</option>
                        ) : (
                          visibleMarkets.map((item) => (
                            <option key={item.symbol} value={item.symbol}>
                              {item.symbol} ·{' '}
                              {livePrices[item.symbol] ? price(livePrices[item.symbol]!.price) : '—'} ·{' '}
                              {formatVolume(item.quoteVolume24h)} {item.quoteAsset}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                    {selectedMarket && (
                      <div className="market-reference">
                        <span>
                          {selectedMarket.contractType.replaceAll('_', ' ')} · Actual Binance 24h volume:{' '}
                          {formatVolume(selectedMarket.quoteVolume24h)} {selectedMarket.quoteAsset}
                        </span>
                        {currentMarketPrice !== null && (
                          <button
                            type="button"
                            onClick={() => set('entryPrice', String(currentMarketPrice))}
                            title="Copy the live ticker into the editable paper entry price"
                          >
                            {livePrices[values.symbol] ? 'Live' : 'Snapshot'} price{' '}
                            {price(currentMarketPrice)}
                          </button>
                        )}
                      </div>
                    )}
                    {markets && (
                      <small className="market-source">
                        Live reference data · {markets.symbols.length} active USDⓈ-M futures contracts ·
                        Updated {new Date(markets.updatedAt).toLocaleTimeString()}
                      </small>
                    )}
                    {!marketsLoading && visibleMarkets.length === 0 && (
                      <small className="market-empty">
                        No active pairs match the selected quote asset, search, and minimum volume.
                      </small>
                    )}
                  </>
                )}
              </div>
              <fieldset className="side-select full">
                <legend>Position side</legend>
                <div>
                  <button
                    type="button"
                    className={side === 'LONG' ? 'side-choice selected long-choice' : 'side-choice'}
                    onClick={() => setSide('LONG')}
                  >
                    <b>↗</b> Long <small>Profit if price rises</small>
                  </button>
                  <button
                    type="button"
                    className={side === 'SHORT' ? 'side-choice selected short-choice' : 'side-choice'}
                    onClick={() => setSide('SHORT')}
                  >
                    <b>↘</b> Short <small>Profit if price falls</small>
                  </button>
                </div>
              </fieldset>
              <NumberField
                label={`Entry price (${selectedMarket?.quoteAsset ?? 'USDT'})`}
                value={values.entryPrice}
                onChange={(value) => set('entryPrice', value)}
                prefix={selectedMarket?.quoteAsset ?? 'USDT'}
              />
              <NumberField
                label="Quantity"
                value={values.quantity}
                onChange={(value) => set('quantity', value)}
                suffix={selectedMarket?.baseAsset ?? 'BTC'}
              />
            </div>
          </div>
          <div className="form-section level-section">
            <div className="section-title-row">
              <div>
                <h3>Exit levels</h3>
                <p>Targets must be correctly ordered for your {side.toLowerCase()}.</p>
              </div>
              <span className="rule-label">RULE BASED</span>
            </div>
            <div className="field-grid">
              <NumberField
                label="Initial stop-loss"
                value={values.initialStop}
                onChange={(value) => set('initialStop', value)}
                prefix={selectedMarket?.quoteAsset ?? 'USDT'}
                tone="stop"
              />
              <NumberField
                label="Trailing distance"
                value={values.trailingPercent}
                onChange={(value) => set('trailingPercent', value)}
                suffix="%"
              />
              <NumberField
                label="Take profit 1"
                value={values.tp1}
                onChange={(value) => set('tp1', value)}
                prefix={selectedMarket?.quoteAsset ?? 'USDT'}
                tone="target"
              />
              <NumberField
                label="Take profit 2"
                value={values.tp2}
                onChange={(value) => set('tp2', value)}
                prefix={selectedMarket?.quoteAsset ?? 'USDT'}
                tone="target"
              />
              <NumberField
                label="Take profit 3"
                value={values.tp3}
                onChange={(value) => set('tp3', value)}
                prefix={selectedMarket?.quoteAsset ?? 'USDT'}
                tone="target"
              />
              <label className="field">
                <span>
                  Notes <em>optional</em>
                </span>
                <input
                  value={values.notes}
                  onChange={(event) => set('notes', event.target.value)}
                  maxLength={500}
                  placeholder="Why this setup?"
                />
              </label>
            </div>
          </div>
          {error && (
            <div role="alert" className="alert error-alert">
              <strong>Trade not created</strong>
              <span>{error}</span>
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="button button-quiet" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? 'Checking rules…' : 'Create paper trade'} <span>→</span>
            </button>
          </div>
        </div>
        <aside className="risk-preview panel">
          <div className="preview-icon">⌁</div>
          <div className="eyebrow">BEFORE YOU SUBMIT</div>
          <h3>Risk preview</h3>
          <p>This estimate uses the distance from entry to your initial stop.</p>
          <div className="preview-divider" />
          <div className="preview-row">
            <span>Estimated risk</span>
            <strong>
              {estRisk === null ? '—' : formatAssetAmount(estRisk, selectedMarket?.quoteAsset ?? 'USDT')}
            </strong>
          </div>
          <div className="preview-row">
            <span>Exposure</span>
            <strong>
              {entry > 0 && quantity > 0
                ? formatAssetAmount(entry * quantity, selectedMarket?.quoteAsset ?? 'USDT')
                : '—'}
            </strong>
          </div>
          <div className="preview-note">
            <span>i</span>
            <p>
              Your configured risk limit is checked by the API before a trade is accepted. A changed form
              estimate does not override server-side limits.
            </p>
          </div>
          <div className="preview-warning">
            Paper mode only <span>↗</span>
          </div>
        </aside>
      </form>
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
  prefix,
  suffix,
  tone,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  tone?: string;
}) {
  return (
    <label className={`field ${tone ?? ''}`}>
      <span>{label}</span>
      <div className="input-wrap">
        {prefix && <i>{prefix}</i>}
        <input
          type="number"
          step="any"
          min="0.00000001"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
        />
        {suffix && <i>{suffix}</i>}
      </div>
    </label>
  );
}

function TradeDetail({
  trade,
  events,
  onBack,
  onUpdated,
}: {
  trade: Trade;
  events: TradeEvent[];
  onBack: () => void;
  onUpdated: () => Promise<void>;
}) {
  const [newPrice, setNewPrice] = useState(String(trade.currentPrice));
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isOpen = ['OPEN', 'TP1_HIT_TRAILING', 'TP2_HIT_TRAILING'].includes(trade.status);
  const unrealized =
    (trade.side === 'LONG' ? trade.currentPrice - trade.entryPrice : trade.entryPrice - trade.currentPrice) *
    trade.quantity;

  const updatePrice = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<Trade>(`/trades/${trade.id}/price`, {
        method: 'POST',
        body: JSON.stringify({ eventId: crypto.randomUUID(), price: Number(newPrice) }),
      });
      setNotice(
        result.meta?.duplicate
          ? 'Duplicate event ignored safely.'
          : `Simulated price recorded. Current status: ${result.data.status}.`,
      );
      await onUpdated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Price update failed.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!window.confirm('Cancel this paper trade? This action is recorded in the audit history.')) return;
    try {
      await api<Trade>(`/trades/${trade.id}/cancel`, { method: 'POST', body: '{}' });
      await onUpdated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Trade could not be cancelled.');
    }
  };

  return (
    <section className="page detail-page">
      <button className="back-button" onClick={onBack}>
        ← Back to overview
      </button>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            PAPER POSITION <span className="eyebrow-separator">/</span> {trade.id.slice(0, 8).toUpperCase()}
          </div>
          <h1>
            {trade.symbol} <span className="detail-side">{trade.side}</span>
          </h1>
          <p>Created {new Date(trade.createdAt).toLocaleString()} · Paper simulation only.</p>
        </div>
        <span className={`status-pill ${isOpen ? 'status-open' : 'status-closed'}`}>
          {trade.status.replaceAll('_', ' ')}
        </span>
      </div>
      <div className="detail-stats">
        <SummaryCard
          label="CURRENT PRICE"
          value={`${price(trade.currentPrice)} ${trade.quoteAsset}`}
          detail={`Entry ${price(trade.entryPrice)} ${trade.quoteAsset}`}
          iconText="↗"
          tone="blue"
        />
        <SummaryCard
          label={isOpen ? 'SIMULATED P&L' : 'REALIZED P&L'}
          value={formatAssetAmount(trade.realizedPnl ?? unrealized, trade.quoteAsset)}
          detail="Simplified estimate · fees excluded"
          iconText="↗"
          tone={(trade.realizedPnl ?? unrealized) >= 0 ? 'green' : 'red'}
        />
        <SummaryCard
          label="QUANTITY"
          value={trade.quantity.toString()}
          detail="Full position · no partial exits"
          iconText="◌"
          tone="amber"
        />
        <SummaryCard
          label="TRAILING STOP"
          value={trade.trailingStop === null ? 'Not active' : price(trade.trailingStop)}
          detail={
            trade.trailingActive
              ? `${trade.trailingPercent}% from best price`
              : `Initial ${price(trade.initialStop)}`
          }
          iconText="⌁"
          tone="blue"
        />
      </div>
      <div className="detail-grid">
        <section className="panel detail-parameters">
          <div className="panel-heading">
            <div>
              <h3>Position parameters</h3>
              <p>Targets are milestones; the full quantity closes at TP3 or stop.</p>
            </div>
          </div>
          <div className="parameter-grid">
            <Parameter label="Side" value={trade.side} />
            <Parameter label="Entry" value={`${price(trade.entryPrice)} ${trade.quoteAsset}`} />
            <Parameter label="Initial stop" value={`${price(trade.initialStop)} ${trade.quoteAsset}`} />
            <Parameter label="Take profit 1" value={`${price(trade.tp1)} ${trade.quoteAsset}`} />
            <Parameter label="Take profit 2" value={`${price(trade.tp2)} ${trade.quoteAsset}`} />
            <Parameter label="Take profit 3" value={`${price(trade.tp3)} ${trade.quoteAsset}`} />
            <Parameter label="Trailing distance" value={`${trade.trailingPercent}%`} />
            <Parameter label="Quantity" value={String(trade.quantity)} />
          </div>
        </section>
        <section className="panel update-panel">
          <div className="panel-heading">
            <div>
              <h3>Live paper execution</h3>
              <p>
                Binance prices update this paper position automatically; manual prices are available for
                testing.
              </p>
            </div>
            <span className="manual-badge">PAPER</span>
          </div>
          {isOpen ? (
            <form onSubmit={(event) => void updatePrice(event)}>
              <label className="field">
                <span>New simulated price</span>
                <div className="input-wrap">
                  <i>$</i>
                  <input
                    aria-label="New simulated price"
                    type="number"
                    min="0.00000001"
                    step="any"
                    required
                    value={newPrice}
                    onChange={(event) => setNewPrice(event.target.value)}
                  />
                </div>
              </label>
              <div className="event-id-info">A unique event ID is generated for every update.</div>
              <button className="button button-primary full-button" disabled={busy}>
                {busy ? 'Processing…' : 'Submit simulated price →'}
              </button>
            </form>
          ) : (
            <div className="closed-note">
              This paper position is closed. Its status and event history are immutable.
            </div>
          )}
          {notice && (
            <p role="status" className="success-message">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
          {isOpen && (
            <button className="cancel-trade" onClick={() => void cancel()}>
              Cancel paper trade
            </button>
          )}
        </section>
      </div>
      <section className="panel timeline-panel">
        <div className="panel-heading">
          <div>
            <h3>Event timeline</h3>
            <p>Recorded backend events for this position.</p>
          </div>
          <span className="event-mark">↻</span>
        </div>
        {events.length ? <EventList events={events} /> : <p className="quiet-empty">No recorded events.</p>}
      </section>
      <p className="disclosure">
        P&amp;L excludes fees, funding, slippage, liquidation and contract multipliers. This simulator is not
        financial advice.
      </p>
    </section>
  );
}

function RiskSettingsScreen({ risk, onSaved }: { risk: RiskData; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<RiskSettings>(risk.settings);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof RiskSettings>(key: K, value: RiskSettings[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api<RiskSettings>('/risk', {
        method: 'PUT',
        body: JSON.stringify({
          paperEquity: form.paperEquity,
          maxOpenPositions: form.maxOpenPositions,
          maxRiskPerTradePercent: form.maxRiskPerTradePercent,
          maxDailyLossPercent: form.maxDailyLossPercent,
          killSwitchEnabled: form.killSwitchEnabled,
        }),
      });
      setMessage('Risk settings saved. The backend enforces these limits on every new trade.');
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Risk settings could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const toggleKillSwitch = async () => {
    const enabled = !form.killSwitchEnabled;
    if (
      !window.confirm(
        enabled
          ? 'Enable the kill switch? New trades will be blocked and automated price processing paused. Trade history will remain unchanged.'
          : 'Disable the kill switch? New paper trades will be allowed again if other risk rules pass.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api('/risk/kill-switch', { method: 'POST', body: JSON.stringify({ enabled }) });
      setForm((current) => ({ ...current, killSwitchEnabled: enabled }));
      setMessage(`Kill switch ${enabled ? 'enabled' : 'disabled'}. Trade history is preserved.`);
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Kill switch update failed.');
    } finally {
      setBusy(false);
    }
  };

  const resetPortfolio = async () => {
    if (
      !window.confirm(
        'Permanently delete every open and closed paper trade, trade event, realized P&L, and daily risk statistic for this wallet? The paper balance will be restored to $10,000. Sign-in and risk limits will remain.',
      )
    )
      return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api('/portfolio/reset', { method: 'POST' });
      setForm((current) => ({ ...current, paperEquity: 10000 }));
      setMessage('This wallet’s paper trades and P&L were reset. Its paper balance is $10,000.');
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Paper portfolio could not be reset.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page form-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            SAFETY CONTROLS <span className="live-dot" />
          </div>
          <h1>Risk guardian.</h1>
          <p>Limits are checked by the backend, not just displayed in this browser.</p>
        </div>
        <span className="form-step">
          POLICY <i>/</i> PAPER
        </span>
      </div>
      <div className="risk-layout">
        <form className="panel risk-form" onSubmit={(event) => void save(event)}>
          <div className="panel-heading">
            <div>
              <h3>Paper account limits</h3>
              <p>Defaults are conservative and apply immediately when saved.</p>
            </div>
            <span className="rule-label">SERVER ENFORCED</span>
          </div>
          <div className="risk-fields">
            <NumberField
              label="Paper equity"
              value={String(form.paperEquity)}
              onChange={(value) => set('paperEquity', Number(value))}
              prefix="$"
            />
            <NumberField
              label="Maximum open positions"
              value={String(form.maxOpenPositions)}
              onChange={(value) => set('maxOpenPositions', Number(value))}
            />
            <NumberField
              label="Risk per trade"
              value={String(form.maxRiskPerTradePercent)}
              onChange={(value) => set('maxRiskPerTradePercent', Number(value))}
              suffix="%"
            />
            <NumberField
              label="Maximum daily loss"
              value={String(form.maxDailyLossPercent)}
              onChange={(value) => set('maxDailyLossPercent', Number(value))}
              suffix="%"
            />
          </div>
          <div className="daily-risk-box">
            <div>
              <span className="eyebrow">TODAY · UTC {risk.daily.dayUtc}</span>
              <strong>{money(risk.daily.realizedPnl)}</strong>
            </div>
            <div>
              <span>Daily loss limit</span>
              <strong>{money(risk.daily.lossLimit)}</strong>
            </div>
            <p>
              {risk.daily.blocked
                ? 'Daily loss limit reached. New positions are blocked until the next UTC day.'
                : 'New trades are allowed while all configured limits pass.'}
            </p>
          </div>
          {error && (
            <div className="alert error-alert" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div role="status" className="success-message">
              {message}
            </div>
          )}
          <div className="form-actions">
            <span className="quiet-text">Changes are stored locally.</span>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save risk settings →'}
            </button>
          </div>
        </form>
        <aside className={`panel kill-panel ${form.killSwitchEnabled ? 'kill-active' : ''}`}>
          <div className="kill-icon">⏻</div>
          <div className="eyebrow">EMERGENCY CONTROL</div>
          <h3>{form.killSwitchEnabled ? 'Kill switch engaged' : 'Kill switch'}</h3>
          <p>
            Blocks new positions and pauses automated simulated price processing. It will never delete trades
            or event history.
          </p>
          <button
            className={form.killSwitchEnabled ? 'button button-danger' : 'button button-outline'}
            disabled={busy}
            onClick={() => void toggleKillSwitch()}
          >
            {form.killSwitchEnabled ? 'Disable kill switch' : 'Enable kill switch'}
          </button>
          <div className="safe-guard">
            <span>◇</span> Open trade history remains preserved.
          </div>
          <div className="portfolio-reset">
            <h4>Reset this paper portfolio</h4>
            <p>Deletes this wallet’s trade history and P&L. Your sign-in and risk limits stay in place.</p>
            <button className="button button-danger" disabled={busy} onClick={() => void resetPortfolio()}>
              Reset trades and balance
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}

function NearIntentsScreen({ onStartPaperTrade }: { onStartPaperTrade: () => void }) {
  const [status, setStatus] = useState<NearStatus | null>(null);
  const [network, setNetwork] = useState<NearNetwork | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void Promise.all([
      api<NearStatus>('/near-intents/status'),
      api<{ network: NearNetwork }>('/auth/near/config'),
    ])
      .then(([provider, config]) => {
        setStatus(provider.data);
        setNetwork(config.data.network);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Unable to check NEAR integration status.');
      });
  }, []);
  const connected = status?.status === 'CONNECTED';
  const checking = !status && !error;
  return (
    <section className="page near-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            SEPARATE INTEGRATION <span className="eyebrow-separator">/</span> PROVIDER STATUS
          </div>
          <h1>NEAR Intents.</h1>
          <p>A separate token-swap integration, distinct from paper futures exit simulation.</p>
        </div>
        <span className="near-logo">NEAR</span>
      </div>
      <div className="near-grid">
        <section className="panel near-status-panel">
          <div className="near-orb">N</div>
          <span className={`status-pill ${connected ? 'status-connected' : 'status-not-configured'}`}>
            {checking ? 'CHECKING STATUS' : (status?.status ?? 'STATUS UNAVAILABLE')}
          </span>
          <h2>
            {connected
              ? 'Provider connected'
              : status?.status === 'NOT_CONFIGURED'
                ? 'Swaps are not available on testnet'
                : error
                  ? 'Unable to check provider'
                  : 'No provider configured'}
          </h2>
          <p>{error || status?.message || 'Checking integration configuration.'}</p>
          {network && (
            <div className="near-network">
              <span>WALLET AUTH NETWORK</span>
              <strong>NEAR {network.toUpperCase()}</strong>
            </div>
          )}
          <div className="near-divider" />
          <div className="near-facts">
            <div>
              <span>TOKEN LIST</span>
              <strong>Unavailable</strong>
            </div>
            <div>
              <span>LIVE QUOTES</span>
              <strong>Unavailable</strong>
            </div>
            <div>
              <span>SWAP SUBMISSION</span>
              <strong>Disabled</strong>
            </div>
          </div>
        </section>
        <aside className="panel near-separation">
          <div className="preview-icon">◇</div>
          <div className="eyebrow">WHY SWAPS ARE OFF</div>
          <h3>Testnet-safe by design.</h3>
          <p>
            NEAR Intents 1Click has no testnet. Enabling it here would require mainnet assets and real wallet
            transactions, which do not belong in this paper-trading demo.
          </p>
          <div className="separation-callout">
            <span>NOW</span>
            <p>
              Use your {network ? `NEAR ${network}` : 'NEAR'} wallet to sign in, then practice entries and
              exits with paper funds.
            </p>
          </div>
          <div className="near-actions">
            <button className="button button-primary near-paper-button" onClick={onStartPaperTrade}>
              Create a paper setup <span>→</span>
            </button>
            <a
              className="near-doc-link"
              href="https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction"
              target="_blank"
              rel="noreferrer"
            >
              Read the official NEAR Intents quickstart ↗
            </a>
          </div>
          <div className="near-roadmap">
            <span>FUTURE SCOPE</span>
            <p>
              A separate mainnet swap feature would need explicit approval, transaction review, and dedicated
              security testing.
            </p>
          </div>
          <div className="near-doc-link">No tokens, quotes, fees, or transactions are fabricated.</div>
        </aside>
      </div>
    </section>
  );
}

function EventList({ events }: { events: TradeEvent[] }) {
  return (
    <ul className="event-list">
      {events.map((event) => (
        <li key={event.id}>
          <span
            className={`event-dot ${event.eventType.includes('STOP') ? 'event-red' : event.eventType.includes('TP') ? 'event-green' : ''}`}
          />
          <div>
            <strong>{event.eventType.replaceAll('_', ' ')}</strong>
            <small>
              {event.eventPayload.price !== undefined
                ? `Price ${price(Number(event.eventPayload.price))} · `
                : ''}
              {new Date(event.createdAt).toLocaleString()}
            </small>
          </div>
          <span className="event-chevron">›</span>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  title,
  message,
  action,
  onAction,
}: {
  title: string;
  message: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">◫</div>
      <h3>{title}</h3>
      <p>{message}</p>
      <button className="button button-outline" onClick={onAction}>
        {action} →
      </button>
    </div>
  );
}

function Parameter({ label, value }: { label: string; value: string }) {
  return (
    <div className="parameter">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function pnl(trade: Trade): number {
  return (
    (trade.side === 'LONG' ? trade.currentPrice - trade.entryPrice : trade.entryPrice - trade.currentPrice) *
    trade.quantity
  );
}

function shortAccount(accountId: string): string {
  return accountId.length > 22 ? `${accountId.slice(0, 9)}…${accountId.slice(-9)}` : accountId;
}

function formatVolume(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

export default App;
