import cors from 'cors';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Database } from './database.js';
import { ZodError } from 'zod';
import { openDatabase } from './database.js';
import {
  createTradeSchema,
  futuresMarketQuerySchema,
  killSwitchSchema,
  marketScannerQuerySchema,
  marketPricesSchema,
  nearChallengeSchema,
  nearLoginSchema,
  paginationSchema,
  portfolioBalanceSchema,
  riskSettingsSchema,
  tradeIdParamsSchema,
  updatePriceSchema,
} from './schemas.js';
import { RepositoryError, RiskRepository, TradeRepository } from './repository.js';
import { createNearIntentsAdapter } from './near-intents-adapter.js';
import { BinanceMarketScannerService, type MarketScannerProvider } from './services/market-scanner.js';
import {
  BinanceFuturesMarketsService,
  BinanceMarketDataError,
  type FuturesMarketsProvider,
} from './services/binance-futures-markets.js';
import {
  configuredNearNetwork,
  nearRpcUrls,
  NearAuthError,
  NearAuthService,
  type NearNetwork,
} from './near-auth.js';

const DEV_APP_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];
const NEAR_AUTH_RATE_WINDOW_MS = 10 * 60_000;

export function configuredApiHost(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.HOST?.trim() || '127.0.0.1';
}

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
    sessionToken?: string;
    ethcryptohubBridgeAuthenticated?: boolean;
  }
}

function verifyEthcryptohubBridge(request: Request, secret: string): string | null {
  const userId = request.get('x-ethcryptohub-user') ?? '';
  const timestamp = request.get('x-ethcryptohub-timestamp') ?? '';
  const signature = request.get('x-ethcryptohub-signature') ?? '';
  if (
    secret.length < 32 ||
    !/^[1-9]\d{0,9}$/.test(userId) ||
    !/^\d{10}$/.test(timestamp) ||
    !/^[a-f0-9]{64}$/i.test(signature) ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60
  ) {
    return null;
  }

  const signedMessage = `${userId}\n${timestamp}\n${request.method.toUpperCase()}\n${request.originalUrl}`;
  const expected = createHmac('sha256', secret).update(signedMessage).digest();
  const supplied = Buffer.from(signature, 'hex');
  return timingSafeEqual(expected, supplied) ? userId : null;
}

async function ensureEthcryptohubPaperAccount(db: Database, ethcryptohubUserId: string): Promise<string> {
  const userId = `ethcryptohub-${ethcryptohubUserId}`;
  await ensurePaperAccount(db, userId, `php-user-${ethcryptohubUserId}`);
  return userId;
}

async function ensureAnonymousPaperAccount(db: Database, userId: string): Promise<void> {
  await ensurePaperAccount(db, userId, `${userId}.testnet`);
}

async function ensurePaperAccount(db: Database, userId: string, nearAccountId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO paper_users (id, near_account_id, starting_balance, created_at) VALUES ($1, $2, 10000, $3) ON CONFLICT DO NOTHING',
      [userId, nearAccountId, now],
    );
    await tx.query(
      `INSERT INTO risk_settings
         (user_id, paper_equity, max_open_positions, max_risk_per_trade_percent,
          max_daily_loss_percent, kill_switch_enabled, updated_at)
         VALUES ($1, 10000, 3, 1, 3, FALSE, $2) ON CONFLICT (user_id) DO NOTHING`,
      [userId, now],
    );
    await tx.query(
      `INSERT INTO paper_asset_balances (user_id, asset, starting_balance, realized_pnl)
       VALUES ($1, 'USDT', 10000, 0) ON CONFLICT DO NOTHING`,
      [userId],
    );
  });
}

