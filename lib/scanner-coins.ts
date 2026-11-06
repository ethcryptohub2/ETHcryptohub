import { pool, query } from './db';
import {
  fetchBinanceUsdtPerpetuals,
  type BinanceContractMetadata,
} from '../smartexit/apps/api/src/services/binance-futures-markets';
import type { MarketScannerCandidate } from '../smartexit/apps/api/src/services/market-scanner';

const EXCHANGE = 'BINANCE';
const CONTRACT = 'PERPETUAL';

export class ScannerSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerSyncError';
  }
}

export interface ScannerCoin {
  id: string;
  symbol: string;
  base_asset: string;
  quote_asset: string;
  exchange: string;
  contract_type: string;
  trading_status: string;
  is_enabled: boolean;
  is_admin_disabled: boolean;
  disable_reason: string | null;
  first_listed_at: string | null;
  last_synced_at: string;
  updated_at: string;
}

export function isEligibleScannerCoin(coin: Pick<ScannerCoin,
  'symbol' | 'base_asset' | 'quote_asset' | 'exchange' | 'contract_type' | 'trading_status' | 'is_enabled'
>): boolean {
  return coin.exchange === EXCHANGE &&
    coin.quote_asset === 'USDT' &&
    coin.contract_type === CONTRACT &&
    coin.trading_status === 'TRADING' &&
    coin.is_enabled &&
    /^[\p{L}\p{N}]{2,30}$/u.test(coin.symbol) &&
    /^[\p{L}\p{N}]{1,20}$/u.test(coin.base_asset) &&
    coin.symbol === `${coin.base_asset}USDT`;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown synchronization error.';
  return message.replace(/[\r\n]/g, ' ').slice(0, 400);
}

