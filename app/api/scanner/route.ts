import { NextRequest, NextResponse } from 'next/server';
import { requireUser, AuthError } from '../../../lib/auth';
import { marketScannerQuerySchema } from '../../../smartexit/apps/api/src/schemas';
import { BinanceFuturesMarketsService } from '../../../smartexit/apps/api/src/services/binance-futures-markets';
import { BinanceMarketScannerService } from '../../../smartexit/apps/api/src/services/market-scanner';

export const runtime = 'nodejs';
export const maxDuration = 60;

const markets = new BinanceFuturesMarketsService();
const scanner = new BinanceMarketScannerService(markets);

export async function GET(request: NextRequest) {
  try {
    await requireUser();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Sign in is required.' },
      { status: error instanceof AuthError ? error.status : 401 },
    );
  }

  const parsed = marketScannerQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid scanner configuration.' }, { status: 422 });

  try {
    const result = await scanner.scan({ ...parsed.data, quoteAsset: 'USDT' });
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Binance scanner request failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Live Binance market data is temporarily unavailable.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