export function configuredAppOrigins(environment: NodeJS.ProcessEnv = process.env): Set<string> {
  const isProduction = environment.NODE_ENV === 'production';
  const configuredOrigins = (environment.APP_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (isProduction && configuredOrigins.length === 0) {
    throw new Error('APP_ORIGIN must be set to the HTTPS app origin in production.');
  }

  const origins = new Set(isProduction ? [] : DEV_APP_ORIGINS);
  for (const configuredOrigin of configuredOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(configuredOrigin);
    } catch {
      throw new Error('APP_ORIGIN must contain valid app origin URLs.');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      (isProduction && parsed.protocol !== 'https:')
    ) {
      throw new Error('APP_ORIGIN must contain app origins only; production origins must use HTTPS.');
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function createNearAuthRateLimiter(limit: number) {
  const requestsByIp = new Map<string, { count: number; resetAt: number }>();
  let lastCleanup = 0;

  return (request: Request, response: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - lastCleanup >= NEAR_AUTH_RATE_WINDOW_MS || requestsByIp.size > 10_000) {
      for (const [ip, bucket] of requestsByIp) {
        if (bucket.resetAt <= now) requestsByIp.delete(ip);
      }
      lastCleanup = now;
    }

    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const bucket = requestsByIp.get(ip);
    if (bucket && bucket.resetAt > now && bucket.count >= limit) {
      response.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return response.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many NEAR sign-in attempts. Please try again later.' },
      });
    }
    if (!bucket || bucket.resetAt <= now) {
      if (!requestsByIp.has(ip) && requestsByIp.size >= 10_000) {
        const oldestIp = requestsByIp.keys().next().value;
        if (oldestIp) requestsByIp.delete(oldestIp);
      }
      requestsByIp.set(ip, { count: 1, resetAt: now + NEAR_AUTH_RATE_WINDOW_MS });
    } else {
      bucket.count += 1;
    }
    next();
  };
}