export async function syncBinanceScannerUniverse(
  adminUserId: number | null,
  request: typeof fetch = globalThis.fetch,
) {
  let contracts: BinanceContractMetadata[];
  try {
    contracts = await fetchBinanceUsdtPerpetuals(request);
  } catch (error) {
    const message = safeErrorMessage(error);
    console.error('Binance scanner contract discovery failed:', message);
    await query(
      `INSERT INTO public.scanner_sync_state
        (singleton, last_attempt_at, exchange_status, last_error, updated_at)
       VALUES (TRUE, NOW(), 'ERROR', $1, NOW())
       ON CONFLICT (singleton) DO UPDATE SET
         last_attempt_at = NOW(), exchange_status = 'ERROR',
         last_error = EXCLUDED.last_error, updated_at = NOW()`,
      [message],
    );
    await query(
      `INSERT INTO public.scanner_coin_audit_log
        (action, admin_user_id, reason, new_state)
       VALUES ('SYNC_FAILED', $1, $2, jsonb_build_object('exchange', 'BINANCE'))`,
      [adminUserId, message],
    );
    throw new ScannerSyncError(message);
  }
  if (!contracts.some((contract) => contract.status === 'TRADING')) {
    const message = 'Binance returned no eligible USDT perpetual contracts; existing scanner settings were left unchanged.';
    console.error(message);
    await query(
      `INSERT INTO public.scanner_sync_state
        (singleton, last_attempt_at, exchange_status, last_error, updated_at)
       VALUES (TRUE, NOW(), 'ERROR', $1, NOW())
       ON CONFLICT (singleton) DO UPDATE SET
         last_attempt_at = NOW(), exchange_status = 'ERROR',
         last_error = EXCLUDED.last_error, updated_at = NOW()`,
      [message],
    );
    await query(
      `INSERT INTO public.scanner_coin_audit_log
        (action, admin_user_id, reason, new_state)
       VALUES ('SYNC_FAILED', $1, $2, jsonb_build_object('exchange', 'BINANCE'))`,
      [adminUserId, message],
    );
    throw new ScannerSyncError(message);
  }

  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('scanner_coin_universe_sync'))");
    const currentResult = await client.query<ScannerCoin>(
      `SELECT id::text, symbol, base_asset, quote_asset, exchange, contract_type,
              trading_status, is_enabled, is_admin_disabled, disable_reason,
              first_listed_at, last_synced_at, updated_at
         FROM public.scanner_coin_configs
        WHERE exchange = 'BINANCE' AND quote_asset = 'USDT' AND contract_type = 'PERPETUAL'
        FOR UPDATE`,
    );
    const currentBySymbol = new Map(currentResult.rows.map((coin) => [coin.symbol, coin]));
    const contractPayload = contracts.map((contract) => ({
      symbol: contract.symbol,
      base_asset: contract.baseAsset,
      quote_asset: contract.quoteAsset,
      status: contract.status,
      onboard_date: contract.onboardDate,
    }));
    const upsertResult = await client.query<{ symbol: string }>(
      `INSERT INTO public.scanner_coin_configs
        (symbol, base_asset, quote_asset, exchange, contract_type, trading_status,
         is_enabled, is_admin_disabled, disable_reason, first_listed_at, last_synced_at, updated_at)
      SELECT symbol, base_asset, quote_asset, 'BINANCE', 'PERPETUAL', status,
             status = 'TRADING', FALSE, CASE WHEN status = 'TRADING' THEN NULL ELSE status END,
             CASE WHEN onboard_date IS NULL THEN NULL ELSE to_timestamp(onboard_date / 1000.0) END,
             NOW(), NOW()
        FROM jsonb_to_recordset($1::jsonb) AS contract(
          symbol TEXT, base_asset TEXT, quote_asset TEXT, status TEXT, onboard_date BIGINT
        )
      ON CONFLICT (exchange, symbol) DO UPDATE SET
        base_asset = EXCLUDED.base_asset,
        quote_asset = EXCLUDED.quote_asset,
        contract_type = EXCLUDED.contract_type,
        trading_status = EXCLUDED.trading_status,
        is_enabled = CASE
          WHEN EXCLUDED.trading_status = 'TRADING'
            THEN NOT public.scanner_coin_configs.is_admin_disabled
          ELSE FALSE
        END,
        disable_reason = CASE
          WHEN public.scanner_coin_configs.is_admin_disabled
            THEN COALESCE(public.scanner_coin_configs.disable_reason, 'ADMIN_DISABLED')
          WHEN EXCLUDED.trading_status <> 'TRADING'
            THEN EXCLUDED.trading_status
          ELSE NULL
        END,
        first_listed_at = COALESCE(public.scanner_coin_configs.first_listed_at, EXCLUDED.first_listed_at),
        last_synced_at = NOW(),
        updated_at = NOW()
      RETURNING symbol`,
      [JSON.stringify(contractPayload)],
    );
    const allSymbols = contracts.map((contract) => contract.symbol);
    const inactiveStatuses = contracts.filter((contract) => contract.status !== 'TRADING');
    await client.query(
      `UPDATE public.scanner_coin_configs
          SET trading_status = 'NOT_LISTED',
              is_enabled = FALSE,
              disable_reason = CASE WHEN is_admin_disabled
                THEN COALESCE(disable_reason, 'ADMIN_DISABLED') ELSE 'NOT_LISTED' END,
              last_synced_at = NOW(),
              updated_at = NOW()
        WHERE exchange = 'BINANCE' AND quote_asset = 'USDT' AND contract_type = 'PERPETUAL'
          AND NOT (symbol = ANY($1::text[]))`,
      [allSymbols],
    );
    const inactiveSymbols = [
      ...inactiveStatuses.map((contract) => contract.symbol),
      ...currentResult.rows.filter((coin) => !allSymbols.includes(coin.symbol)).map((coin) => coin.symbol),
    ];
    if (inactiveSymbols.length > 0) {
      await client.query(
        `UPDATE public.market_signals
            SET status = 'ENTRY_INVALIDATED'
          WHERE symbol = ANY($1::text[])
            AND status IN ('ACTIVE', 'TP1_HIT', 'TP2_HIT')`,
        [inactiveSymbols],
      );
    }

    const newSymbols = contracts.filter((contract) => !currentBySymbol.has(contract.symbol));
    const statusChanges = contracts.filter((contract) => {
      const current = currentBySymbol.get(contract.symbol);
      return current && current.trading_status !== contract.status;
    });
    const missingSymbols = currentResult.rows.filter((coin) => !allSymbols.includes(coin.symbol));
    const changedMetadata = contracts.filter((contract) => {
      const current = currentBySymbol.get(contract.symbol);
      return current && (
        current.base_asset !== contract.baseAsset ||
        current.quote_asset !== contract.quoteAsset ||
        current.contract_type !== contract.contractType
      );
    });
    const syncAuditRows = [
      ...newSymbols.map((contract) => ({
        action: 'AUTO_ADDED',
        symbol: contract.symbol,
        previous: null,
        next: { baseAsset: contract.baseAsset, quoteAsset: contract.quoteAsset, status: contract.status },
        reason: 'Discovered as an eligible Binance USDⓈ-M USDT perpetual contract.',
      })),
      ...statusChanges.map((contract) => ({
        action: 'EXCHANGE_STATUS_CHANGED',
        symbol: contract.symbol,
        previous: { status: currentBySymbol.get(contract.symbol)?.trading_status },
        next: { status: contract.status },
        reason: 'Contract status synchronized from Binance exchange information.',
      })),
      ...missingSymbols.map((coin) => ({
        action: 'EXCHANGE_STATUS_CHANGED',
        symbol: coin.symbol,
        previous: { status: coin.trading_status },
        next: { status: 'NOT_LISTED' },
        reason: 'Contract was absent from Binance exchange information.',
      })),
      ...changedMetadata.map((contract) => ({
        action: 'CONTRACT_METADATA_UPDATED',
        symbol: contract.symbol,
        previous: {
          baseAsset: currentBySymbol.get(contract.symbol)?.base_asset,
          quoteAsset: currentBySymbol.get(contract.symbol)?.quote_asset,
          contractType: currentBySymbol.get(contract.symbol)?.contract_type,
        },
        next: { baseAsset: contract.baseAsset, quoteAsset: contract.quoteAsset, contractType: contract.contractType },
        reason: 'Contract metadata synchronized from Binance.',
      })),
    ];
    if (syncAuditRows.length > 0) {
      await client.query(
        `INSERT INTO public.scanner_coin_audit_log
          (action, symbol, admin_user_id, previous_state, new_state, reason)
         SELECT action, symbol, $2::BIGINT, previous_state, new_state, reason
           FROM jsonb_to_recordset($1::jsonb) AS event(
             action TEXT, symbol TEXT, previous_state JSONB, new_state JSONB, reason TEXT
           )`,
        [JSON.stringify(syncAuditRows.map((entry) => ({
          action: entry.action,
          symbol: entry.symbol,
          previous_state: entry.previous,
          new_state: entry.next,
          reason: entry.reason,
        }))), adminUserId],
      );
    }
    const inactiveCount = new Set([
      ...inactiveStatuses.map((contract) => contract.symbol),
      ...currentResult.rows.filter((coin) => !allSymbols.includes(coin.symbol)).map((coin) => coin.symbol),
    ]).size;
    const updatedCount = changedMetadata.length + statusChanges.length + missingSymbols.length;
    await client.query(
      `INSERT INTO public.scanner_sync_state
        (singleton, last_attempt_at, last_success_at, discovered_count,
         newly_added_count, updated_count, inactive_count, exchange_status, last_error, updated_at)
       VALUES (TRUE, NOW(), NOW(), $1, $2, $3, $4, 'OK', NULL, NOW())
       ON CONFLICT (singleton) DO UPDATE SET
         last_attempt_at = NOW(), last_success_at = NOW(),
         discovered_count = EXCLUDED.discovered_count,
         newly_added_count = EXCLUDED.newly_added_count,
         updated_count = EXCLUDED.updated_count,
         inactive_count = EXCLUDED.inactive_count,
         exchange_status = 'OK', last_error = NULL, updated_at = NOW()`,
      [contracts.length, newSymbols.length, updatedCount, inactiveCount],
    );
    await client.query(
      `INSERT INTO public.scanner_coin_audit_log (action, admin_user_id, reason, new_state)
       VALUES ('SYNC_COMPLETED', $1, 'Binance Futures contract universe synchronized.',
         jsonb_build_object(
           'discovered', $2::integer,
           'added', $3::integer,
           'updated', $4::integer,
           'inactive', $5::integer
         ))`,
      [adminUserId, contracts.length, newSymbols.length, updatedCount, inactiveCount],
    );
    await client.query('COMMIT');
    return {
      discovered: contracts.length,
      added: newSymbols.length,
      updated: updatedCount,
      inactive: inactiveCount,
      updatedRows: upsertResult.rowCount ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    const message = safeErrorMessage(error);
    console.error('Binance scanner universe synchronization failed:', message);
    try {
      await client.query(
        `INSERT INTO public.scanner_sync_state
          (singleton, last_attempt_at, exchange_status, last_error, updated_at)
         VALUES (TRUE, NOW(), 'ERROR', $1, NOW())
         ON CONFLICT (singleton) DO UPDATE SET
           last_attempt_at = NOW(), exchange_status = 'ERROR',
           last_error = EXCLUDED.last_error, updated_at = NOW()`,
        [message],
      );
      await client.query(
        `INSERT INTO public.scanner_coin_audit_log
          (action, admin_user_id, reason, new_state)
         VALUES ('SYNC_FAILED', $1, $2, jsonb_build_object('exchange', 'BINANCE'))`,
        [adminUserId, message],
      );
    } catch (recordError) {
      console.error('Scanner sync failure could not be recorded:', safeErrorMessage(recordError));
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getScannerCoinUniverse(): Promise<ScannerCoin[]> {
  const result = await query<ScannerCoin>(
    `SELECT id::text, symbol, base_asset, quote_asset, exchange, contract_type,
            trading_status, is_enabled, is_admin_disabled, disable_reason,
            first_listed_at, last_synced_at, updated_at
       FROM public.scanner_coin_configs
      ORDER BY symbol
      LIMIT 2000`,
  );
  return result.rows;
}

export async function getEnabledScannerSymbols(): Promise<string[]> {
  const coins = await query<ScannerCoin>(
    `SELECT id::text, symbol, base_asset, quote_asset, exchange, contract_type,
            trading_status, is_enabled, is_admin_disabled, disable_reason,
            first_listed_at, last_synced_at, updated_at
       FROM public.scanner_coin_configs
      WHERE exchange = 'BINANCE' AND quote_asset = 'USDT'
        AND contract_type = 'PERPETUAL' AND trading_status = 'TRADING'
        AND is_enabled = TRUE
      ORDER BY symbol`,
  );
  return coins.rows.filter(isEligibleScannerCoin).map((coin) => coin.symbol);
}

export async function getScannerSyncState() {
  const result = await query(
    `SELECT last_attempt_at, last_success_at, discovered_count, newly_added_count,
            updated_count, inactive_count, exchange_status, last_error
       FROM public.scanner_sync_state WHERE singleton = TRUE`,
  );
  return result.rows[0] ?? null;
}

export async function getScannerAuditLog(limit = 50) {
  const result = await query(
    `SELECT id, action, symbol, admin_user_id, previous_state, new_state, reason, created_at
       FROM public.scanner_coin_audit_log
      ORDER BY created_at DESC LIMIT $1`,
    [Math.min(100, Math.max(1, limit))],
  );
  return result.rows;
}

export async function consumeScannerAdminRateLimit(
  userId: number,
  action: 'read' | 'write' | 'sync',
) {
  const limit = action === 'read' ? 120 : action === 'write' ? 30 : 2;
  const result = await query<{ allowed: boolean }>(
    `INSERT INTO public.scanner_admin_rate_limits (user_id, action, window_started_at, request_count)
     VALUES ($1, $2, date_trunc('minute', NOW()), 1)
     ON CONFLICT (user_id, action, window_started_at) DO UPDATE
       SET request_count = public.scanner_admin_rate_limits.request_count + 1
       WHERE public.scanner_admin_rate_limits.request_count < $3
     RETURNING TRUE AS allowed`,
    [userId, action, limit],
  );
  if (!result.rows[0]?.allowed) throw new Error('Too many scanner management requests. Wait a minute and retry.');
}

export async function changeScannerCoins(input: {
  adminUserId: number;
  action: 'enable' | 'disable';
  symbols: string[] | null;
  reason: string | null;
}) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const enabled = input.action === 'enable';
    const symbols = input.symbols;
    const targetResult = await client.query<ScannerCoin>(
      `SELECT id::text, symbol, base_asset, quote_asset, exchange, contract_type,
              trading_status, is_enabled, is_admin_disabled, disable_reason,
              first_listed_at, last_synced_at, updated_at
         FROM public.scanner_coin_configs
        WHERE exchange = 'BINANCE' AND quote_asset = 'USDT' AND contract_type = 'PERPETUAL'
          AND ($1::text[] IS NULL OR symbol = ANY($1::text[]))
          AND ($2::boolean = FALSE OR trading_status = 'TRADING')
          AND (is_enabled <> $3 OR is_admin_disabled <> $4)
        FOR UPDATE`,
      [symbols, enabled, enabled, !enabled],
    );
    if (targetResult.rows.length > 0) {
      await client.query(
        `UPDATE public.scanner_coin_configs
            SET is_enabled = $2, is_admin_disabled = $3,
                disable_reason = $4, updated_at = NOW()
          WHERE id = ANY($1::bigint[])`,
        [
          targetResult.rows.map((coin) => coin.id),
          enabled,
          !enabled,
          enabled ? null : (input.reason ?? 'ADMIN_DISABLED'),
        ],
      );
      const bulkAction = symbols === null || (symbols?.length ?? 0) > 1;
      const auditAction = bulkAction
        ? enabled ? 'BULK_ENABLED' : 'BULK_DISABLED'
        : enabled ? 'ADMIN_ENABLED' : 'ADMIN_DISABLED';
      const auditPayload = targetResult.rows.map((coin) => ({
        symbol: coin.symbol,
        previous_enabled: coin.is_enabled,
        previous_admin_disabled: coin.is_admin_disabled,
      }));
      await client.query(
        `INSERT INTO public.scanner_coin_audit_log
          (action, symbol, admin_user_id, previous_state, new_state, reason)
         SELECT $1, symbol, $2,
                jsonb_build_object('enabled', previous_enabled, 'adminDisabled', previous_admin_disabled),
                jsonb_build_object('enabled', $3::boolean, 'adminDisabled', $4::boolean), $5
           FROM jsonb_to_recordset($6::jsonb) AS coin(
             symbol TEXT, previous_enabled BOOLEAN, previous_admin_disabled BOOLEAN
           )`,
        [
          auditAction,
          input.adminUserId,
          enabled,
          !enabled,
          input.reason ?? (enabled ? null : 'ADMIN_DISABLED'),
          JSON.stringify(auditPayload),
        ],
      );
    }
    if (!enabled && targetResult.rows.length > 0) {
      await client.query(
        `UPDATE public.market_signals
            SET status = 'ENTRY_INVALIDATED'
          WHERE symbol = ANY($1::text[])
            AND status IN ('ACTIVE', 'TP1_HIT', 'TP2_HIT')`,
        [targetResult.rows.map((coin) => coin.symbol)],
      );
    }
    await client.query('COMMIT');
    return { changed: targetResult.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function saveScannerCandidates(candidates: MarketScannerCandidate[]) {
  if (candidates.length === 0) return;
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    for (const candidate of candidates) {
      await client.query(
        `INSERT INTO public.scanner_candidate_snapshots
          (symbol, timeframe, exchange, candidate_json, scanned_at)
         VALUES ($1, $2, 'BINANCE', $3::jsonb, NOW())
         ON CONFLICT (symbol, timeframe) DO UPDATE SET
           exchange = EXCLUDED.exchange,
           candidate_json = EXCLUDED.candidate_json,
           scanned_at = NOW()`,
        [candidate.symbol, candidate.timeframe, JSON.stringify(candidate)],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getScannerCandidateSnapshots(
  timeframe: '5m' | '15m' | '1h' | '4h',
  symbols: string[],
) {
  if (symbols.length === 0) return [];
  const result = await query<{ candidate_json: MarketScannerCandidate; scanned_at: string }>(
    `SELECT snapshot.candidate_json, snapshot.scanned_at
       FROM public.scanner_candidate_snapshots AS snapshot
       JOIN public.scanner_coin_configs AS coin
         ON coin.exchange = snapshot.exchange AND coin.symbol = snapshot.symbol
      WHERE snapshot.timeframe = $1 AND snapshot.symbol = ANY($2::text[])
        AND coin.quote_asset = 'USDT' AND coin.contract_type = 'PERPETUAL'
        AND coin.trading_status = 'TRADING' AND coin.is_enabled = TRUE
      ORDER BY snapshot.scanned_at DESC`,
    [timeframe, symbols],
  );
  return result.rows;
}
