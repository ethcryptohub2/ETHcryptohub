import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { AuthError, requireAdmin } from '../../../../../lib/auth';
import { query } from '../../../../../lib/db';
import { validCsrf } from '../../../../../lib/http';
import {
  getExchangeCredentialStatus,
  loadExchangeCredentials,
  markExchangeCredentialsVerified,
  removeExchangeCredentials,
  saveExchangeCredentials,
} from '../../../../../lib/exchanges/credentials';
import { BybitDemoError, createBybitDemoAdapter } from '../../../../../lib/exchanges/bybit-demo';
import {
  isBybitDemoOrderSubmissionEnabled,
  requiresBybitDemoOrderSubmission,
} from '../../../../../lib/exchanges/demo-order-approval';
import { assertExchangeFoundationReady } from '../../../../../lib/exchanges/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const symbol = z.string().regex(/^[A-Z0-9]{2,30}$/);
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('saveCredentials'), apiKey: z.string().min(8).max(256), apiSecret: z.string().min(8).max(512) }).strict(),
  z.object({ action: z.literal('removeCredentials') }).strict(),
  z.object({ action: z.literal('testConnection') }).strict(),
  z.object({ action: z.literal('balance') }).strict(),
  z.object({ action: z.literal('instruments') }).strict(),
  z.object({ action: z.literal('ticker'), symbol }).strict(),
  z.object({ action: z.literal('positions') }).strict(),
  z.object({ action: z.literal('orders'), symbol: symbol.optional() }).strict(),
  z.object({ action: z.literal('reconcile'), symbol, clientOrderId: z.string().regex(/^[A-Za-z0-9_-]{1,36}$/) }).strict(),
  z.object({ action: z.literal('history'), symbol, limit: z.number().int().min(1).max(50).optional() }).strict(),
  z.object({ action: z.literal('executions'), symbol, limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal('closedPnl'), symbol, limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal('leverage'), symbol, leverage: z.number().int().min(1).max(125) }).strict(),
  z.object({
    action: z.literal('marketOrder'),
    symbol,
    side: z.enum(['BUY', 'SELL']),
    quantity: z.string().regex(/^\d+(?:\.\d+)?$/).max(30),
    confirmDemoOrder: z.literal(true),
  }).strict(),
  z.object({
    action: z.literal('limitOrder'),
    symbol,
    side: z.enum(['BUY', 'SELL']),
    quantity: z.string().regex(/^\d+(?:\.\d+)?$/).max(30),
    price: z.string().regex(/^\d+(?:\.\d+)?$/).max(30),
    confirmDemoOrder: z.literal(true),
  }).strict(),
  z.object({
    action: z.literal('cancel'),
    symbol,
    orderId: z.string().regex(/^\d{1,32}$/),
    confirmDemoOrder: z.literal(true),
  }).strict(),
  z.object({
    action: z.literal('protection'),
    symbol,
    stopLoss: z.string().regex(/^\d+(?:\.\d+)?$/).max(30),
    takeProfit: z.string().regex(/^\d+(?:\.\d+)?$/).max(30),
    confirmDemoOrder: z.literal(true),
  }).strict(),
  z.object({ action: z.literal('close'), symbol, confirmDemoOrder: z.literal(true) }).strict(),
  z.object({ action: z.literal('emergencyStop',), enabled: z.boolean() }).strict(),
]);

type LabAction = z.infer<typeof requestSchema>['action'];

async function recordLabEvent(
  adminUserId: number,
  eventType: LabAction,
  status: 'SUCCEEDED' | 'FAILED',
  symbolValue: string | null,
  details: Record<string, unknown> = {},
  error?: string,
) {
  const { exchangeOrderId, clientOrderId, ...detailValues } = details;
  const safeDetails = JSON.stringify(detailValues);
  await query(
    `INSERT INTO public.exchange_execution_events (
       admin_user_id, exchange, environment, event_type, status, symbol,
       exchange_order_id, client_order_id, safe_details, error_message
     ) VALUES ($1, 'BYBIT', 'DEMO', $2, $3, $4, $5, $6, $7::JSONB, $8)`,
    [
      adminUserId, eventType.toUpperCase(), status, symbolValue,
      typeof exchangeOrderId === 'string' ? exchangeOrderId : null,
      typeof clientOrderId === 'string' ? clientOrderId : null,
      safeDetails, error?.slice(0, 500) ?? null,
    ],
  );
}

