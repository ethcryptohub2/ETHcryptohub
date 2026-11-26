import dns from 'node:dns/promises';
import http from 'node:http';
import tls from 'node:tls';
import process from 'node:process';
import pg from 'pg';

const { Pool } = pg;

const PORT = Number(process.env.PORT || 3000);
const STARTED_AT = new Date().toISOString();
const STARTED_MS = Date.now();

const REST_ENDPOINTS = [
  { name: 'ping', url: 'https://fapi.binance.com/fapi/v1/ping' },
  { name: 'time', url: 'https://fapi.binance.com/fapi/v1/time' },
  { name: 'exchangeInfo', url: 'https://fapi.binance.com/fapi/v1/exchangeInfo' },
  { name: 'ticker24hr', url: 'https://fapi.binance.com/fapi/v1/ticker/24hr' },
  { name: 'klines1m', url: 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=10' },
];

const DEMO_PUBLIC_ENDPOINTS = [
  { name: 'demoPing', url: 'https://demo-fapi.binance.com/fapi/v1/ping' },
  { name: 'demoTime', url: 'https://demo-fapi.binance.com/fapi/v1/time' },
  { name: 'demoTicker', url: 'https://demo-fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT' },
];

function sanitizeText(raw) {
  return String(raw ?? '')
    .replace(/(Bearer\s+|apikey=|token=|password=|secret=)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

async function checkDnsAndTls(hostname) {
  const result = { hostname, addresses: [], dnsError: null, tlsProtocol: null, tlsAuthorized: null, tlsError: null };
  try {
    const records = await dns.lookup(hostname, { all: true });
    result.addresses = records.slice(0, 6).map((r) => `${r.address} (v${r.family})`);
  } catch (err) {
    result.dnsError = err instanceof Error ? err.message : String(err);
  }
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const sock = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 8000 }, () => {
        result.tlsProtocol = sock.getProtocol();
        result.tlsAuthorized = sock.authorized;
        sock.end();
        done();
      });
      sock.on('error', (err) => {
        result.tlsError = err.message;
        done();
      });
      sock.setTimeout(8000, () => {
        result.tlsError = 'TLS handshake timeout';
        sock.destroy();
        done();
      });
    } catch (err) {
      result.tlsError = err instanceof Error ? err.message : String(err);
      done();
    }
  });
  return result;
}

