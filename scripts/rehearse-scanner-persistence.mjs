import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import pg from 'pg';
import ts from 'typescript';

const roleOnly = process.argv[2] === '--disposable-pilot-role';
if (process.argv.length !== 3 || (process.argv[2] !== '--disposable-loopback' && !roleOnly)) {
  throw new Error('Requires --disposable-loopback or --disposable-pilot-role and a fresh isolated scanner_fixture database on port 53104.');
}

function load(file, mocks = {}) {
  const filename = path.resolve(file);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const req = mod.require.bind(mod);
  mod.require = key => key in mocks ? mocks[key] : req(key);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}
const client = new pg.Pool({ host: '127.0.0.1', port: 53104, database: 'scanner_fixture',
  user: 'scanner_fixture', ssl: false, max: 1, connectionTimeoutMillis: 2000 });
const query = (...args) => client.query(...args);
const count = async (sql, args) => Number((await query(sql, args)).rows[0].n);
process.env.SUPABASE_DB_URL = 'postgresql://scanner_fixture@127.0.0.1:53104/scanner_fixture';
let outbound = 0;
const forbidden = () => { outbound++; throw new Error('Unexpected outbound transport'); };
globalThis.fetch = forbidden;
const db = load('lib/db.ts', { pg: { Pool: class { constructor() { return client; } } },
  './ui-preview-mode.mjs': { assertDatabaseAccessAllowed() {}, getUiPreviewFlagStatus: () => 'disabled' } });
const engine = load('smartexit/apps/api/src/services/market-scanner.ts');
const lifecycle = { processPersistedSignalLifecycle: async () => {} };
const appNotifications = load('lib/notifications.ts', { './db': db, './signal-lifecycle': lifecycle,
  './pagination': { TABLE_PAGE_SIZE: 10 }, 'web-push': { sendNotification: forbidden, setVapidDetails: forbidden } });
