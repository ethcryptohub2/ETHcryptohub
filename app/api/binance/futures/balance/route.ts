import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../../lib/auth';
import { isBinanceBalanceReadAllowed } from '../../../../../lib/binance-demo-access';
import { BinanceFuturesError, getFuturesBalance, isTradingEnvironment } from '../../../../../lib/binance-futures';
import { isCredentialEncryptionConfigured } from '../../../../../lib/binance-credentials';
import { assertExchangeFoundationReady, ExchangeFoundationBlockedError } from '../../../../../lib/exchanges/schema';
import { query } from '../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request?: NextRequest) {
  try {
    const user = await requireUser();
    const requested = request && 'nextUrl' in request ? request.nextUrl.searchParams.get('environment') : null;
    if (request && 'headers' in request && process.env.SMARTEXIT_BACKEND_URL?.trim()) {
      const { forwardRequestToBackend, shouldForwardToBackend } = await import('../../../../../lib/backend-proxy');
      if (shouldForwardToBackend()) {
        const forwarded = await forwardRequestToBackend(
          request,
          `${request.nextUrl.pathname}${request.nextUrl.search}`,
        );
        if (forwarded) return forwarded;
      }
    }
    const requestedEnv = requested && isTradingEnvironment(requested) ? requested : 'DEMO';
    if (!isBinanceBalanceReadAllowed(requestedEnv) || !isCredentialEncryptionConfigured()) {
      return Response.json({ code: 'SIGNED_READ_BLOCKED', error: 'Binance balance checks require separate approval.' }, {
        status: 503, headers: noStore,
      });
    }
    await assertExchangeFoundationReady();
    const settings = await query<{ active_environment: unknown }>(
      'SELECT active_environment FROM public.user_trading_settings WHERE user_id = $1',
      [user.id],
    );
    const environment = requested && isTradingEnvironment(requested)
      ? requested
      : settings.rows[0]?.active_environment;
    if (!isTradingEnvironment(environment)) {
      return Response.json({ error: 'Select an approved trading environment before requesting an account balance.' }, {
        status: 422, headers: noStore,
      });
    }
    if (!isBinanceBalanceReadAllowed(environment)) {
      return Response.json({ code: 'SIGNED_READ_BLOCKED', error: 'Binance balance checks require separate approval.' }, {
        status: 503, headers: noStore,
      });
    }
    const data = await getFuturesBalance(user.id, environment);
    return Response.json({ data }, { headers: noStore });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof BinanceFuturesError ? error.status : 503;
    return Response.json(
      { error: error instanceof AuthError || error instanceof ExchangeFoundationBlockedError
        ? error.message : 'Binance Futures balance is unavailable.' },
      { status, headers: noStore },
    );
  }
}
