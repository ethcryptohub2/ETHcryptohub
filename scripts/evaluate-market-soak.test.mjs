import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMarketSoak } from './evaluate-market-soak.mjs';
import watchlist from '../deploy/market-worker/soak-watchlist.json' with { type: 'json' };
const start=1_800_000_000_000;
function evidence(hours=24) {
  return Array.from({length:hours*240+1},(_,i)=>({at:start+i*15000,
    health:{version:1,at:start+i*15000,runId:1,running:true,sinkHealthy:true,queueDropped:0,queueOldestAgeMs:20,
      researchCoverage:{selected:20,fresh:20},connections:Array(3).fill({connected:true}),failures:{disconnects:0},
      tickerCoverage:{total:522,fresh:500,stale:22,unseen:0},
      symbols:watchlist.symbols.map(symbol=>({symbol,status:'FRESH',sequenceValid:true,lagMs:500}))},
    resources:{cpuPct:20,rssMiB:200,networkMbps:1,diskFreeGiB:10}}));
}
test('complete synthetic evidence passes; short or absent resource evidence cannot establish a soak',()=>{
  assert.equal(evaluateMarketSoak(evidence()).status,'PASS');
  assert.equal(evaluateMarketSoak(evidence(1)).status,'INCOMPLETE');
  const rows=evidence(); delete rows[100].resources;
  assert.equal(evaluateMarketSoak(rows).status,'INCOMPLETE');
});
test('old heartbeat lag cannot masquerade as current freshness; reconnect counter resets are visible',()=>{
  const rows=evidence(); for(const row of rows)row.health.at-=30_000;
  assert.equal(evaluateMarketSoak(rows).status,'ABORT');
  const reset=evidence();reset[100].health.failures.disconnects=1;
  assert.ok(evaluateMarketSoak(reset).abortReasons.includes('RECONNECT_COUNTER_REGRESSION'));
  const other=evidence();other[100].health.symbols[0].symbol='UNAPPROVEDUSDT';
  assert.ok(evaluateMarketSoak(other).abortReasons.includes('SELECTED_COVERAGE_MISMATCH'));
});
test('drops, stale inputs, process restarts and gaps trigger abort recommendations without actions',()=>{
  for (const mutate of [
    rows=>{rows[100].health.queueDropped=1;},
    rows=>{for(const row of rows.slice(100,110))row.health.researchCoverage.fresh=19;},
    rows=>{rows[100].health.runId=2;},
    rows=>{rows.splice(100,5);},
    rows=>{rows[100].resources.rssMiB=601;},
    rows=>{rows[100].health.queueOldestAgeMs=1001;},
  ]) { const rows=evidence();mutate(rows);assert.equal(evaluateMarketSoak(rows).status,'ABORT'); }
});
test('coverage forgery, resource pressure, malformed times and repeated reconnects fail closed',()=>{
  const rows=evidence(); for(const row of rows)row.resources.cpuPct=90;
  assert.ok(evaluateMarketSoak(rows).abortReasons.includes('CPU_P95_OVER_70_PERCENT'));
  rows[200].health.failures.disconnects=7;
  assert.ok(evaluateMarketSoak(rows).abortReasons.includes('RECONNECTS_OVER_6_PER_HOUR'));
  rows[200].health.symbols=Array(20).fill(rows[200].health.symbols[0]);
  assert.ok(evaluateMarketSoak(rows).abortReasons.includes('SELECTED_COVERAGE_MISMATCH'));
  rows[1].at=rows[0].at;assert.throws(()=>evaluateMarketSoak(rows),/MONOTONIC/);
});
