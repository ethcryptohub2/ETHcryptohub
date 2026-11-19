// Offline evidence evaluator only: no service, network, notifications or database.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import watchlist from '../deploy/market-worker/soak-watchlist.json' with { type: 'json' };

const percentile = (values, p) => values.length ? [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1] : null;
export function evaluateMarketSoak(records) {
  if (!Array.isArray(records) || records.length < 2 || records.length > 10_000) throw Error('INVALID_EVIDENCE_COUNT');
  const abort = new Set(), missing = new Set(), cpu = [], ram = [], queue = [], lag = [], network = [], tickerFractions = [];
  let previous, steady = 0, ready = 0, unavailableSince = null;
  const start = records[0]?.at;
  for (const row of records) {
    if (!Number.isSafeInteger(row?.at) || row.at <= 0 || (previous && row.at <= previous.at)) throw Error('EVIDENCE_TIME_NOT_MONOTONIC');
    const h = row.health, r = row.resources;
    if (!h || h.version !== 1 || typeof h.runId !== 'number' || !Number.isSafeInteger(h.runId) || h.runId < 1) throw Error('MISSING_HEALTH_VERSION_OR_RUN_ID');
    if (previous && h.runId !== previous.health.runId) abort.add('PROCESS_RESTART_REQUIRES_REVIEW');
    if (previous && row.at - previous.at > 45_000) abort.add('MONITORING_GAP');
    if (previous && (row.at-previous.at < 10_000 || row.at-previous.at > 20_000)) missing.add('REGULAR_15S_SAMPLING');
    if (row.at-start >= 120_000) {
      steady++;
      const ticker = h.tickerCoverage;
      if (!ticker || !['total','fresh','stale','unseen'].every(key=>Number.isSafeInteger(ticker[key]) && ticker[key]>=0) || ticker.total < 20 || ticker.fresh+ticker.stale+ticker.unseen !== ticker.total) missing.add('UNIVERSE_TICKER_COVERAGE');
      else tickerFractions.push(ticker.fresh/ticker.total);
      if (!Number.isSafeInteger(h.at) || h.at > row.at || row.at-h.at > 45_000) abort.add('HEARTBEAT_STALE');
      if (h.running !== true || h.sinkHealthy !== true) abort.add('WORKER_OR_JOURNAL_UNHEALTHY');
      if (h.researchCoverage?.selected !== 20 || !Array.isArray(h.symbols) || h.symbols.length !== 20 || new Set(h.symbols.map(s=>s.symbol)).size !== 20 || h.symbols.some(s=>!watchlist.symbols.includes(s.symbol))) abort.add('SELECTED_COVERAGE_MISMATCH');
      if (!Number.isSafeInteger(h.queueDropped) || h.queueDropped < 0) missing.add('QUEUE_DROPS');
      if (previous && Number.isSafeInteger(h.queueDropped) && h.runId === previous.health.runId) {
        if (h.queueDropped < previous.health.queueDropped) abort.add('COUNTER_REGRESSION');
        if (h.queueDropped > previous.health.queueDropped) abort.add('QUEUE_DROP');
      }
      if (!Number.isFinite(h.queueOldestAgeMs) || h.queueOldestAgeMs < 0) missing.add('QUEUE_AGE');
      else { queue.push(h.queueOldestAgeMs); if (h.queueOldestAgeMs > 1000) abort.add('QUEUE_TOO_OLD'); }
      const heartbeatAge = row.at-h.at;
      const fresh = Number.isSafeInteger(heartbeatAge) && heartbeatAge >= 0 && Array.isArray(h.connections) && h.connections.length === 3 && h.connections.every(c=>c.connected === true) && h.researchCoverage?.fresh === 20 && h.symbols?.every(s=>s.status === 'FRESH' && s.sequenceValid === true && Number.isFinite(s.lagMs) && s.lagMs >= 0 && s.lagMs+heartbeatAge <= 5000);
      if (fresh) { ready++; unavailableSince = null; lag.push(Math.max(...h.symbols.map(s=>s.lagMs+heartbeatAge))); }
      else { unavailableSince ??= row.at; if (row.at-unavailableSince >= 60_000) abort.add('SELECTED_FEED_UNAVAILABLE_60S'); }
      for (const [key, values] of [['cpuPct',cpu],['rssMiB',ram],['networkMbps',network]]) {
        if (!Number.isFinite(r?.[key]) || r[key] < 0) missing.add(key); else values.push(r[key]);
      }
      if (Number.isFinite(r?.rssMiB) && r.rssMiB > 600) abort.add('RSS_OVER_600_MIB');
      if (!Number.isFinite(r?.diskFreeGiB)) missing.add('diskFreeGiB');
      else if (r.diskFreeGiB < 2) abort.add('DISK_HEADROOM_UNDER_2_GIB');
      if (!Number.isSafeInteger(h.failures?.disconnects) || h.failures.disconnects < 0) missing.add('RECONNECT_COUNT');
      if (previous && h.runId === previous.health.runId && h.failures?.disconnects < previous.health.failures?.disconnects) abort.add('RECONNECT_COUNTER_REGRESSION');
      const hourAgo = records.find(x=>x.at >= row.at-3_600_000);
      if (hourAgo && Number.isSafeInteger(h.failures?.disconnects) && h.runId === hourAgo.health.runId && h.failures.disconnects-hourAgo.health.failures?.disconnects > 6) abort.add('RECONNECTS_OVER_6_PER_HOUR');
    }
    previous = row;
  }
  const spanMs = records.at(-1).at-start;
  const readiness = steady ? ready/steady : null;
  const metrics = { spanMs, samples: records.length, steadySamples: steady, readyFraction: readiness,
    cpuP95: percentile(cpu,.95), rssMaxMiB: ram.length?Math.max(...ram):null,
    queueP95Ms: percentile(queue,.95), requiredInputLagP95Ms: percentile(lag,.95), networkP95Mbps: percentile(network,.95),
    universeTickerMinimumFreshFraction: tickerFractions.length?Math.min(...tickerFractions):null };
  if (steady && readiness < .95) abort.add('READY_COVERAGE_UNDER_95_PERCENT');
  if (metrics.cpuP95 > 70) abort.add('CPU_P95_OVER_70_PERCENT');
  if (metrics.queueP95Ms > 250) abort.add('QUEUE_P95_OVER_250_MS');
  if (metrics.requiredInputLagP95Ms > 2000) abort.add('INPUT_LAG_P95_OVER_2S');
  if (metrics.networkP95Mbps > 10) abort.add('NETWORK_P95_OVER_10_MBPS');
  const complete = spanMs >= 86_400_000 && steady > 0 && missing.size === 0;
  return { status: abort.size ? 'ABORT' : complete ? 'PASS' : 'INCOMPLETE', metrics, abortReasons:[...abort], missingMetrics:[...missing],
    scope:'Offline submitted evidence only; no reliability certification or automatic activation.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const file=process.argv[2]; if (!file || !file.endsWith('.ndjson')) throw Error('EXPECTED_LOCAL_NDJSON');
    const stat=await fs.stat(file); if (stat.size > 32*1024*1024) throw Error('EVIDENCE_TOO_LARGE');
    const rows=(await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const report=evaluateMarketSoak(rows); console.log(JSON.stringify(report,null,2)); process.exitCode=report.status==='PASS'?0:1;
  } catch { console.error('Invalid or unreadable local soak evidence. No remote action taken.'); process.exitCode=1; }
}
