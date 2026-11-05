import { z } from 'zod';

const positive = z.number().finite().positive();

export const createTradeSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .min(2)
      .max(20)
      .regex(/^[A-Za-z0-9._-]+$/)
      .default('BTCUSDT'),
    quoteAsset: z
      .string()
      .regex(/^[A-Za-z0-9]{2,12}$/)
      .default('USDT'),
    side: z.enum(['LONG', 'SHORT']),
    entryPrice: positive,
    quantity: positive,
    initialStop: positive,
    tp1: positive,
    tp2: positive,
    tp3: positive,
    trailingPercent: z.number().finite().gt(0).max(25).default(1),
    notes: z.string().max(500).optional(),
  })
  .strict();

export const updatePriceSchema = z
  .object({
    eventId: z.string().uuid(),
    price: positive,
  })
  .strict();

export const riskSettingsSchema = z
  .object({
    paperEquity: positive,
    maxOpenPositions: z.number().int().min(1).max(100),
    maxRiskPerTradePercent: z.number().finite().gt(0).max(100),
    maxDailyLossPercent: z.number().finite().gt(0).max(100),
    killSwitchEnabled: z.boolean(),
  })
  .strict();

export const killSwitchSchema = z.object({ enabled: z.boolean() }).strict();
export const tradeIdParamsSchema = z.object({ id: z.string().uuid() });

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  tradeId: z.string().uuid().optional(),
});

export const futuresMarketQuerySchema = z.object({
  quoteAsset: z
    .string()
    .regex(/^[A-Za-z0-9]{2,12}$/)
    .optional(),
  minimumVolume: z.coerce.number().finite().min(0).optional(),
  search: z.string().max(30).optional(),
});

export const marketScannerQuerySchema = z.object({
  quoteAsset: z
    .string()
    .regex(/^[A-Za-z0-9]{2,12}$/)
    .default('USDT'),
  timeframe: z.enum(['5m', '15m', '1h', '4h']).default('15m'),
  minimumVolume: z.coerce.number().finite().min(0).max(1_000_000_000_000).default(10_000_000),
  limit: z.coerce.number().int().min(1).max(30).default(15),
  atrPeriod: z.coerce.number().int().min(2).max(50).default(10),
  multiplier: z.coerce.number().finite().min(0.5).max(10).default(3),
  maxAgeSeconds: z.coerce.number().int().min(30).max(86_400).default(1800),
  minimumScore: z.coerce.number().finite().min(0).max(100).default(60),
});

export const nearChallengeSchema = z
  .object({
    recipient: z.string().min(1).max(255),
  })
  .strict();

export const nearLoginSchema = z
  .object({
    challengeId: z.string().uuid(),
    accountId: z.string().min(2).max(64),
    publicKey: z.string().min(10).max(128),
    signature: z.string().min(80).max(128),
    initialBalance: positive.max(1_000_000_000),
  })
  .strict();

export const portfolioBalanceSchema = z.object({ startingBalance: positive.max(1_000_000_000) }).strict();
export const marketPricesSchema = z
  .object({
    prices: z
      .array(z.object({ symbol: z.string().min(2).max(20), price: positive }).strict())
      .min(1)
      .max(200),
  })
  .strict();

export type CreateTradeInput = z.infer<typeof createTradeSchema>;
