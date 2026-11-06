import { NextRequest, NextResponse } from 'next/server';
import { requireUser, AuthError } from '../../../lib/auth';
import { marketScannerQuerySchema } from '../../../smartexit/apps/api/src/schemas';
import { PublicFuturesMarketsService } from '../../../smartexit/apps/api/src/services/binance-futures-markets';
import { BinanceMarketScannerService } from '../../../smartexit/apps/api/src/services/market-scanner';
import type { MarketResearchProvider } from '../../../smartexit/apps/api/src/services/market-research';
import { loadMarketResearchProvider } from '../../../lib/market-research-settings';

export const runtime = 'nodejs';
export const maxDuration = 60;

const markets = new PublicFuturesMarketsService();

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

  let researchProvider: MarketResearchProvider;
  try {
    researchProvider = await loadMarketResearchProvider();
  } catch (error) {
    console.error('Market research settings could not be loaded:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Research settings are unavailable. Check database migration and credential-encryption configuration.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const scanner = new BinanceMarketScannerService(markets, globalThis.fetch, Date.now, researchProvider);
    const result = await scanner.scan({ ...parsed.data, quoteAsset: 'USDT' });
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Public futures scanner request failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Public futures market data is temporarily unavailable.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
