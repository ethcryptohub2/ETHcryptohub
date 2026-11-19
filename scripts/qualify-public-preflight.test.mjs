import test from 'node:test';
import assert from 'node:assert/strict';
import watchlist from '../deploy/market-worker/soak-watchlist.json' with {type:'json'};
import {qualifyPublicPreflight} from './qualify-public-preflight.mjs';
const now=1_800_000_000_000;
function evidence(){return {version:1,region:'sgp1',collectedAt:now,exchangeInfoAt:now-300_000,symbols:watchlist.symbols.map(symbol=>({
  symbol,status:'TRADING',quoteAsset:'USDT',marginAsset:'USDT',contractType:'PERPETUAL',tickerAt:now,quoteVolume24h:50_000_000,high:101,low:99,last:100,
  samples:Array.from({length:11},(_,i)=>({at:now-300_000+i*30_000,bid:99.99,ask:100.01,bidDepthQuote:500_000,askDepthQuote:500_000})),
}))};}
test('all twenty supplied fixtures can qualify without granting access or activation',()=>{
  const report=qualifyPublicPreflight(evidence(),now);assert.equal(report.status,'QUALIFIED_FROM_SUPPLIED_EVIDENCE');assert.equal(report.results.length,20);
  assert.equal(report.activationAuthorized,false);assert.equal(report.regionalConnectivity,'NOT_ESTABLISHED');assert.equal(report.legalEligibility,'NOT_ESTABLISHED');
});
test('ineligible or illiquid symbols stop the fixed list rather than silently substituting',()=>{
  for(const mutate of [r=>{r.status='BREAK';},r=>{r.quoteVolume24h=1;},r=>{r.samples.forEach(s=>{s.ask=100.5;});},r=>{r.samples.forEach(s=>{s.bidDepthQuote=1;});},r=>{r.high=100;r.low=100;}]){
    const e=evidence();mutate(e.symbols[0]);const report=qualifyPublicPreflight(e,now);assert.equal(report.status,'STOP_REVIEW_SYMBOL_LIST');assert.equal(report.results[0].qualified,false);
  }
});
test('stale/future, partial, duplicate, malformed and credential-bearing evidence rejects',()=>{
  for(const mutate of [e=>{e.collectedAt=now+1;},e=>{e.collectedAt=now-61_000;},e=>{e.symbols[0]=e.symbols[1];},e=>{e.symbols[0].samples.pop();},
    e=>{e.symbols[0].samples[1].at=e.symbols[0].samples[0].at;},e=>{e.symbols[0].samples[0].ask=NaN;},e=>{e.symbols[0].apiKey='fixture-only';},e=>{e.region='other';}]){
    const e=evidence();mutate(e);assert.throws(()=>qualifyPublicPreflight(e,now));
  }
});