const history = load('lib/signal-history.ts', { './db': db });
const interval = 300_000;
const boundary = Math.floor(Date.now() / interval) * interval;
const now = boundary + 1000;
function row(index, price, volume, tolerance = 0.25) {
  const open = boundary + (index - 209) * interval;
  return [open, String(price), String(price + tolerance), String(price - tolerance), String(price),
    String(volume), open + interval - 1];
}
function marketSnapshot(price) {
  return { exchange: 'BINANCE', market: 'USDⓈ-M FUTURES', source: 'LOCAL_FIXTURE', updatedAt: new Date(now - 200).toISOString(),
    symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL',
      lastPrice: price, priceChangePercent24h: 2, quoteVolume24h: 40_000_000, tradeCount24h: 1500 }] };
}
const highRows = Array.from({ length: 209 }, (_, i) => row(i, 100 + i * 0.025 + Math.sin(i / 2), 50, 0.12));
const breakout = Math.max(...highRows.slice(-13, -1).map(data => Number(data[2]))) + 0.2;
highRows.at(-1).splice(1, 5, String(breakout - 0.2), String(breakout + 0.04), String(breakout - 0.24), String(breakout), '180');
const high = load('lib/high-risk-scalping.ts', {
  './db': db, './scanner-coins': { getEnabledScannerSymbols: async () => ['BTCUSDT'] },
  './signal-lifecycle': lifecycle, './notifications': appNotifications,
  './high-risk-scalping-types': load('lib/high-risk-scalping-types.ts'),
  './high-risk-scalping-status': load('lib/high-risk-scalping-status.ts'),
  '../smartexit/apps/api/src/services/market-scanner': engine,
  '../smartexit/apps/api/src/services/binance-futures-markets': {
    BinanceFuturesMarketsService: class { async list() { return marketSnapshot(breakout); } },
  },
  'web-push': { sendNotification: forbidden, setVapidDetails: forbidden },
});
async function verifyPilotRole() {
  const connection = await client.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SET LOCAL ROLE smartexit_scanner_pilot');
    const scope = (await connection.query(`SELECT
      has_table_privilege('public.users', 'SELECT') AS customer,
      has_table_privilege('public.binance_api_credentials', 'SELECT') AS credentials,
      has_table_privilege('public.trade_executions', 'INSERT') AS trading,
      has_table_privilege('public.signal_events', 'DELETE') AS deletes,
      has_table_privilege('public.signal_events', 'UPDATE') AS edits`)).rows[0];
    assert.deepEqual(scope, { customer: false, credentials: false, trading: false, deletes: false, edits: false });
    assert.equal((await connection.query('SELECT stopped FROM public.scanner_pilot_control WHERE singleton')).rows[0].stopped, true);
    await connection.query('SAVEPOINT kill_switch_write');
    await assert.rejects(connection.query('UPDATE public.scanner_pilot_control SET stopped = false'), error => error.code === '42501');
    await connection.query('ROLLBACK TO SAVEPOINT kill_switch_write');
    const settings = await appNotifications.getNotificationSystemSettings(connection.query.bind(connection));
    const highSettings = await high.getHighRiskScalpingSettings(connection.query.bind(connection));
    const standardRows = Array.from({ length: 209 }, (_, i) => row(i, 100 + i / 5, i === 208 ? 150 : 50));
    const standard = new engine.BinanceMarketScannerService({ list: async () => marketSnapshot(142) },
      async () => Response.json(standardRows), () => now);
    const { candidates } = await standard.scan({ quoteAsset: 'USDT', timeframe: '5m', symbols: ['BTCUSDT'],
      minimumVolume: 10_000_000, limit: 1, atrPeriod: 10, multiplier: 3, maxAgeSeconds: 300, minimumScore: 60 });
    const setup = high.analyzeHighRiskScalpingSetup({ symbol: 'BTCUSDT', timeframe: '5m',
      candles: engine.parseCandles(highRows), price: breakout, btcDirection: 'BULLISH', settings: highSettings, now });
    assert.ok(setup);
    const slot = new Date(boundary).toISOString();
    assert.equal((await connection.query(`INSERT INTO public.scanner_pilot_runs (slot_at, approved_sha, symbols)
      VALUES ($1,$2,$3) ON CONFLICT (slot_at) DO NOTHING`, [slot, 'a'.repeat(40), ['BTCUSDT','ETHUSDT','SOLUSDT']])).rowCount, 1);
    assert.ok(await appNotifications.insertSignal(connection, candidates[0], settings));
    assert.ok(await high.insertHighRiskSignal(connection, setup, highSettings));
    assert.equal(await appNotifications.insertSignal(connection, candidates[0], settings), null);
    assert.equal(await high.insertHighRiskSignal(connection, setup, highSettings), null);
    assert.equal((await connection.query(`UPDATE public.scanner_pilot_runs
      SET state='COMPLETED', finished_at=statement_timestamp(), report='{}' WHERE slot_at=$1`, [slot])).rowCount, 1);
    assert.equal((await connection.query(`UPDATE public.scanner_pilot_runs SET report='{"edited":true}' WHERE slot_at=$1`, [slot])).rowCount, 0);
    await connection.query('SAVEPOINT wrong_timeframe');
    await assert.rejects(connection.query(`INSERT INTO public.scanner_candidate_snapshots
      (symbol,timeframe,exchange,candidate_json,scanned_at) VALUES ('BTCUSDT','15m','BINANCE','{}',now())`), error => error.code === '42501');
    await connection.query('ROLLBACK TO SAVEPOINT wrong_timeframe');
    assert.equal(outbound, 0);
  } finally {
    try { await connection.query('ROLLBACK'); } finally { connection.release(); }
  }
  assert.equal(await count('SELECT count(*) AS n FROM public.market_signals'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM public.scanner_pilot_runs'), 0);
  console.log('PASS restricted pilot role: both strategy writers, replay, audit terminality, 5m containment and no customer, credential or trading access');
}

async function verifyWriterRecovery() {
  const identity = (await query('SELECT current_database() AS db, current_user AS role, inet_server_addr() AS host')).rows[0];
  assert.deepEqual(identity, { db: 'scanner_fixture', role: 'scanner_fixture', host: '127.0.0.1' });
  assert.equal(await count('SELECT count(*) AS n FROM public.market_signals'), 0);
  const standardRows = Array.from({ length: 209 }, (_, i) => row(i, 100 + i / 5, i === 208 ? 150 : 50));
  const standardScanner = new engine.BinanceMarketScannerService({ list: async () => marketSnapshot(142) },
    async () => Response.json(standardRows), () => now);
  const { candidates } = await standardScanner.scan({ quoteAsset: 'USDT', timeframe: '5m', symbols: ['BTCUSDT'],
    minimumVolume: 10_000_000, limit: 1, atrPeriod: 10, multiplier: 3, maxAgeSeconds: 300, minimumScore: 60 });
  assert.equal(candidates[0].status, 'READY');
  const settings = appNotifications.defaultNotificationSystemSettings();
  const persist = () => appNotifications.persistSignalScan(candidates, settings, { dispatchNotifications: false });
  const scanHigh = () => high.runHighRiskScalpingScan(async () => Response.json(highRows), now, { deliverNotifications: false });
  await query(`UPDATE public.high_risk_scalping_settings SET enabled = TRUE, enabled_timeframes = '["5m"]'::jsonb`);
  await query(`CREATE FUNCTION public.scanner_fixture_reject_event() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'Injected scanner event persistence failure'; END; $$;
    CREATE TRIGGER scanner_fixture_reject_event BEFORE INSERT ON public.signal_events
    FOR EACH ROW EXECUTE FUNCTION public.scanner_fixture_reject_event();`);
  await assert.rejects(persist(), /Injected scanner event/);
  assert.equal((await scanHigh()).failed, 1);
  assert.equal(await count('SELECT count(*) AS n FROM public.market_signals'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM public.high_risk_scalping_signals'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM public.signal_persistence_failures'), 2);
  await query('DROP TRIGGER scanner_fixture_reject_event ON public.signal_events');
  assert.equal((await persist()).created, 1);
  assert.equal((await scanHigh()).created, 1);
  assert.equal((await persist()).created, 0);
  assert.equal((await scanHigh()).created, 0);
  const filters = { page: 1, pageSize: 10 };
  const standardResult = await history.listSignalHistory({ ...filters, scannerType: 'STANDARD' });
  const highResult = await history.listSignalHistory({ ...filters, scannerType: 'HIGH_RISK' });
  assert.equal(standardResult.total, 1);
  assert.equal(highResult.total, 1);
  const id = highResult.items[0].id;
  assert.equal(await count(`SELECT count(*) AS n FROM public.market_signals
    WHERE id = $1 AND legacy_scalping_signal_id IS NOT NULL AND last_candle_close_at IS NOT NULL`, [id]), 1);
  assert.equal(await count('SELECT count(DISTINCT idempotency_key) AS n FROM public.signal_events'), 5);
  assert.equal(await count('SELECT count(*) AS n FROM public.signal_events'), 5);
  const users = (await query(`INSERT INTO public.users(email,password_hash)
    VALUES ('fixture-a@example.test','synthetic'), ('fixture-b@example.test','synthetic') RETURNING id`)).rows;
  await query('INSERT INTO public.signal_user_entries(user_id,signal_id) VALUES($1,$2)', [users[0].id, id]);
  assert.ok((await history.getSignalHistoryDetail(id, users[0].id)).userEntry);
  assert.equal((await history.getSignalHistoryDetail(id, users[1].id)).userEntry, null);
  assert.equal(await count('SELECT count(*) AS n FROM public.user_signal_notifications'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM public.trade_executions'), 0);
  assert.equal(outbound, 0);
  console.log('PASS Standard and High-Risk: rollback, failure audit, retry, replay, five idempotent events, History isolation, no outbound calls');
}

try {
  const identity = (await query('SELECT current_database() AS db, current_user AS role, inet_server_addr() AS host')).rows[0];
  assert.deepEqual(identity, { db: 'scanner_fixture', role: 'scanner_fixture', host: '127.0.0.1' });
  if (roleOnly) await verifyPilotRole();
  else await verifyWriterRecovery();
} finally {
  await client.end();
}
