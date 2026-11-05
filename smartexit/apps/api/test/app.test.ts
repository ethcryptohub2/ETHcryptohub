import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredApiHost, configuredAppOrigins, createApp } from '../src/app.js';
import { supabasePoolConfig } from '../src/database.js';
import { NearAuthService, nearSignedMessagePayload } from '../src/near-auth.js';
import { openTestDatabase } from './test-database.js';
import {
  BinanceFuturesMarketsService,
  BinanceMarketDataError,
  type FuturesMarketSnapshot,
} from '../src/services/binance-futures-markets.js';

const databases: ReturnType<typeof openTestDatabase>[] = [];
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function toBase58(bytes: Buffer): string {
  let number = BigInt(`0x${bytes.toString('hex')}`);
  let result = '';
  while (number > 0n) {
    result = base58Alphabet[Number(number % 58n)] + result;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result || '1';
}

function setup() {
  const db = openTestDatabase();
  databases.push(db);
  return { db, app: createApp(db, undefined, { anonymousUserId: 'test-user' }).app };
}

function ethcryptohubBridgeHeaders(
  secret: string,
  userId: string,
  method: string,
  path: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret)
    .update(`${userId}\n${timestamp}\n${method}\n${path}`)
    .digest('hex');
  return {
    'X-Ethcryptohub-User': userId,
    'X-Ethcryptohub-Timestamp': timestamp,
    'X-Ethcryptohub-Signature': signature,
  };
}

function longTrade(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 10000,
    quantity: 0.01,
    initialStop: 9900,
    tp1: 10100,
    tp2: 10200,
    tp3: 10300,
    trailingPercent: 1,
    ...overrides,
  };
}

function shortTrade(overrides: Record<string, unknown> = {}) {
  return longTrade({
    side: 'SHORT',
    initialStop: 10100,
    tp1: 9900,
    tp2: 9800,
    tp3: 9700,
    ...overrides,
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) void db.close();
});