export function createApp(
  database?: Database,
  marketsService: FuturesMarketsProvider = new BinanceFuturesMarketsService(),
  options: {
    anonymousUserId?: string;
    bridgeSecret?: string;
    nearRpcRequest?: typeof fetch;
    nearNetwork?: NearNetwork;
    marketScannerService?: MarketScannerProvider;
  } = {},
) {
  const db = database ?? openDatabase();
  const nearNetwork = configuredNearNetwork(options.nearNetwork);
  const bridgeSecret = options.bridgeSecret ?? process.env.SMARTEXIT_BRIDGE_SECRET ?? '';
  const auth = new NearAuthService(db, options.nearRpcRequest, undefined, nearNetwork);
  const nearIntents = createNearIntentsAdapter();
  const marketScanner = options.marketScannerService ?? new BinanceMarketScannerService(marketsService);
  const allowedOrigins = configuredAppOrigins();
  const challengeRateLimit = createNearAuthRateLimiter(20);
  const loginRateLimit = createNearAuthRateLimiter(10);
  const app = express();

  app.disable('x-powered-by');
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', async (_request, response) => {
    try {
      await db.query('SELECT 1');
      response.json({
        data: { status: 'ok', mode: 'PAPER', database: 'connected', liveOrdersEnabled: false },
      });
    } catch {
      response
        .status(503)
        .json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The Supabase database is unavailable.' } });
    }
  });

  app.get('/api/auth/near/config', (_request, response) => {
    response.json({ data: { network: nearNetwork, rpcUrls: nearRpcUrls(nearNetwork) } });
  });

  app.post('/api/auth/near/challenge', challengeRateLimit, async (request, response, next) => {
    const parsed = nearChallengeSchema.safeParse(request.body);
    if (!parsed.success) return next(parsed.error);
    const origin = request.get('origin');
    if (!origin || !allowedOrigins.has(origin)) {
      return response.status(403).json({
        error: {
          code: 'ORIGIN_NOT_ALLOWED',
          message: 'Wallet sign-in is only available to a configured app origin.',
        },
      });
    }
    const recipient = new URL(origin).host;
    if (parsed.data.recipient !== recipient) {
      return response.status(400).json({
        error: { code: 'INVALID_RECIPIENT', message: 'Wallet sign-in recipient must match this app origin.' },
      });
    }
    response.json({ data: await auth.createChallenge(recipient) });
  });

  app.post('/api/auth/near/login', loginRateLimit, async (request, response, next) => {
    const origin = request.get('origin');
    if (!origin || !allowedOrigins.has(origin)) {
      return response.status(403).json({
        error: {
          code: 'ORIGIN_NOT_ALLOWED',
          message: 'Wallet sign-in is only available to a configured app origin.',
        },
      });
    }
    const parsed = nearLoginSchema.safeParse(request.body);
    if (!parsed.success) return next(parsed.error);
    try {
      const { user, sessionToken } = await auth.login(parsed.data);
      const maxAge = 30 * 24 * 60 * 60;
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      response.setHeader(
        'Set-Cookie',
        `smartexit_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${secure}`,
      );
      response.json({ data: { user } });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', async (request, response, next) => {
    const token = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('smartexit_session='))
      ?.slice('smartexit_session='.length);
    if (token) request.sessionToken = decodeURIComponent(token);
    const ethcryptohubUserId = verifyEthcryptohubBridge(request, bridgeSecret);
    if (ethcryptohubUserId !== null) {
      request.userId = await ensureEthcryptohubPaperAccount(db, ethcryptohubUserId);
      request.ethcryptohubBridgeAuthenticated = true;
      return next();
    }
    if (
      token &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !allowedOrigins.has(request.get('origin') ?? '')
    ) {
      return response.status(403).json({
        error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed.' },
      });
    }
    if (request.path === '/auth/me' || request.path === '/markets/futures-symbols') return next();
    if (options.anonymousUserId) {
      await ensureAnonymousPaperAccount(db, options.anonymousUserId);
      request.userId = options.anonymousUserId;
      return next();
    }
    const user = await auth.authenticate(request.sessionToken);
    if (!user) {
      return response.status(401).json({
        error: { code: 'AUTH_REQUIRED', message: 'Sign in to ETHcryptohub to access your paper portfolio.' },
      });
    }
    request.userId = user.id;
    next();
  });

  app.get('/api/auth/me', async (request, response) => {
    if (request.ethcryptohubBridgeAuthenticated && request.userId) {
      const { rows } = await db.query(
        'SELECT id, near_account_id, starting_balance, realized_pnl FROM paper_users WHERE id = $1',
        [request.userId],
      );
      const row = rows[0];
      if (!row) {
        return response.status(404).json({
          error: { code: 'PAPER_ACCOUNT_NOT_FOUND', message: 'Your paper account could not be loaded.' },
        });
      }
      return response.json({
        data: {
          id: String(row.id),
          nearAccountId: String(row.near_account_id),
          startingBalance: Number(row.starting_balance),
          realizedPnl: Number(row.realized_pnl),
        },
      });
    }
    const user = await auth.authenticate(request.sessionToken);
    response.json({ data: user });
  });

  app.post('/api/auth/logout', async (request, response) => {
    await auth.logout(request.sessionToken);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    response.setHeader(
      'Set-Cookie',
      `smartexit_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0${secure}`,
    );
    response.json({ data: { signedOut: true } });
  });

  app.get('/api/portfolio', async (request, response) => {
    response.json({ data: await portfolioWithTotals(request.userId!) });
  });

  app.post('/api/portfolio/reset', async (request, response, next) => {
    try {
      await auth.resetPaperPortfolio(request.userId!);
      response.json({ data: await portfolioWithTotals(request.userId!) });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/portfolio/balance', async (request, response, next) => {
    const parsed = portfolioBalanceSchema.safeParse(request.body);
    if (!parsed.success) return next(parsed.error);
    await auth.updateStartingBalance(request.userId!, parsed.data.startingBalance);
    response.json({ data: await portfolioWithTotals(request.userId!) });
  });

  const getTrades = (request: Request): TradeRepository => new TradeRepository(db, request.userId!);
  const getRisk = (request: Request): RiskRepository => new RiskRepository(db, request.userId!);
  const portfolioWithTotals = async (userId: string) => {
    const portfolio = await auth.portfolio(userId);
    return {
      ...portfolio,
      cashBalance: portfolio.startingBalance + portfolio.realizedPnl,
      totalEquity: portfolio.startingBalance + portfolio.realizedPnl + portfolio.unrealizedPnl,
    };
  };
  const getUsdtRate = async (quoteAsset: string): Promise<number | null> => {
    if (quoteAsset.toUpperCase() === 'USDT') return 1;
    const snapshot = await marketsService.list();
    const market = snapshot.symbols.find((item) => item.symbol === `${quoteAsset.toUpperCase()}USDT`);
    return market?.lastPrice && market.lastPrice > 0 ? market.lastPrice : null;
  };

  app.get('/api/trades', async (request, response, next) => {
    const parsed = paginationSchema.safeParse(request.query);
    if (!parsed.success) return next(parsed.error);
    response.json({ data: await getTrades(request).list(parsed.data.limit, parsed.data.offset) });
  });

  app.post('/api/trades', async (request, response, next) => {
    const parsed = createTradeSchema.safeParse(request.body);
    if (!parsed.success) return next(parsed.error);
    const input = parsed.data;
    if (
      input.side === 'LONG'
        ? !(
            input.initialStop < input.entryPrice &&
            input.entryPrice < input.tp1 &&
            input.tp1 < input.tp2 &&
            input.tp2 < input.tp3
          )
        : !(
            input.tp3 < input.tp2 &&
            input.tp2 < input.tp1 &&
            input.tp1 < input.entryPrice &&
            input.entryPrice < input.initialStop
          )
    ) {
      return response.status(400).json({
        error: {
          code: 'INVALID_LEVEL_ORDER',
          message: `Price levels are not in the valid ${input.side} order.`,
        },
      });
    }
    const trades = getTrades(request);
    const risk = getRisk(request);
    const settings = await risk.get();
    const daily = await risk.dailyRisk();
    const estimatedRisk = Math.abs(input.entryPrice - input.initialStop) * input.quantity;
    const riskBudgetUsdt = (settings.paperEquity * settings.maxRiskPerTradePercent) / 100;
    let usdtPerQuoteUnit: number | null;
    try {
      usdtPerQuoteUnit = await getUsdtRate(input.quoteAsset);
    } catch (error) {
      return next(error);
    }
    if (usdtPerQuoteUnit === null) {
      return response.status(422).json({
        error: {
          code: 'QUOTE_CONVERSION_UNAVAILABLE',
          message: `A live ${input.quoteAsset.toUpperCase()}/USDT rate is unavailable, so the USDT risk limit cannot be safely checked.`,
        },
      });
    }
    const riskBudget = riskBudgetUsdt / usdtPerQuoteUnit;
    if (settings.killSwitchEnabled) {
      return response.status(409).json({
        error: {
          code: 'KILL_SWITCH_ENABLED',
          message: 'The kill switch is enabled; new paper trades are blocked.',
        },
      });
    }
    if (daily.blocked) {
      return response.status(409).json({
        error: {
          code: 'DAILY_LOSS_LIMIT',
          message: 'The UTC daily loss limit was reached; new paper trades are blocked.',
        },
      });
    }
    if ((await risk.openPositionCount()) >= settings.maxOpenPositions) {
      return response.status(409).json({
        error: {
          code: 'MAX_OPEN_POSITIONS',
          message: 'The maximum number of open paper positions has been reached.',
        },
      });
    }
    if (estimatedRisk > riskBudget) {
      return response.status(400).json({
        error: {
          code: 'TRADE_RISK_TOO_HIGH',
          message: `Estimated risk ${estimatedRisk.toFixed(2)} exceeds the configured per-trade budget ${riskBudget.toFixed(2)}.`,
        },
        data: { estimatedRisk, riskBudget },
      });
    }
    response.status(201).json({
      data: await trades.insert(input),
      meta: {
        estimatedRisk,
        estimatedRiskUsdt: estimatedRisk * usdtPerQuoteUnit,
        riskBudget,
        quoteAsset: input.quoteAsset.toUpperCase(),
        mode: 'PAPER',
      },
    });
  });

  app.get('/api/trades/:id', async (request, response, next) => {
    const parsedId = tradeIdParamsSchema.safeParse(request.params);
    if (!parsedId.success) return next(parsedId.error);
    const trade = await getTrades(request).get(parsedId.data.id);
    if (!trade)
      return response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Trade not found.' } });
    response.json({ data: trade });
  });

  app.post('/api/trades/:id/price', async (request, response, next) => {
    const parsedId = tradeIdParamsSchema.safeParse(request.params);
    if (!parsedId.success) return next(parsedId.error);
    const parsed = updatePriceSchema.safeParse(request.body);
    if (!parsed.success) return next(parsed.error);
    const trades = getTrades(request);
    const trade = await trades.get(parsedId.data.id);
    if (!trade)
      return response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Trade not found.' } });
    let usdtPerQuoteUnit: number | null;
    try {
      usdtPerQuoteUnit = await getUsdtRate(trade.quoteAsset);
    } catch (error) {
      return next(error);
    }
    if (usdtPerQuoteUnit === null) {
      return response.status(503).json({
        error: {
          code: 'QUOTE_CONVERSION_UNAVAILABLE',
          message: 'A current quote-to-USDT rate is required to apply this price update safely.',
        },
      });
    }
    const result = await trades.updatePrice(
      parsedId.data.id,
      parsed.data.eventId,
      parsed.data.price,
      true,
      usdtPerQuoteUnit,
    );
    response.json({ data: result.trade, meta: { duplicate: result.duplicate, mode: 'PAPER' } });
  });

  app.post('/api/trades/:id/cancel', async (request, response, next) => {
    const parsedId = tradeIdParamsSchema.safeParse(request.params);
    if (!parsedId.success) return next(parsedId.error);
    const trades = getTrades(request);
    const trade = await trades.get(parsedId.data.id);
    if (!trade)
      return response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Trade not found.' } });
    let usdtPerQuoteUnit: number | null;
    try {
      usdtPerQuoteUnit = await getUsdtRate(trade.quoteAsset);
    } catch (error) {
      return next(error);
    }
    if (usdtPerQuoteUnit === null) {
      return response.status(503).json({
        error: {
          code: 'QUOTE_CONVERSION_UNAVAILABLE',
          message: 'A current quote-to-USDT rate is required to close this paper trade.',
        },
      });
    }
    response.json({ data: await trades.cancel(parsedId.data.id, usdtPerQuoteUnit) });
  });

  app.post('/api/trades/market-prices', async (request, response, next) => {
    const parsed = marketPricesSchema.safeParse(request.body);
    if (!parsed.success) return next(parsed.error);
    const trades = getTrades(request);
    if ((await getRisk(request).get()).killSwitchEnabled) {
      return response.status(409).json({
        error: {
          code: 'KILL_SWITCH_ENABLED',
          message: 'Automated paper price updates are paused by the kill switch.',
        },
      });
    }
    const openTrades = await trades.listOpen();
    const prices = new Map(parsed.data.prices.map((item) => [item.symbol.toUpperCase(), item.price]));
    const updated = [];
    for (const trade of openTrades) {
      const currentPrice = prices.get(trade.symbol);
      if (currentPrice === undefined) continue;
      const result = await trades.updatePrice(
        trade.id,
        `market:${randomUUID()}`,
        currentPrice,
        false,
        trade.quoteAsset === 'USDT' ? 1 : (prices.get(`${trade.quoteAsset}USDT`) ?? null),
      );
      updated.push(result.trade);
    }
    response.json({
      data: {
        trades: updated,
        portfolio: await portfolioWithTotals(request.userId!),
      },
    });
  });

  app.get('/api/risk', async (request, response) => {
    const risk = getRisk(request);
    response.json({
      data: {
        settings: await risk.get(),
        openPositions: await risk.openPositionCount(),
        daily: await risk.dailyRisk(),
      },
    });
  });

  app.put('/api/risk', async (request, response, next) => {
    const parsed = riskSettingsSchema.safeParse(request.body);
    if (!parsed.success) return next(parsed.error);
    response.json({ data: await getRisk(request).update(parsed.data) });
  });

  app.post('/api/risk/kill-switch', async (request, response, next) => {
    const parsed = killSwitchSchema.safeParse(request.body);
    if (!parsed.success) return next(parsed.error);
    const updated = await getRisk(request).setKillSwitch(parsed.data.enabled);
    response.json({ data: { settings: updated, historyPreserved: true } });
  });

  app.get('/api/events', async (request, response, next) => {
    const parsed = paginationSchema.safeParse(request.query);
    if (!parsed.success) return next(parsed.error);
    response.json({
      data: await getTrades(request).getEvents(parsed.data.limit, parsed.data.offset, parsed.data.tradeId),
    });
  });

  app.get('/api/markets/futures-symbols', async (_request, response, next) => {
    const parsedQuery = futuresMarketQuerySchema.safeParse(_request.query);
    if (!parsedQuery.success) return next(parsedQuery.error);
    try {
      const snapshot = await marketsService.list();
      const { quoteAsset, minimumVolume = 0, search = '' } = parsedQuery.data;
      const normalizedSearch = search.toUpperCase();
      const symbols = snapshot.symbols.filter(
        (item) =>
          (!quoteAsset || item.quoteAsset === quoteAsset.toUpperCase()) &&
          item.quoteVolume24h >= minimumVolume &&
          (!normalizedSearch || item.symbol.includes(normalizedSearch)),
      );
      response.json({
        data: { ...snapshot, symbols },
        meta: { total: snapshot.symbols.length, filtered: symbols.length },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/market-scanner/candidates', async (request, response, next) => {
    const parsed = marketScannerQuerySchema.safeParse(request.query);
    if (!parsed.success) return next(parsed.error);
    const config = { ...parsed.data, quoteAsset: parsed.data.quoteAsset.toUpperCase() };
    const risk = getRisk(request);
    const settings = await risk.get();
    let blockedReason = settings.killSwitchEnabled
      ? 'Risk Guardian kill switch is enabled; proposed setups are blocked.'
      : (await risk.openPositionCount()) >= settings.maxOpenPositions
        ? 'Risk Guardian maximum open-position limit has been reached.'
        : (await risk.dailyRisk()).blocked
          ? 'Risk Guardian daily loss limit is active; proposed setups are blocked.'
          : null;
    let riskBudget = (settings.paperEquity * settings.maxRiskPerTradePercent) / 100;
    if (config.quoteAsset !== 'USDT') {
      try {
        const usdtPerQuoteUnit = await getUsdtRate(config.quoteAsset);
        if (usdtPerQuoteUnit === null) {
          blockedReason ??= `Risk conversion for ${config.quoteAsset} to USDT is unavailable; setup sizing is blocked.`;
          riskBudget = 0;
        } else {
          riskBudget /= usdtPerQuoteUnit;
        }
      } catch (error) {
        return next(error);
      }
    }
    try {
      const result = await marketScanner.scan(config, {
        riskBudget,
        blockedReason,
      });
      response.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/near-intents/status', (_request, response) => {
    response.json({ data: nearIntents.status() });
  });

  app.get('/api/near-intents/tokens', (_request, response) => {
    response.json({ data: nearIntents.tokens() });
  });

  app.post('/api/near-intents/quote', (_request, response) => {
    response.status(503).json({
      error: {
        code: 'NOT_CONFIGURED',
        message: 'Verified NEAR Intents quote provider configuration is not available.',
      },
    });
  });

  app.post('/api/near-intents/swap', (_request, response) => {
    response.status(503).json({
      error: {
        code: 'SWAP_DISABLED',
        message: 'Swap submission is disabled. This application only simulates paper trades.',
      },
    });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    void _next;
    if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, 'body')) {
      response
        .status(400)
        .json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
      return;
    }
    if (error instanceof RepositoryError) {
      response.status(error.status).json({ error: { code: 'TRADE_ERROR', message: error.message } });
      return;
    }
    if (error instanceof NearAuthError) {
      response.status(error.status).json({ error: { code: 'NEAR_AUTH_ERROR', message: error.message } });
      return;
    }
    if (error instanceof BinanceMarketDataError) {
      response.status(502).json({
        error: { code: 'MARKET_DATA_UNAVAILABLE', message: error.message },
      });
      return;
    }
    console.error('Unhandled API error:', error instanceof Error ? error.message : 'Unknown error');
    response
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } });
  });

  return { app, db };
}
