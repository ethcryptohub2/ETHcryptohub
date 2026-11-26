import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { ensureBinanceCooldownHydrated } from '../../../../lib/binance-rate-limit-db';
import { validCsrf } from '../../../../lib/http';
import {
  getProviderDiagnosticsForAdmin,
  syncProviderTrackersWithConfig,
} from '../../../../lib/market-data/provider-manager';
import {
  getMarketDataSettingsView,
  getStoredMarketDataSettings,
  resolveCoinApiKey,
  updateMarketDataSettings,
} from '../../../../lib/market-data/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };

const updateSchema = z.object({
  autoFailoverEnabled: z.boolean().optional(),
  binanceEnabled: z.boolean().optional(),
  coinapiEnabled: z.boolean().optional(),
  coinapiApiKey: z.string().max(512).nullable().optional(),
  alternativeEnabled: z.boolean().optional(),
  historicalCacheEnabled: z.boolean().optional(),
  freeOnlyPolicy: z.boolean().optional(),
  fullScanIntervalSeconds: z.coerce.number().int().min(60).max(3600).optional(),
}).strict();

export async function GET() {
  try {
    await requireAdmin();
    await ensureBinanceCooldownHydrated();
    const stored = await getStoredMarketDataSettings();
    syncProviderTrackersWithConfig({
      autoFailoverEnabled: stored.autoFailoverEnabled,
      binanceEnabled: stored.binanceEnabled,
      coinapiEnabled: stored.coinapiEnabled,
      coinapiApiKey: resolveCoinApiKey(stored),
      alternativeEnabled: stored.alternativeEnabled,
      historicalCacheEnabled: stored.historicalCacheEnabled,
    });
    const settings = await getMarketDataSettingsView();
    const providers = getProviderDiagnosticsForAdmin();
    return NextResponse.json({ data: { settings, providers } }, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Market data settings unavailable.' },
      { status: error instanceof AuthError ? error.status : 503, headers: noStore },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!validCsrf(request)) {
    return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403, headers: noStore });
  }
  try {
    await requireAdmin();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid market data settings payload.' }, { status: 400, headers: noStore });
    }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid market data settings parameters.' }, { status: 422, headers: noStore });
    }
    const settings = await updateMarketDataSettings(parsed.data);
    const stored = await getStoredMarketDataSettings();
    syncProviderTrackersWithConfig({
      autoFailoverEnabled: stored.autoFailoverEnabled,
      binanceEnabled: stored.binanceEnabled,
      coinapiEnabled: stored.coinapiEnabled,
      coinapiApiKey: resolveCoinApiKey(stored),
      alternativeEnabled: stored.alternativeEnabled,
      historicalCacheEnabled: stored.historicalCacheEnabled,
    });
    const providers = getProviderDiagnosticsForAdmin();
    return NextResponse.json({ data: { settings, providers } }, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : error instanceof Error ? error.message : 'Failed to save market data settings.' },
      { status: error instanceof AuthError ? error.status : 422, headers: noStore },
    );
  }
}