async function probeHttpEndpoint(name, url) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json' },
    });
    const latencyMs = Date.now() - start;
    const headers = {};
    for (const h of ['x-mbx-used-weight-1m', 'x-mbx-order-count-1m', 'retry-after', 'content-type', 'server']) {
      const val = res.headers.get(h);
      if (val !== null) headers[h] = val;
    }
    const text = await res.text();
    const out = {
      name,
      url,
      status: res.status,
      ok: res.ok,
      latencyMs,
      headers,
      bodyBytes: text.length,
    };
    if (!res.ok) {
      out.errorBody = sanitizeText(text);
    } else if (name === 'exchangeInfo') {
      try {
        const json = JSON.parse(text);
        const symbols = Array.isArray(json?.symbols) ? json.symbols : [];
        const usdtPerps = symbols.filter(
          (s) => s?.contractType === 'PERPETUAL' && s?.quoteAsset === 'USDT' && s?.status === 'TRADING',
        );
        out.totalSymbols = symbols.length;
        out.activeUsdtPerpCount = usdtPerps.length;
      } catch {
        out.parseError = 'Invalid exchangeInfo JSON';
      }
    } else if (name === 'ticker24hr') {
      try {
        const json = JSON.parse(text);
        out.tickerCount = Array.isArray(json) ? json.length : 0;
      } catch {
        out.parseError = 'Invalid ticker24hr JSON';
      }
    } else if (name === 'klines1m') {
      try {
        const json = JSON.parse(text);
        const last = Array.isArray(json) ? json.at(-1) : null;
        out.candleCount = Array.isArray(json) ? json.length : 0;
        if (Array.isArray(last)) {
          out.latestOpenTime = new Date(Number(last[0])).toISOString();
          out.latestCloseTime = new Date(Number(last[6])).toISOString();
          out.latestClose = Number(last[4]);
        }
      } catch {
        out.parseError = 'Invalid klines JSON';
      }
    } else if (name === 'time' || name === 'demoTime') {
      try {
        const json = JSON.parse(text);
        if (json?.serverTime) {
          out.serverTimeIso = new Date(Number(json.serverTime)).toISOString();
          out.clockSkewMs = Date.now() - Number(json.serverTime);
        }
      } catch {
        out.parseError = 'Invalid time JSON';
      }
    } else if (name === 'demoTicker') {
      out.sample = sanitizeText(text);
    }
    return out;
  } catch (err) {
    return {
      name,
      url,
      status: null,
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeSupabaseStaging() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || null;
  const expectedRef = process.env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF?.trim() || 'ghecpkpaxbrvehquhzkr';
  const actualRef = url ? (/^https:\/\/([a-z0-9-]+)\.supabase\.co/i.exec(url)?.[1] ?? null) : null;

  const restCheck = await (async () => {
    if (!url) return { configured: false, ok: false, error: 'NEXT_PUBLIC_SUPABASE_URL not set' };
    const start = Date.now();
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
        headers: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
          ? { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY }
          : {},
        signal: AbortSignal.timeout(10_000),
      });
      return { configured: true, status: res.status, ok: res.status < 500, latencyMs: Date.now() - start };
    } catch (err) {
      return { configured: true, ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
    }
  })();

  const dbCheck = await (async () => {
    const dbHost = process.env.SUPABASE_DB_HOST?.trim();
    const dbPort = Number(process.env.SUPABASE_DB_PORT || 6543);
    const dbName = process.env.SUPABASE_DB_NAME?.trim() || 'postgres';
    const dbUser = process.env.SUPABASE_DB_USER?.trim();
    const dbPassword = process.env.SUPABASE_DB_PASSWORD?.trim();
    const dbUrl = process.env.SUPABASE_DB_URL?.trim() || process.env.DATABASE_URL?.trim();

    if (!dbUrl && (!dbHost || !dbUser || !dbPassword)) {
      return { configured: false, ok: false, note: 'Staging Postgres credentials not set in probe environment yet' };
    }

    const start = Date.now();
    const pool = new Pool(
      dbUrl
        ? { connectionString: dbUrl, ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 8000 }
        : {
            host: dbHost,
            port: dbPort,
            database: dbName,
            user: dbUser,
            password: dbPassword,
            ssl: process.env.SUPABASE_DB_CA_CERT
              ? { ca: process.env.SUPABASE_DB_CA_CERT, rejectUnauthorized: true }
              : { rejectUnauthorized: false },
            max: 1,
            connectionTimeoutMillis: 8000,
          },
    );
    try {
      const r = await pool.query('SELECT current_database() AS db, NOW() AS server_now');
      const mig = await pool.query('SELECT count(*)::int AS applied_migrations FROM supabase_migrations.schema_migrations').catch(() => ({ rows: [{ applied_migrations: null }] }));
      const usr = await pool.query('SELECT count(*)::int AS users_count FROM public.users').catch(() => ({ rows: [{ users_count: null }] }));
      return {
        configured: true,
        ok: true,
        latencyMs: Date.now() - start,
        database: r.rows[0]?.db ?? null,
        serverNow: r.rows[0]?.server_now ?? null,
        appliedMigrations: mig.rows[0]?.applied_migrations ?? null,
        usersCount: usr.rows[0]?.users_count ?? null,
      };
    } catch (err) {
      return { configured: true, ok: false, latencyMs: Date.now() - start, error: sanitizeText(err instanceof Error ? err.message : String(err)) };
    } finally {
      await pool.end().catch(() => {});
    }
  })();

  return {
    expectedStagingRef: expectedRef,
    actualPublicUrlRef: actualRef,
    isolatedToStaging: actualRef === expectedRef,
    restCheck,
    dbCheck,
  };
}

const wsState = {
  url: 'wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m',
  state: 'INIT',
  connectAttempts: 0,
  openCount: 0,
  reconnectCount: 0,
  closeCount: 0,
  errorCount: 0,
  messageCount: 0,
  closedKlineCount: 0,
  connectedAt: null,
  lastMessageAt: null,
  lastEventTimeMs: null,
  lastFreshnessLagMs: null,
  lastCloseCode: null,
  lastCloseReason: null,
  lastError: null,
  sampleLatestEvent: null,
};

let wsSocket = null;
let reconnectTimer = null;
let pingTimer = null;

