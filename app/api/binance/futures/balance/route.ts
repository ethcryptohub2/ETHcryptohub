import { AuthError, requireUser } from '../../../../../lib/auth';
import { BinanceFuturesError, getFuturesBalance, isTradingEnvironment } from '../../../../../lib/binance-futures';
import { isCredentialEncryptionConfigured } from '../../../../../lib/binance-credentials';
import { assertExchangeFoundationReady, ExchangeFoundationBlockedError } from '../../../../../lib/exchanges/schema';
import { query } from '../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const user = await requireUser();
    if (process.env.SMARTEXIT_BINANCE_BALANCE_READ_ENABLED !== 'true' || !isCredentialEncryptionConfigured()) {
      return Response.json({ code: 'SIGNED_READ_BLOCKED', error: 'Binance balance checks require separate approval.' }, {
        status: 503, headers: noStore,
      });
    }
    await assertExchangeFoundationReady();
    const settings = await query<{ active_environment: unknown }>(
      'SELECT active_environment FROM public.user_trading_settings WHERE user_id = $1',
      [user.id],
    );
    const environment = settings.rows[0]?.active_environment;
    if (!isTradingEnvironment(environment)) {
      return Response.json({ error: 'Select an approved trading environment before requesting an account balance.' }, {
        status: 422, headers: noStore,
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