describe('SmartExit paper trading API', () => {
  it('uses a configurable listener host with secure Supabase TLS settings', () => {
    expect(configuredApiHost({})).toBe('127.0.0.1');
    expect(configuredApiHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(
      supabasePoolConfig({
        SUPABASE_DB_HOST: 'db.example.supabase.co',
        SUPABASE_DB_PORT: '5432',
        SUPABASE_DB_NAME: 'postgres',
        SUPABASE_DB_USER: 'postgres',
        SUPABASE_DB_PASSWORD: 'test-password',
        SUPABASE_DB_SSLMODE: 'verify-full',
      }),
    ).toMatchObject({
      host: 'db.example.supabase.co',
      port: 5432,
      database: 'postgres',
      ssl: { rejectUnauthorized: true, servername: 'db.example.supabase.co' },
    });
    expect(() =>
      supabasePoolConfig({
        SUPABASE_DB_HOST: 'db.example.supabase.co',
        SUPABASE_DB_PORT: '5432',
        SUPABASE_DB_NAME: 'postgres',
        SUPABASE_DB_USER: 'postgres',
        SUPABASE_DB_PASSWORD: 'test-password',
        SUPABASE_DB_SSLMODE: 'disable',
      }),
    ).toThrow('SUPABASE_DB_SSLMODE must require TLS');
  });

  it('uses the NEP-413 prefix tag and payload encoding', () => {
    expect(
      nearSignedMessagePayload(
        'hi',
        Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
        'myapp.com',
      ).toString('hex'),
    ).toBe('0e80e1606a46e66fcb450f6ceb55803921e465fddee8216463cf7b2680c09f37');
  });

  it('authenticates NEAR accounts with a one-time signed message and initializes a private paper balance', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const rpcUrls: string[] = [];
    const rpc: typeof fetch = async (input) => {
      rpcUrls.push(String(input));
      return new Response(JSON.stringify({ result: { nonce: 0, permission: 'FullAccess' } }));
    };
    const auth = new NearAuthService(db, rpc, undefined, 'testnet');
    const challenge = await auth.createChallenge('127.0.0.1:5173');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const signature = sign(
      null,
      nearSignedMessagePayload(
        challenge.message,
        Buffer.from(challenge.nonce, 'base64'),
        challenge.recipient,
      ),
      privateKey,
    );
    const proof = {
      challengeId: challenge.id,
      accountId: 'sample.testnet',
      publicKey: `ed25519:${toBase58(publicKeyBytes)}`,
      signature: signature.toString('base64'),
      initialBalance: 2500,
    };
    const login = await auth.login(proof);
    expect(login.user).toMatchObject({
      nearAccountId: 'sample.testnet',
      startingBalance: 2500,
      realizedPnl: 0,
    });
    expect((await auth.authenticate(login.sessionToken))?.id).toBe(login.user.id);
    expect(await auth.portfolio(login.user.id)).toMatchObject({
      startingBalance: 2500,
      realizedPnl: 0,
      unrealizedPnl: 0,
    });
    expect(rpcUrls).toEqual(['https://near-testnet.drpc.org']);
    await expect(auth.login(proof)).rejects.toThrow('Sign-in challenge expired');
  });

  it('exposes the configured NEAR network to the wallet client', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const app = createApp(db, undefined, { nearNetwork: 'testnet' }).app;
    await request(app)
      .get('/api/auth/near/config')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual({
          network: 'testnet',
          rpcUrls: ['https://near-testnet.drpc.org', 'https://test.rpc.fastnear.com'],
        });
      });
  });

  it('requires an explicit HTTPS app origin for production NEAR sign-in', () => {
    expect(configuredAppOrigins({ NODE_ENV: 'production', APP_ORIGIN: 'https://smartexit.example' })).toEqual(
      new Set(['https://smartexit.example']),
    );
    expect(() => configuredAppOrigins({ NODE_ENV: 'production' })).toThrow(
      'APP_ORIGIN must be set to the HTTPS app origin in production.',
    );
    expect(() =>
      configuredAppOrigins({ NODE_ENV: 'production', APP_ORIGIN: 'http://smartexit.example' }),
    ).toThrow('APP_ORIGIN must contain app origins only; production origins must use HTTPS.');
  });

  it('only issues NEAR login challenges for allowed app origins and matching recipients', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const app = createApp(db).app;
    await request(app)
      .post('/api/auth/near/challenge')
      .set('Origin', 'https://attacker.example')
      .send({ recipient: 'attacker.example' })
      .expect(403);
    await request(app)
      .post('/api/auth/near/challenge')
      .set('Origin', 'http://localhost:5173')
      .send({ recipient: 'attacker.example' })
      .expect(400);
    await request(app)
      .post('/api/auth/near/challenge')
      .set('Origin', 'http://localhost:5173')
      .send({ recipient: 'localhost:5173' })
      .expect(200);
    await request(app)
      .post('/api/auth/near/login')
      .set('Origin', 'https://attacker.example')
      .send({})
      .expect(403);
  });

  it('rate limits repeated NEAR challenge requests by client IP', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const app = createApp(db).app;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await request(app)
        .post('/api/auth/near/challenge')
        .set('Origin', 'http://localhost:5173')
        .send({ recipient: 'localhost:5173' })
        .expect(200);
    }
    const limited = await request(app)
      .post('/api/auth/near/challenge')
      .set('Origin', 'http://localhost:5173')
      .send({ recipient: 'localhost:5173' })
      .expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rate limits NEAR login proof verification by client IP', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const app = createApp(db).app;
    const proof = {
      challengeId: randomUUID(),
      accountId: 'rate-limit.testnet',
      publicKey: 'ed25519:11111111111111111111111111111111',
      signature: 'A'.repeat(88),
      initialBalance: 10000,
    };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app)
        .post('/api/auth/near/login')
        .set('Origin', 'http://localhost:5173')
        .send(proof)
        .expect(401);
    }
    const limited = await request(app)
      .post('/api/auth/near/login')
      .set('Origin', 'http://localhost:5173')
      .send(proof)
      .expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rejects cross-origin NEAR session mutations without revoking the session', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const token = 'valid-session-token';
    const userId = randomUUID();
    db.prepare(
      'INSERT INTO paper_users (id, near_account_id, starting_balance, created_at) VALUES (?, ?, ?, ?)',
    ).run(userId, 'csrf.testnet', 10000, new Date().toISOString());
    db.prepare('INSERT INTO paper_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      createHash('sha256').update(token).digest('hex'),
      userId,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const app = createApp(db).app;
    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `smartexit_session=${token}`)
      .set('Origin', 'https://attacker.example')
      .expect(403);
    expect(
      Number((db.prepare('SELECT COUNT(*) AS count FROM paper_sessions').get() as { count: number }).count),
    ).toBe(1);
  });

  it('expires and removes stale NEAR sessions when issuing a challenge', async () => {
    const db = openTestDatabase();
    databases.push(db);
    let now = new Date('2026-01-01T00:00:00.000Z');
    const auth = new NearAuthService(db, undefined, () => now, 'testnet');
    const token = 'expired-session-token';
    const userId = randomUUID();
    db.prepare(
      'INSERT INTO paper_users (id, near_account_id, starting_balance, created_at) VALUES (?, ?, ?, ?)',
    ).run(userId, 'expired.testnet', 10000, now.toISOString());
    db.prepare('INSERT INTO paper_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      createHash('sha256').update(token).digest('hex'),
      userId,
      new Date(now.getTime() + 60_000).toISOString(),
    );
    now = new Date(now.getTime() + 61_000);
    expect(await auth.authenticate(token)).toBeNull();
    await auth.createChallenge('127.0.0.1:5173');
    expect(
      Number((db.prepare('SELECT COUNT(*) AS count FROM paper_sessions').get() as { count: number }).count),
    ).toBe(0);
  });

  it('rejects wallet keys missing from the testnet access-key response', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const rpc: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          result: { error: 'access key does not exist while viewing' },
        }),
      );
    const auth = new NearAuthService(db, rpc, undefined, 'testnet');
    const challenge = await auth.createChallenge('127.0.0.1:5173');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const signature = sign(
      null,
      nearSignedMessagePayload(
        challenge.message,
        Buffer.from(challenge.nonce, 'base64'),
        challenge.recipient,
      ),
      privateKey,
    );

    await expect(
      auth.login({
        challengeId: challenge.id,
        accountId: 'missing-key.testnet',
        publicKey: `ed25519:${toBase58(publicKeyBytes)}`,
        signature: signature.toString('base64'),
        initialBalance: 2500,
      }),
    ).rejects.toThrow('The signed key is not registered to this NEAR account.');
  });

  it('requires an authenticated paper account for portfolio and trade data', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const app = createApp(db).app;
    await request(app)
      .get('/api/auth/me')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toBeNull();
      });
    await request(app).get('/api/trades').expect(401);
    await request(app).get('/api/portfolio').expect(401);
    await request(app).post('/api/portfolio/reset').expect(401);
    await request(app).get('/api/market-scanner/candidates').expect(401);
  });

  it('authenticates PHP users through signed requests and isolates their paper portfolios', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const secret = 'a'.repeat(64);
    const app = createApp(db, undefined, { bridgeSecret: secret }).app;

    await request(app)
      .get('/api/auth/me')
      .set(ethcryptohubBridgeHeaders(secret, '17', 'GET', '/api/auth/me'))
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({
          id: 'ethcryptohub-17',
          nearAccountId: 'php-user-17',
          startingBalance: 10000,
        });
      });

    const created = await request(app)
      .post('/api/trades')
      .set(ethcryptohubBridgeHeaders(secret, '17', 'POST', '/api/trades'))
      .send(longTrade())
      .expect(201);
    expect(created.body.data.symbol).toBe('BTCUSDT');

    await request(app)
      .get('/api/trades?limit=200')
      .set(ethcryptohubBridgeHeaders(secret, '18', 'GET', '/api/trades?limit=200'))
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toHaveLength(0);
      });

    await request(app)
      .get('/api/trades?limit=200')
      .set(ethcryptohubBridgeHeaders(secret, '17', 'GET', '/api/trades?limit=200'))
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toHaveLength(1);
      });

    await request(app)
      .get('/api/trades')
      .set({
        ...ethcryptohubBridgeHeaders(secret, '17', 'GET', '/api/trades'),
        'X-Ethcryptohub-User': '18',
      })
      .expect(401);
  });

  it('resets only the authenticated paper portfolio and restores its default balance atomically', async () => {
    const { db, app } = setup();
    const otherAccount = createApp(db, undefined, { anonymousUserId: 'other-user' }).app;
    await request(app).put('/api/portfolio/balance').send({ startingBalance: 25000 }).expect(200);
    await request(app)
      .put('/api/risk')
      .send({
        paperEquity: 25000,
        maxOpenPositions: 6,
        maxRiskPerTradePercent: 1,
        maxDailyLossPercent: 3,
        killSwitchEnabled: false,
      })
      .expect(200);
    const closed = await request(app).post('/api/trades').send(longTrade()).expect(201);
    await request(app)
      .post(`/api/trades/${closed.body.data.id}/price`)
      .send({ eventId: randomUUID(), price: 10050 })
      .expect(200);
    await request(app).post(`/api/trades/${closed.body.data.id}/cancel`).send().expect(200);
    await request(app)
      .post('/api/trades')
      .send(longTrade({ symbol: 'ETHUSDT' }))
      .expect(201);
    await request(otherAccount).post('/api/trades').send(longTrade()).expect(201);
    await request(app).get('/api/risk').expect(200);

    await request(app)
      .post('/api/portfolio/reset')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({
          startingBalance: 10000,
          realizedPnl: 0,
          unrealizedPnl: 0,
          cashBalance: 10000,
          totalEquity: 10000,
        });
      });

    expect((await request(app).get('/api/trades')).body.data).toHaveLength(0);
    expect((await request(app).get('/api/events')).body.data).toHaveLength(0);
    expect((await request(app).get('/api/risk')).body.data).toMatchObject({
      settings: { paperEquity: 10000, maxOpenPositions: 6 },
      openPositions: 0,
      daily: { realizedPnl: 0, blocked: false },
    });
    expect((await request(otherAccount).get('/api/trades')).body.data).toHaveLength(1);
    expect((await request(otherAccount).get('/api/portfolio')).body.data.startingBalance).toBe(10000);
  });

  it('scopes market-scanner proposals to the authenticated Risk Guardian limits', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const scanner = {
      scan: vi.fn(async () => ({
        exchange: 'BINANCE' as const,
        market: 'USDⓈ-M FUTURES' as const,
        source: 'test fixture',
        updatedAt: new Date().toISOString(),
        timeframe: '15m' as const,
        configuration: {
          quoteAsset: 'USDT',
          timeframe: '15m' as const,
          minimumVolume: 10_000_000,
          limit: 15,
          atrPeriod: 10,
          multiplier: 3,
          maxAgeSeconds: 180,
          minimumScore: 60,
        },
        status: 'LIVE' as const,
        candidates: [],
      })),
    };
    const app = createApp(db, undefined, {
      anonymousUserId: 'scanner-user',
      marketScannerService: scanner,
    }).app;

    await request(app).get('/api/market-scanner/candidates').expect(200);
    expect(scanner.scan).toHaveBeenCalledWith(
      expect.objectContaining({ quoteAsset: 'USDT', timeframe: '15m' }),
      expect.objectContaining({ riskBudget: 100, blockedReason: null }),
    );

    await request(app)
      .put('/api/risk')
      .send({
        paperEquity: 10000,
        maxOpenPositions: 3,
        maxRiskPerTradePercent: 1,
        maxDailyLossPercent: 3,
        killSwitchEnabled: true,
      })
      .expect(200);
    await request(app).get('/api/market-scanner/candidates').expect(200);
    expect(scanner.scan).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({ blockedReason: expect.stringContaining('kill switch') }),
    );
    await request(app).get('/api/market-scanner/candidates?timeframe=1m').expect(400);
  });

  it('isolates each paper account and updates its portfolio when automated paper exits trigger', async () => {
    const { db, app } = setup();
    const otherAccount = createApp(db, undefined, { anonymousUserId: 'other-user' }).app;
    const created = await request(app).post('/api/trades').send(longTrade()).expect(201);
    expect((await request(otherAccount).get('/api/trades')).body.data).toHaveLength(0);

    const firstTarget = await request(app)
      .post('/api/trades/market-prices')
      .send({ prices: [{ symbol: 'BTCUSDT', price: 10100 }] })
      .expect(200);
    expect(firstTarget.body.data.trades[0].status).toBe('TP1_HIT_TRAILING');
    expect(firstTarget.body.data.portfolio.unrealizedPnl).toBeCloseTo(1);
    expect(firstTarget.body.data.portfolio.cashBalance).toBe(10000);

    const targetThree = await request(app)
      .post('/api/trades/market-prices')
      .send({ prices: [{ symbol: 'BTCUSDT', price: 10300 }] })
      .expect(200);
    expect(targetThree.body.data.trades[0].status).toBe('COMPLETED_TP3');
    expect(targetThree.body.data.portfolio.realizedPnl).toBeCloseTo(3);
    expect(targetThree.body.data.portfolio.cashBalance).toBeCloseTo(10003);
    expect((await request(otherAccount).get('/api/portfolio')).body.data.cashBalance).toBe(10000);

    const ownTrade = await request(app).get(`/api/trades/${created.body.data.id}`).expect(200);
    await request(otherAccount).get(`/api/trades/${ownTrade.body.data.id}`).expect(404);
  });

  it('keeps non-USDT quote balances separate while valuing realized P&L in the paper account currency', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const snapshot: FuturesMarketSnapshot = {
      exchange: 'BINANCE',
      market: 'USDⓈ-M FUTURES',
      source: 'test fixture',
      updatedAt: new Date().toISOString(),
      symbols: [
        {
          symbol: 'BTCUSDT',
          contractType: 'PERPETUAL',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          lastPrice: 10000,
          priceChangePercent24h: 0,
          quoteVolume24h: 1_000_000,
          tradeCount24h: 1,
        },
      ],
    };
    const app = createApp(db, { list: async () => snapshot }, { anonymousUserId: 'test-user' }).app;
    const created = await request(app)
      .post('/api/trades')
      .send(longTrade({ symbol: 'ETHBTC', quoteAsset: 'BTC', initialStop: 9999 }))
      .expect(201);
    const closed = await request(app)
      .post('/api/trades/market-prices')
      .send({
        prices: [
          { symbol: 'ETHBTC', price: 10300 },
          { symbol: 'BTCUSDT', price: 10000 },
        ],
      })
      .expect(200);
    expect(closed.body.data.trades[0]).toMatchObject({
      id: created.body.data.id,
      quoteAsset: 'BTC',
      status: 'COMPLETED_TP3',
      realizedPnl: 3,
    });
    expect(closed.body.data.portfolio.cashBalance).toBe(40000);
    expect(closed.body.data.portfolio.assetBalances).toContainEqual(
      expect.objectContaining({ asset: 'BTC', realizedPnl: 3, cashBalance: 3 }),
    );
  });

  it('reports paper mode and a connected database', async () => {
    const { app } = setup();
    const response = await request(app).get('/api/health').expect(200);
    expect(response.body.data).toMatchObject({
      status: 'ok',
      mode: 'PAPER',
      database: 'connected',
      liveOrdersEnabled: false,
    });
  });

  it('creates valid LONG and SHORT trades and rejects incorrectly ordered levels', async () => {
    const { app } = setup();
    const long = await request(app).post('/api/trades').send(longTrade()).expect(201);
    const short = await request(app).post('/api/trades').send(shortTrade()).expect(201);
    expect(long.body.data.side).toBe('LONG');
    expect(short.body.data.side).toBe('SHORT');

    await request(app)
      .post('/api/trades')
      .send(longTrade({ tp2: 10050 }))
      .expect(400);
    expect((await request(app).get('/api/trades')).body.data).toHaveLength(2);
  });

  it('rejects invalid numbers and enforces the per-trade risk budget server-side', async () => {
    const { app } = setup();
    await request(app)
      .post('/api/trades')
      .send(longTrade({ quantity: Infinity }))
      .expect(400);
    await request(app)
      .post('/api/trades')
      .send(longTrade({ trailingPercent: 26 }))
      .expect(400);
    const response = await request(app)
      .post('/api/trades')
      .send(longTrade({ quantity: 1, initialStop: 9000 }))
      .expect(400);
    expect(response.body.error.code).toBe('TRADE_RISK_TOO_HIGH');
  });

  it('activates LONG trailing at TP1, retains full quantity at TP2 and closes all at TP3', async () => {
    const { app } = setup();
    const created = await request(app).post('/api/trades').send(longTrade()).expect(201);
    const id = created.body.data.id as string;
    const first = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 10100 })
      .expect(200);
    expect(first.body.data.status).toBe('TP1_HIT_TRAILING');
    expect(first.body.data.trailingActive).toBe(true);
    expect(first.body.data.quantity).toBe(0.01);
    const second = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 10200 })
      .expect(200);
    expect(second.body.data.status).toBe('TP2_HIT_TRAILING');
    expect(second.body.data.quantity).toBe(0.01);
    const third = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 10300 })
      .expect(200);
    expect(third.body.data.status).toBe('COMPLETED_TP3');
    expect(third.body.data.quantity).toBe(0.01);
    expect(third.body.data.realizedPnl).toBeCloseTo(3);
    await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 10400 })
      .expect(409);
  });

  it('applies SHORT milestones and closes at TP3', async () => {
    const { app } = setup();
    const created = await request(app).post('/api/trades').send(shortTrade()).expect(201);
    const id = created.body.data.id as string;
    await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 9900 })
      .expect(200);
    const second = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 9800 })
      .expect(200);
    expect(second.body.data.status).toBe('TP2_HIT_TRAILING');
    expect(second.body.data.quantity).toBe(0.01);
    const third = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 9700 })
      .expect(200);
    expect(third.body.data.status).toBe('COMPLETED_TP3');
    expect(third.body.data.realizedPnl).toBeCloseTo(3);
  });

  it('closes the full position at the initial stop before TP1', async () => {
    const { app } = setup();
    const created = await request(app).post('/api/trades').send(longTrade()).expect(201);
    const stopped = await request(app)
      .post(`/api/trades/${created.body.data.id}/price`)
      .send({ eventId: randomUUID(), price: 9890 })
      .expect(200);
    expect(stopped.body.data.status).toBe('STOPPED_INITIAL_SL');
    expect(stopped.body.data.exitPrice).toBe(9890);
    expect(stopped.body.data.realizedPnl).toBeCloseTo(-1.1);
  });

  it('moves a LONG trailing stop only upward and closes on a trailing stop hit', async () => {
    const { app } = setup();
    const created = await request(app).post('/api/trades').send(longTrade()).expect(201);
    const id = created.body.data.id as string;
    const first = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 10100 });
    const initialTrail = first.body.data.trailingStop as number;
    const high = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 10200 });
    const raisedTrail = high.body.data.trailingStop as number;
    expect(raisedTrail).toBeGreaterThan(initialTrail);
    const retrace = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 10150 });
    expect(retrace.body.data.trailingStop).toBe(raisedTrail);
    const stopped = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: raisedTrail })
      .expect(200);
    expect(stopped.body.data.status).toBe('STOPPED_TRAILING_SL');
  });

  it('moves a SHORT trailing stop only downward while the full quantity remains open', async () => {
    const { app } = setup();
    const created = await request(app).post('/api/trades').send(shortTrade()).expect(201);
    const id = created.body.data.id as string;
    const first = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 9900 });
    const initialTrail = first.body.data.trailingStop as number;
    const low = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 9800 });
    const loweredTrail = low.body.data.trailingStop as number;
    expect(loweredTrail).toBeLessThan(initialTrail);
    const retrace = await request(app)
      .post(`/api/trades/${id}/price`)
      .send({ eventId: randomUUID(), price: 9850 });
    expect(retrace.body.data.trailingStop).toBe(loweredTrail);
    expect(retrace.body.data.quantity).toBe(0.01);
  });

  it('treats a repeated event ID idempotently and does not add another event', async () => {
    const { app } = setup();
    const created = await request(app).post('/api/trades').send(longTrade()).expect(201);
    const id = created.body.data.id as string;
    const eventId = randomUUID();
    const first = await request(app).post(`/api/trades/${id}/price`).send({ eventId, price: 10100 });
    const countBefore = (await request(app).get(`/api/events?tradeId=${id}`)).body.data.length as number;
    const duplicate = await request(app).post(`/api/trades/${id}/price`).send({ eventId, price: 10000 });
    const countAfter = (await request(app).get(`/api/events?tradeId=${id}`)).body.data.length as number;
    expect(first.body.data.status).toBe('TP1_HIT_TRAILING');
    expect(duplicate.body.meta.duplicate).toBe(true);
    expect(duplicate.body.data.status).toBe('TP1_HIT_TRAILING');
    expect(countAfter).toBe(countBefore);
  });

  it('preserves open positions and risk settings across API instances', async () => {
    const db = openTestDatabase();
    databases.push(db);
    const firstApp = createApp(db, undefined, { anonymousUserId: 'test-user' }).app;
    const created = await request(firstApp).post('/api/trades').send(longTrade()).expect(201);
    const tradeId = created.body.data.id as string;
    await request(firstApp)
      .put('/api/risk')
      .send({
        paperEquity: 20000,
        maxOpenPositions: 4,
        maxRiskPerTradePercent: 2,
        maxDailyLossPercent: 5,
        killSwitchEnabled: false,
      })
      .expect(200);
    const secondApp = createApp(db, undefined, { anonymousUserId: 'test-user' }).app;
    const loaded = await request(secondApp).get(`/api/trades/${tradeId}`).expect(200);
    expect(loaded.body.data.status).toBe('OPEN');
    expect(loaded.body.data.currentPrice).toBe(10000);
    const loadedRisk = await request(secondApp).get('/api/risk').expect(200);
    expect(loadedRisk.body.data.settings).toMatchObject({
      paperEquity: 20000,
      maxOpenPositions: 4,
      maxRiskPerTradePercent: 2,
    });
  });

  it('blocks new trades when the kill switch is enabled without deleting history', async () => {
    const { app } = setup();
    const existing = await request(app).post('/api/trades').send(longTrade()).expect(201);
    await request(app).post('/api/risk/kill-switch').send({ enabled: true }).expect(200);
    const blocked = await request(app).post('/api/trades').send(longTrade()).expect(409);
    expect(blocked.body.error.code).toBe('KILL_SWITCH_ENABLED');
    expect((await request(app).get(`/api/trades/${existing.body.data.id}`)).body.data.id).toBe(
      existing.body.data.id,
    );
    expect((await request(app).get(`/api/events?tradeId=${existing.body.data.id}`)).body.data.length).toBe(1);
  });

  it('cancels an open position at its current simulated price and records the full close', async () => {
    const { app } = setup();
    const created = await request(app).post('/api/trades').send(longTrade()).expect(201);
    const cancelled = await request(app)
      .post(`/api/trades/${created.body.data.id}/cancel`)
      .send({})
      .expect(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(cancelled.body.data.exitPrice).toBe(10000);
    expect(cancelled.body.data.realizedPnl).toBe(0);
    const events = await request(app).get(`/api/events?tradeId=${created.body.data.id}`).expect(200);
    expect(events.body.data.map((event: { eventType: string }) => event.eventType)).toContain(
      'TRADE_CANCELLED',
    );
  });

  it('enforces the configured maximum number of open positions', async () => {
    const { app } = setup();
    await request(app)
      .put('/api/risk')
      .send({
        paperEquity: 10000,
        maxOpenPositions: 1,
        maxRiskPerTradePercent: 1,
        maxDailyLossPercent: 3,
        killSwitchEnabled: false,
      })
      .expect(200);
    await request(app).post('/api/trades').send(longTrade()).expect(201);
    const blocked = await request(app)
      .post('/api/trades')
      .send(longTrade({ symbol: 'ETHUSDT' }))
      .expect(409);
    expect(blocked.body.error.code).toBe('MAX_OPEN_POSITIONS');
  });

  it('blocks new positions after the UTC daily loss limit is reached', async () => {
    const { app } = setup();
    await request(app)
      .put('/api/risk')
      .send({
        paperEquity: 10000,
        maxOpenPositions: 3,
        maxRiskPerTradePercent: 100,
        maxDailyLossPercent: 0.001,
        killSwitchEnabled: false,
      })
      .expect(200);
    const created = await request(app).post('/api/trades').send(longTrade()).expect(201);
    await request(app)
      .post(`/api/trades/${created.body.data.id}/price`)
      .send({ eventId: randomUUID(), price: 9800 })
      .expect(200);
    const blocked = await request(app).post('/api/trades').send(longTrade()).expect(409);
    expect(blocked.body.error.code).toBe('DAILY_LOSS_LIMIT');
  });

  it('returns an honest NEAR Intents not-configured state and no token fixtures', async () => {
    const { app } = setup();
    const status = await request(app).get('/api/near-intents/status').expect(200);
    const tokens = await request(app).get('/api/near-intents/tokens').expect(200);
    expect(status.body.data.status).toBe('NOT_CONFIGURED');
    expect(status.body.data.swapsEnabled).toBe(false);
    expect(tokens.body.data).toEqual({ status: 'NOT_CONFIGURED', tokens: [] });
    await request(app).post('/api/near-intents/swap').send({}).expect(503);
  });

  it('serves Binance futures symbols from the isolated market-data adapter', async () => {
    const snapshot: FuturesMarketSnapshot = {
      exchange: 'BINANCE',
      market: 'USDⓈ-M FUTURES',
      source: 'verified market-data endpoints',
      updatedAt: new Date().toISOString(),
      symbols: [
        {
          symbol: 'ETHUSDT',
          contractType: 'PERPETUAL',
          baseAsset: 'ETH',
          quoteAsset: 'USDT',
          lastPrice: 3000,
          priceChangePercent24h: 2,
          quoteVolume24h: 5000000,
          tradeCount24h: 100,
        },
      ],
    };
    const { db } = setup();
    const app = createApp(db, { list: async () => snapshot }).app;
    const response = await request(app)
      .get('/api/markets/futures-symbols?quoteAsset=USDT&minimumVolume=1000000&search=ETH')
      .expect(200);
    expect(response.body.data).toMatchObject({
      exchange: 'BINANCE',
      market: 'USDⓈ-M FUTURES',
      symbols: [{ symbol: 'ETHUSDT', quoteVolume24h: 5000000 }],
    });
    expect(response.body.meta).toEqual({ total: 1, filtered: 1 });
    await request(app).get('/api/markets/futures-symbols?minimumVolume=-1').expect(400);
  });
});