function connectBinanceWs() {
  if (typeof WebSocket === 'undefined') {
    wsState.state = 'WS_UNAVAILABLE';
    wsState.lastError = 'Global WebSocket not supported in this Node runtime';
    return;
  }
  wsState.connectAttempts += 1;
  wsState.state = wsState.connectAttempts === 1 ? 'CONNECTING' : 'RECONNECTING';
  const ws = new WebSocket(wsState.url);
  wsSocket = ws;

  ws.onopen = () => {
    wsState.state = 'OPEN';
    wsState.openCount += 1;
    wsState.connectedAt = new Date().toISOString();
    wsState.lastError = null;
  };

  ws.onmessage = (evt) => {
    const now = Date.now();
    wsState.lastMessageAt = new Date(now).toISOString();
    wsState.messageCount += 1;
    try {
      const payload = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data));
      const data = payload?.data ?? payload;
      const eventMs = Number(data?.E);
      if (Number.isFinite(eventMs)) {
        wsState.lastEventTimeMs = eventMs;
        wsState.lastFreshnessLagMs = now - eventMs;
      }
      if (data?.k?.x === true) {
        wsState.closedKlineCount += 1;
      }
      wsState.sampleLatestEvent = {
        stream: payload?.stream ?? null,
        symbol: data?.s ?? null,
        interval: data?.k?.i ?? null,
        close: data?.k?.c ?? null,
        isClosed: Boolean(data?.k?.x),
        eventTimeIso: Number.isFinite(eventMs) ? new Date(eventMs).toISOString() : null,
      };
    } catch {
      // ignore non-json
    }
  };

  ws.onerror = () => {
    wsState.errorCount += 1;
    wsState.lastError = 'WebSocket error event received';
  };

  ws.onclose = (evt) => {
    wsState.state = 'CLOSED';
    wsState.closeCount += 1;
    wsState.lastCloseCode = evt.code ?? null;
    wsState.lastCloseReason = sanitizeText(evt.reason ?? '');
    if (!reconnectTimer) {
      wsState.reconnectCount += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectBinanceWs();
      }, 5000);
    }
  };
}

let latestRestReport = null;

async function runFullProbe() {
  const [fapiNetwork, demoNetwork, wsNetwork, supabase, restResults, demoResults] = await Promise.all([
    checkDnsAndTls('fapi.binance.com'),
    checkDnsAndTls('demo-fapi.binance.com'),
    checkDnsAndTls('fstream.binance.com'),
    probeSupabaseStaging(),
    Promise.all(REST_ENDPOINTS.map((e) => probeHttpEndpoint(e.name, e.url))),
    Promise.all(DEMO_PUBLIC_ENDPOINTS.map((e) => probeHttpEndpoint(e.name, e.url))),
  ]);

  latestRestReport = {
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - STARTED_MS) / 1000),
    network: { fapiNetwork, demoNetwork, wsNetwork },
    binanceRest: restResults,
    binanceDemo: demoResults,
    supabaseStaging: supabase,
  };
  return latestRestReport;
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (reqUrl.pathname === '/health' || reqUrl.pathname === '/ready') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'northflank-connectivity-probe', startedAt: STARTED_AT, wsState: wsState.state }));
    return;
  }

  if (reqUrl.pathname === '/probe' || reqUrl.pathname === '/status' || reqUrl.pathname === '/') {
    if (reqUrl.searchParams.get('reconnect_ws') === '1' && wsSocket) {
      try {
        wsSocket.close(1000, 'Probe reconnect check');
      } catch {}
    }
    const forceRefresh = reqUrl.searchParams.get('refresh') === '1';
    const report = (!latestRestReport || forceRefresh) ? await runFullProbe() : latestRestReport;
    const mem = process.memoryUsage();
    const payload = {
      probe: 'northflank-connectivity-probe',
      startedAt: STARTED_AT,
      uptimeSeconds: Math.round((Date.now() - STARTED_MS) / 1000),
      nodeVersion: process.version,
      memoryMb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      report,
      binanceWebSocket: {
        ...wsState,
        wsConnectedDurationSeconds: wsState.connectedAt ? Math.round((Date.now() - Date.parse(wsState.connectedAt)) / 1000) : 0,
      },
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[Probe] Listening on 0.0.0.0:${PORT}`);
  connectBinanceWs();
  await runFullProbe();
  console.log('[Probe] Initial probe complete:', JSON.stringify({
    restStatuses: latestRestReport.binanceRest.map((r) => ({ name: r.name, status: r.status, count: r.activeUsdtPerpCount ?? r.tickerCount ?? r.candleCount })),
    demoStatuses: latestRestReport.binanceDemo.map((r) => ({ name: r.name, status: r.status })),
    supabase: { isolated: latestRestReport.supabaseStaging.isolatedToStaging, restOk: latestRestReport.supabaseStaging.restCheck.ok, dbOk: latestRestReport.supabaseStaging.dbCheck.ok },
    wsState: wsState.state,
  }));
});

// Refresh probe summary every 5 minutes during sustained run
pingTimer = setInterval(() => {
  void runFullProbe().catch(() => {});
}, 300_000);

function shutdown(sig) {
  console.log(`[Probe] Received ${sig}, shutting down cleanly...`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pingTimer) clearInterval(pingTimer);
  try { wsSocket?.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
