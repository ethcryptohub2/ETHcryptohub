import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { validCsrf } from '../../../../lib/http';
import { runSignalScan, SignalScanError } from '../../../../lib/signal-scan';
import {
  changeScannerCoins,
  consumeScannerAdminRateLimit,
  getScannerAuditLog,
  getScannerCoinUniverse,
  getScannerSyncState,
  ScannerSyncError,
  syncBinanceScannerUniverse,
} from '../../../../lib/scanner-coins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const symbol = z.string().regex(/^[\p{L}\p{N}]{2,30}$/u);
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('scan_now') }).strict(),
  z.object({ action: z.literal('sync_now') }).strict(),
  z.object({ action: z.literal('enable_coin'), symbol }).strict(),
  z.object({ action: z.literal('disable_coin'), symbol, reason: z.string().trim().max(200).optional() }).strict(),
  z.object({ action: z.literal('enable_selected'), symbols: z.array(symbol).min(1).max(500).refine((items) => new Set(items).size === items.length), confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal('disable_selected'), symbols: z.array(symbol).min(1).max(500).refine((items) => new Set(items).size === items.length), confirm: z.literal(true), reason: z.string().trim().max(200).optional() }).strict(),
  z.object({ action: z.literal('enable_all'), confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal('disable_all'), confirm: z.literal(true), reason: z.string().trim().max(200).optional() }).strict(),
]);

function diagnosticMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/[\r\n\t]/g, ' ').slice(0, 300) || fallback;
}

export async function GET(request: NextRequest) {
  try {
    const admin = await requireAdmin();
    await consumeScannerAdminRateLimit(admin.id, 'read');
    const parsed = z.object({
      auditPage: z.coerce.number().int().min(1).max(100_000).default(1),
    }).safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid scanner audit log page.' }, { status: 422 });
    const [coins, sync, audit] = await Promise.all([
      getScannerCoinUniverse(),
      getScannerSyncState(),
      getScannerAuditLog(parsed.data.auditPage),
    ]);
    const data = coins.reduce((counts, coin) => {
      counts.total += 1;
      if (coin.is_enabled && coin.trading_status === 'TRADING') counts.enabled += 1;
      else counts.disabled += 1;
      if (coin.trading_status === 'TRADING') counts.active += 1;
      else counts.inactive += 1;
      return counts;
    }, { total: 0, enabled: 0, disabled: 0, active: 0, inactive: 0 });
    return NextResponse.json({ data: { coins, metrics: data, sync, audit: audit.entries, auditTotal: audit.total, auditPage: audit.page } }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const rateLimited = message.startsWith('Too many');
    if (!(error instanceof AuthError) && !rateLimited) {
      console.error('Scanner management read failed:', message || 'Unknown error');
    }
    const status = error instanceof AuthError ? error.status : rateLimited ? 429 : 503;
    return NextResponse.json({
      error: error instanceof AuthError || rateLimited
        ? message
        : diagnosticMessage(error, 'Scanner management is unavailable.'),
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const admin = await requireAdmin();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid scanner management action.' }, { status: 400 });
    }
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid scanner management action.' }, { status: 422 });
    const action = parsed.data;
    await consumeScannerAdminRateLimit(
      admin.id,
      action.action === 'sync_now' || action.action === 'scan_now' ? 'sync' : 'write',
    );
    if (action.action === 'scan_now') {
      return NextResponse.json({ data: await runSignalScan('15m') }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (action.action === 'sync_now') {
      const result = await syncBinanceScannerUniverse(admin.id);
      return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const isEnable = action.action.startsWith('enable');
    const symbols = 'symbol' in action
      ? [action.symbol]
      : 'symbols' in action
        ? action.symbols
        : null;
    const result = await changeScannerCoins({
      adminUserId: admin.id,
      action: isEnable ? 'enable' : 'disable',
      symbols,
      reason: 'reason' in action ? action.reason ?? null : null,
    });
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const rateLimited = message.startsWith('Too many');
    const syncFailure = error instanceof ScannerSyncError;
    const scanFailure = error instanceof SignalScanError;
    if (!(error instanceof AuthError) && !rateLimited && !syncFailure && !scanFailure) {
      console.error('Scanner management action failed:', message || 'Unknown error');
    }
    const status = error instanceof AuthError ? error.status : rateLimited ? 429 : syncFailure ? 502 : 503;
    return NextResponse.json({
      error: error instanceof AuthError || rateLimited || syncFailure || scanFailure
        ? message
        : diagnosticMessage(error, 'Scanner management action could not be completed.'),
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