describe('Binance futures market-data adapter', () => {
  const contracts = {
    symbols: [
      {
        symbol: 'BTCUSDT',
        status: 'TRADING',
        contractType: 'PERPETUAL',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
      },
      {
        symbol: 'ETHUSDT',
        status: 'TRADING',
        contractType: 'PERPETUAL',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
      },
      {
        symbol: 'BTCUSDT_261225',
        status: 'TRADING',
        contractType: 'CURRENT_QUARTER',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
      },
      {
        symbol: 'OLDUSDT',
        status: 'SETTLING',
        contractType: 'PERPETUAL',
        baseAsset: 'OLD',
        quoteAsset: 'USDT',
      },
    ],
  };
  const tickers = [
    { symbol: 'BTCUSDT', lastPrice: '65000', priceChangePercent: '1.5', quoteVolume: '9000000', count: 1000 },
    { symbol: 'ETHUSDT', lastPrice: '3000', priceChangePercent: '-0.5', quoteVolume: '20000000', count: 500 },
    {
      symbol: 'BTCUSDT_261225',
      lastPrice: '66000',
      priceChangePercent: '0.5',
      quoteVolume: '1000000',
      count: 25,
    },
  ];

  it('includes all tradable contract types and sorts volume descending within quote assets', async () => {
    const requestMock = vi.fn<typeof fetch>(async (input) => {
      const body = String(input).includes('exchangeInfo') ? contracts : tickers;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const service = new BinanceFuturesMarketsService(requestMock);
    const result = await service.list();
    expect(result.symbols.map((item) => item.symbol)).toEqual(['ETHUSDT', 'BTCUSDT', 'BTCUSDT_261225']);
    expect(result.symbols[2]?.contractType).toBe('CURRENT_QUARTER');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('caches valid market data briefly to avoid unnecessary upstream requests', async () => {
    let timestamp = 1_000;
    const requestMock = vi.fn<typeof fetch>(async (input) => {
      const body = String(input).includes('exchangeInfo') ? contracts : tickers;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const service = new BinanceFuturesMarketsService(requestMock, () => timestamp);
    await service.list();
    await service.list();
    expect(requestMock).toHaveBeenCalledTimes(2);

    timestamp += 30_001;
    await service.list();
    expect(requestMock).toHaveBeenCalledTimes(4);
  });

  it('reports upstream failures instead of returning fabricated or empty market data', async () => {
    const service = new BinanceFuturesMarketsService(
      async () => new Response('unavailable', { status: 503 }),
    );
    await expect(service.list()).rejects.toBeInstanceOf(BinanceMarketDataError);
  });
});