async function getEmergencyStop(adminUserId: number) {
  const result = await query<{ emergency_stop_enabled: boolean }>(
    `SELECT emergency_stop_enabled
       FROM public.user_exchange_trading_settings
      WHERE user_id = $1 AND exchange = 'BYBIT' AND environment = 'DEMO'`,
    [adminUserId],
  );
  return result.rows[0]?.emergency_stop_enabled ?? false;
}

async function assertLabRateLimit(adminUserId: number) {
  const result = await query<{ count: number }>(
    `SELECT COUNT(*)::INTEGER AS count
       FROM public.exchange_execution_events
      WHERE admin_user_id = $1 AND exchange = 'BYBIT' AND environment = 'DEMO'
        AND created_at >= NOW() - INTERVAL '1 minute'`,
    [adminUserId],
  );
  if ((result.rows[0]?.count ?? 0) >= 20) {
    throw new BybitDemoError('Bybit Demo testing limit reached. Wait one minute before issuing more test requests.', 429);
  }
}

export async function GET() {
  try {
    const admin = await requireAdmin();
    await assertExchangeFoundationReady();
    const [credentialStatus, stopped, events] = await Promise.all([
      getExchangeCredentialStatus(admin.id, 'BYBIT', 'DEMO'),
      getEmergencyStop(admin.id),
      query(
        `SELECT id::TEXT, event_type, status, symbol, exchange_order_id, client_order_id,
                safe_details, error_message, created_at
           FROM public.exchange_execution_events
          WHERE admin_user_id = $1 AND exchange = 'BYBIT' AND environment = 'DEMO'
          ORDER BY created_at DESC LIMIT 50`,
        [admin.id],
      ),
    ]);
    return Response.json({
      data: {
        exchange: 'BYBIT',
        environment: 'DEMO',
        credentialStatus,
        emergencyStop: stopped,
        orderSubmissionEnabled: isBybitDemoOrderSubmissionEnabled(),
        events: events.rows,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json(
      { error: error instanceof Error ? error.message : 'Bybit Demo testing status is unavailable.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  let action: LabAction = 'testConnection';
  let eventSymbol: string | null = null;
  let clientOrderId: string | null = null;
  let adminUserId = 0;
  try {
    const admin = await requireAdmin();
    adminUserId = admin.id;
    await assertExchangeFoundationReady();
    const body: unknown = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Invalid Bybit Demo testing request.' }, { status: 422 });
    const input = parsed.data;
    action = input.action;
    eventSymbol = 'symbol' in input ? input.symbol ?? null : null;
    if (input.action !== 'emergencyStop') await assertLabRateLimit(admin.id);
    if (requiresBybitDemoOrderSubmission(input.action) && !isBybitDemoOrderSubmissionEnabled()) {
      throw new BybitDemoError(
        'Bybit Demo order actions are disabled until separately authorized and validated.',
        403,
      );
    }

    if (input.action === 'saveCredentials') {
      await saveExchangeCredentials(admin.id, 'BYBIT', 'DEMO', {
        apiKey: input.apiKey,
        apiSecret: input.apiSecret,
      });
      await recordLabEvent(admin.id, action, 'SUCCEEDED', null);
      return Response.json({ data: await getExchangeCredentialStatus(admin.id, 'BYBIT', 'DEMO') }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (input.action === 'removeCredentials') {
      await removeExchangeCredentials(admin.id, 'BYBIT', 'DEMO');
      await recordLabEvent(admin.id, action, 'SUCCEEDED', null);
      return Response.json({ data: await getExchangeCredentialStatus(admin.id, 'BYBIT', 'DEMO') }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (input.action === 'emergencyStop') {
      await query(
        `INSERT INTO public.user_exchange_trading_settings (
           user_id, exchange, environment, emergency_stop_enabled, auto_trade_enabled
         ) VALUES ($1, 'BYBIT', 'DEMO', $2, FALSE)
         ON CONFLICT (user_id, exchange, environment) DO UPDATE SET
           emergency_stop_enabled = EXCLUDED.emergency_stop_enabled,
           auto_trade_enabled = FALSE,
           updated_at = NOW()`,
        [admin.id, input.enabled],
      );
      await recordLabEvent(admin.id, action, 'SUCCEEDED', null, { enabled: input.enabled });
      return Response.json({ data: { emergencyStop: input.enabled } }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const credentials = await loadExchangeCredentials(admin.id, 'BYBIT', 'DEMO');
    const adapter = createBybitDemoAdapter(credentials);

    let data: unknown;
    switch (input.action) {
      case 'testConnection':
        await adapter.testConnection();
        await markExchangeCredentialsVerified(admin.id, 'BYBIT', 'DEMO');
        data = { connected: true, exchange: 'BYBIT', environment: 'DEMO' };
        break;
      case 'balance':
        data = await adapter.getAccountBalance();
        break;
      case 'instruments':
        data = (await adapter.getMarketInstruments()).filter((item) => item.contractType === 'PERPETUAL' && item.status === 'Trading').slice(0, 100);
        break;
      case 'ticker':
        data = await adapter.getTicker(input.symbol);
        break;
      case 'positions':
        data = await adapter.getPositions();
        break;
      case 'orders':
        data = await adapter.getOpenOrders(input.symbol);
        break;
      case 'reconcile':
        data = await adapter.reconcileOrder(input.symbol, input.clientOrderId);
        break;
      case 'history':
        data = await adapter.getOrderHistory(input.symbol, input.limit);
        break;
      case 'executions':
        data = await adapter.getExecutionHistory(input.symbol, input.limit);
        break;
      case 'closedPnl':
        data = await adapter.getClosedPnl(input.symbol, input.limit);
        break;
      case 'leverage':
        if (await getEmergencyStop(admin.id)) throw new BybitDemoError('Bybit Demo emergency stop is active.', 409);
        await adapter.setLeverage(input.symbol, input.leverage);
        data = { updated: true, symbol: input.symbol, leverage: input.leverage };
        break;
      case 'marketOrder': {
        if (await getEmergencyStop(admin.id)) throw new BybitDemoError('Bybit Demo emergency stop is active.', 409);
        clientOrderId = `lab${randomUUID().replaceAll('-', '')}`.slice(0, 36);
        const order = await adapter.placeMarketOrder({
          symbol: input.symbol,
          side: input.side,
          quantity: input.quantity,
          clientOrderId,
        });
        data = order;
        break;
      }
      case 'limitOrder': {
        if (await getEmergencyStop(admin.id)) throw new BybitDemoError('Bybit Demo emergency stop is active.', 409);
        clientOrderId = `lab${randomUUID().replaceAll('-', '')}`.slice(0, 36);
        const order = await adapter.placeLimitOrder({
          symbol: input.symbol,
          side: input.side,
          quantity: input.quantity,
          price: input.price,
          clientOrderId,
        });
        data = order;
        break;
      }
      case 'cancel':
        await adapter.cancelOrder(input.symbol, input.orderId);
        data = { canceled: true, symbol: input.symbol, orderId: input.orderId };
        break;
      case 'protection':
        if (await getEmergencyStop(admin.id)) throw new BybitDemoError('Bybit Demo emergency stop is active.', 409);
        await adapter.setPositionProtection(input.symbol, input.stopLoss, input.takeProfit);
        data = { protected: true, symbol: input.symbol, stopLoss: input.stopLoss, takeProfit: input.takeProfit };
        break;
      case 'close':
        clientOrderId = `lab${randomUUID().replaceAll('-', '')}`.slice(0, 36);
        data = await adapter.closePosition(input.symbol, clientOrderId);
        break;
    }
    const summary = typeof data === 'object' && data !== null
      ? Object.fromEntries(
          Object.entries(data).filter(([key, value]) =>
            ['exchangeOrderId', 'clientOrderId', 'orderId', 'status', 'connected', 'cancelled', 'leverage', 'stopLoss', 'takeProfit'].includes(key) &&
            (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')),
        )
      : {};
    await recordLabEvent(admin.id, action, 'SUCCEEDED', eventSymbol, {
      ...summary,
      ...(data && typeof data === 'object' && 'exchangeOrderId' in data ? { exchangeOrderId: data.exchangeOrderId } : {}),
      ...(data && typeof data === 'object' && 'clientOrderId' in data ? { clientOrderId: data.clientOrderId } : {}),
    });
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof BybitDemoError ? error.status : 503;
    if (adminUserId) {
      try {
        await recordLabEvent(
          adminUserId,
          action,
          'FAILED',
          eventSymbol,
          clientOrderId ? { clientOrderId } : {},
          error instanceof Error ? error.message : 'Unknown Bybit Demo failure.',
        );
      } catch (recordError) {
        console.error('Could not record Bybit Demo testing event:', recordError instanceof Error ? recordError.message : 'Unknown database error.');
      }
    }
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Bybit Demo request failed.',
        ...(clientOrderId ? { clientOrderId } : {}),
      },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
