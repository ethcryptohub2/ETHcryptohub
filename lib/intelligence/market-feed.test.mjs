import assert from 'node:assert/strict';
import test from 'node:test';
import { BinanceMarketFeed, BoundedMarketQueue, discoverEligibleSymbols } from './market-feed.ts';
const at=1_000_000;
const ticker=(E=at)=>({e:'24hrTicker',E,s:'BTCUSDT',c:'100',q:'90000000',st:1});
const trade=(a,E=at,m=false)=>({e:'aggTrade',E,s:'BTCUSDT',a,p:'100',q:'2',m,st:1});
const depth=(U=9,u=11,pu=8,E=at)=>({e:'depthUpdate',E,s:'BTCUSDT',U,u,pu,b:[['99','2']],a:[['101','3']],st:1});
const snapshot={lastUpdateId:10,bids:[['99','1']],asks:[['101','1']]};
function warmed(){const f=new BinanceMarketFeed(['BTCUSDT']);f.ingest(ticker(),at);f.ingest(trade(1),at);f.ingest(trade(2,at,true),at);f.ingest(depth(),at);assert.equal(f.installSnapshot('BTCUSDT',snapshot,at),true);return f;}

test('discovery admits active USDT/USDC-margined perpetuals, including official Unicode names',()=>{
  const base={status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT'};
  assert.deepEqual(discoverEligibleSymbols({symbols:[{...base,symbol:'BTCUSDT'},{...base,symbol:'币USDT'},{...base,symbol:'OLDUSDT',status:'SETTLING'},{...base,symbol:'BTCUSD',marginAsset:'BTC'},{...base,symbol:'BTCUSDT'}]}),['BTCUSDT','币USDT']);
  assert.throws(()=>discoverEligibleSymbols({symbols:[]}),/UNSUPPORTED/);
  assert.deepEqual(discoverEligibleSymbols({symbols:[{...base,symbol:'BTCUSDC',quoteAsset:'USDC',marginAsset:'USDC'},{...base,symbol:'BTCUSD',quoteAsset:'USD',marginAsset:'BTC'}]}),['BTCUSDC']);
  assert.deepEqual(discoverEligibleSymbols({symbols:[{...base,symbol:'BTCUSDT_261225',contractType:'CURRENT_QUARTER'}]},{quoteAssets:['USDT'],contractTypes:['CURRENT_QUARTER']}),['BTCUSDT_261225']);
  assert.throws(()=>discoverEligibleSymbols({symbols:[]},{quoteAssets:['BTC'],contractTypes:['PERPETUAL']}),/INVALID_ELIGIBILITY/);
});
test('buffered depth bridges snapshot, then publishes disjoint trade notional rather than ticker24hvolume',()=>{
  const f=warmed();const o=f.takeObservation('BTCUSDT',at);
  assert.equal(o.quoteVolume,400);assert.equal(o.buyQuoteVolume,200);assert.equal(o.sellQuoteVolume,200);
  assert.equal(o.price,100);assert.equal(o.bid,99);assert.equal(o.ask,101);assert.equal(o.bidDepth,198);
  assert.equal(f.takeObservation('BTCUSDT',at),null);
  f.ingest(ticker(at+1),at+1);assert.equal(f.takeObservation('BTCUSDT',at+1),null);
  f.ingest(trade(3,at+2),at+2);assert.equal(f.takeObservation('BTCUSDT',at+2).quoteVolume,200);
});
test('depth continuity gap fails closed, clears pending samples and requires a new snapshot bridge',()=>{
  const f=warmed();f.takeObservation('BTCUSDT',at);f.ingest(trade(3,at+1),at+1);
  f.ingest(depth(12,13,7,at+2),at+2);
  assert.equal(f.takeObservation('BTCUSDT',at+2),null);assert.equal(f.needsSnapshot('BTCUSDT'),true);
  f.ingest(depth(12,14,11,at+3),at+3);assert.equal(f.installSnapshot('BTCUSDT',{...snapshot,lastUpdateId:13},at+3),true);
  assert.equal(f.takeObservation('BTCUSDT',at+3),null);
  f.ingest(trade(4,at+4),at+4);assert.equal(f.takeObservation('BTCUSDT',at+4).quoteVolume,200);
});
test('trade gaps and duplicate events never double count or create readiness',()=>{
  const f=warmed();f.takeObservation('BTCUSDT',at);f.ingest(trade(2),at);assert.equal(f.takeObservation('BTCUSDT',at),null);
  f.ingest(trade(4,at+1),at+1);assert.equal(f.takeObservation('BTCUSDT',at+1),null);assert.equal(f.health('BTCUSDT',at+1).sequenceValid,false);
});
test('stale, future, COIN-M and undiscovered events cannot manufacture fresh observations',()=>{
  const f=warmed();assert.equal(f.takeObservation('BTCUSDT',at+5001),null);
  f.reset('BTCUSDT');f.ingest({...ticker(),E:at+99999},at);f.ingest({...ticker(),st:2},at);f.ingest({...ticker(),s:'NOTDISCOVERED'},at);
  assert.equal(f.health('BTCUSDT',at).status,'UNAVAILABLE');assert.equal(f.metrics().rejected,3);
});
test('disconnect/reset changes epoch and requires complete warmup rather than replaying old freshness',()=>{
  const f=warmed();const before=f.takeObservation('BTCUSDT',at).feedEpoch;
  f.reset('BTCUSDT');assert.equal(f.takeObservation('BTCUSDT',at),null);
  f.ingest(ticker(at+1),at+1);f.ingest(trade(10,at+1),at+1);f.ingest(trade(11,at+1),at+1);f.ingest(depth(9,11,8,at+1),at+1);f.installSnapshot('BTCUSDT',snapshot,at+1);
  assert.ok(f.takeObservation('BTCUSDT',at+1).feedEpoch>before);
});
test('unpublished old notional never becomes a fresh volume spike after a quiet/recovery gap',()=>{
  const f=warmed(); // intentionally do not consume the first400quote-notional sample
  const next=at+6000;
  f.ingest(ticker(next),next);f.ingest(trade(3,next),next);f.ingest(depth(12,12,11,next),next);
  assert.equal(f.takeObservation('BTCUSDT',next),null); // new window needs two trades
  f.ingest(trade(4,next+1),next+1);
  const observation=f.takeObservation('BTCUSDT',next+1);
  assert.equal(observation.quoteVolume,400); // only trades3/4, never old1/2
  assert.ok(observation.feedEpoch>0);
});

test('trade sample duration reflects the actual publication interval without a fabricated cadence',()=>{
  const f=warmed();assert.equal(f.takeObservation('BTCUSDT',at).volumeIntervalMs,undefined);
  f.ingest(trade(3,at+2000),at+2000);
  assert.equal(f.takeObservation('BTCUSDT',at+2000).volumeIntervalMs,2000);
  f.ingest(trade(4,at+2100),at+2100);
  assert.equal(f.takeObservation('BTCUSDT',at+2100).volumeIntervalMs,100);
});

test('optional funding with a future timestamp is not published as current context',()=>{
  const f=warmed();f.ingest({e:'markPriceUpdate',E:at+1000,s:'BTCUSDT',r:'0.001'},at);
  assert.equal(f.takeObservation('BTCUSDT',at).fundingRate,undefined);
  f.ingest(trade(3,at+1000),at+1000);
  assert.equal(f.takeObservation('BTCUSDT',at+1000).fundingRate,0.001);
});
test('bounded depth buffer and bounded frame byte queue reject overload explicitly',()=>{
  const f=new BinanceMarketFeed(['BTCUSDT'],5000,1000,1);f.ingest(depth(),at);f.ingest(depth(12,13,11),at);assert.equal(f.metrics().bufferOverflows,1);assert.equal(f.takeObservation('BTCUSDT',at),null);
  const q=new BoundedMarketQueue(2,10);assert.equal(q.enqueue({payload:1,receivedAt:at,bytes:6}),true);assert.equal(q.enqueue({payload:2,receivedAt:at,bytes:5}),false);assert.equal(q.dropped,1);assert.equal(q.drain().length,1);assert.equal(q.size,0);
});
test('absolute depth deletion and crossed books fail closed without invented liquidity',()=>{
  const f=warmed();f.takeObservation('BTCUSDT',at);f.ingest(depth(12,12,11,at+1),at+1);
  f.ingest({...depth(13,13,12,at+2),b:[['99','0']]},at+2);assert.equal(f.takeObservation('BTCUSDT',at+2),null);
});
