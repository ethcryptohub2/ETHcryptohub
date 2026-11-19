import assert from 'node:assert/strict';
import test from 'node:test';
import { BinanceMarketFeed, BoundedMarketQueue, discoverEligibleSymbols } from './market-feed.ts';
import { PublicMarketWorker, subscriptionPlan } from './market-worker.ts';
import { activateApprovedWorker } from '../../scripts/market-intelligence-worker.mjs';

function setup({sinkThrows=false,queueCapacity=256,rateLimitSnapshot=false,symbols=['BTCUSDT'],feedFactory,customSink,snapshotResponse,exchangeInfoResponse}={}){
  let now=1_000_000;const sockets=[],timers=[],observations=[],requests=[];
  const deps={now:()=>now,discover:discoverEligibleSymbols,makeFeed:feedFactory??(s=>new BinanceMarketFeed(s)),makeQueue:()=>new BoundedMarketQueue(queueCapacity),
    timer:{set:(fn,delay)=>{const t={fn,delay,cancelled:false};timers.push(t);return t;},clear:t=>{if(t)t.cancelled=true;}},
    connect:url=>{const listeners={};const s={url,addEventListener:(name,fn)=>{listeners[name]=fn;},close:()=>{},emit:(name,data)=>listeners[name]?.({data})};sockets.push(s);return s;},
    fetch:async url=>{requests.push(String(url));if(String(url).includes('exchangeInfo')&&exchangeInfoResponse)return exchangeInfoResponse();if(!String(url).includes('exchangeInfo')&&snapshotResponse)return snapshotResponse();if(rateLimitSnapshot&&!String(url).includes('exchangeInfo'))return new Response('{}',{status:429,headers:{'retry-after':'3'}});return new Response(JSON.stringify(String(url).includes('exchangeInfo')?{symbols:symbols.map(symbol=>({symbol,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT'}))}:{lastUpdateId:10,bids:[['99','1']],asks:[['101','1']]}));},
    sink:async o=>{if(customSink)await customSink(o);else if(sinkThrows)throw Error('Unavailable journal');observations.push(o);}};
  return {worker:new PublicMarketWorker(deps,symbols),sockets,timers,observations,requests,advance:ms=>{now+=ms;},now:()=>now};
}
const emit=(s,event)=>s.emit('message',JSON.stringify(event));
async function start(s){await s.worker.start({activationApproved:true,environment:'local-replay'});for(const socket of s.sockets)socket.emit('open');}
async function ready(s){
  const t=s.now();emit(s.sockets[0],[{e:'24hrTicker',E:t,s:'BTCUSDT',c:'100',q:'50000'}]);
  emit(s.sockets[1],{e:'aggTrade',E:t,s:'BTCUSDT',a:1,p:'100',q:'2',m:false});emit(s.sockets[1],{e:'aggTrade',E:t,s:'BTCUSDT',a:2,p:'100',q:'2',m:true});
  emit(s.sockets[2],{e:'depthUpdate',E:t,s:'BTCUSDT',U:9,u:11,pu:8,b:[['99','2']],a:[['101','3']]});
  s.advance(1000);await s.worker.cycle();
}
test('constructor/import does not start a worker; explicit separate approval is mandatory',async()=>{
  const s=setup();assert.equal(s.requests.length,0);await assert.rejects(s.worker.start({activationApproved:false,environment:'local-replay'}),/APPROVAL/);assert.equal(s.requests.length,0);
  await assert.rejects(activateApprovedWorker({},[]),/activation approval/);assert.equal(s.worker.health().running,false);
});
test('subscription topology uses current split endpoints, bounded shards and no private/user data',()=>{
  const plan=subscriptionPlan(['BTCUSDT']);assert.equal(plan.length,3);assert.match(plan[0].url,/\/market\/stream\?streams=!ticker@arr/);assert.match(plan[1].url,/\/market\/stream\?streams=btcusdt@aggTrade/);assert.match(plan[2].url,/\/public\/stream\?streams=btcusdt@depth@100ms/);assert.ok(plan.every(x=>!x.url.includes('/private')));
  assert.throws(()=>subscriptionPlan(Array(201).fill('BTCUSDT')),/INVALID/);
});
test('replayed exchangeInfo/ticker/trades/depth reach sink only after snapshot synchronization',async()=>{
  const s=setup();await start(s);assert.equal(s.observations.length,0);await ready(s);assert.equal(s.observations.length,1);assert.equal(s.observations[0].quoteVolume,400);assert.equal(s.worker.health().symbols[0].status,'FRESH');s.worker.stop();assert.equal(s.worker.health().running,false);
});
test('disconnect invalidates coverage immediately and schedules bounded exponential recovery',async()=>{
  const s=setup();await start(s);await ready(s);s.sockets[1].emit('close');assert.notEqual(s.worker.health().symbols[0].status,'FRESH');assert.equal(s.worker.health().failures.disconnects,1);assert.ok(s.timers.some(t=>t.delay===1000));s.worker.stop();assert.ok(s.timers.every(t=>t.cancelled));
});
test('sink rejection is visible and invalidates observations instead of claiming durable delivery',async()=>{
  const s=setup({sinkThrows:true});await start(s);await ready(s);assert.equal(s.worker.health().sinkHealthy,false);assert.equal(s.worker.health().failures.sinkFailures,1);assert.notEqual(s.worker.health().symbols[0].status,'FRESH');s.worker.stop();
});
test('queue overload loses continuity and cannot emit a fresh sample',async()=>{
  const s=setup({queueCapacity:1});await start(s);emit(s.sockets[0],[{e:'24hrTicker',E:s.now(),s:'BTCUSDT',c:'100',q:'1000'}]);emit(s.sockets[1],{e:'aggTrade',E:s.now(),s:'BTCUSDT',a:1,p:'100',q:'2',m:false});assert.equal(s.worker.health().failures.backpressure,1);await s.worker.cycle();assert.equal(s.observations.length,0);s.worker.stop();
});
test('malformed messages and hung handshakes trigger reconnect without publishing data',async()=>{
  const s=setup();await s.worker.start({activationApproved:true,environment:'local-replay'});s.advance(16000);await s.worker.cycle();assert.equal(s.worker.health().failures.disconnects,3);s.worker.stop();
  const other=setup();await start(other);other.sockets[0].emit('message','not json');assert.equal(other.worker.health().failures.malformedFrames,1);assert.equal(other.observations.length,0);other.worker.stop();
});
test('provider429 imposes backoff without stale fallback or a REST retry storm',async()=>{
  const s=setup({rateLimitSnapshot:true});await start(s);await ready(s);assert.equal(s.worker.health().failures.restRateLimits,1);assert.equal(s.observations.length,0);
  const attempts=s.requests.length;s.advance(5000);await s.worker.cycle();assert.equal(s.requests.length,attempts);s.worker.stop();
});

test('disconnect discards queued pre-gap frames and rejects callbacks from the old socket generation',async()=>{
  const s=setup();await start(s);
  emit(s.sockets[0],[{e:'24hrTicker',E:s.now(),s:'BTCUSDT',c:'100',q:'50000'}]);
  emit(s.sockets[1],{e:'aggTrade',E:s.now(),s:'BTCUSDT',a:1,p:'100',q:'2',m:false});
  assert.equal(s.worker.health().queueSize,2);
  s.sockets[1].emit('close');assert.equal(s.worker.health().queueSize,0);
  emit(s.sockets[1],{e:'aggTrade',E:s.now(),s:'BTCUSDT',a:2,p:'100',q:'2',m:false});
  assert.equal(s.worker.health().queueSize,0);
  await s.worker.cycle();assert.equal(s.observations.length,0);s.worker.stop();
});

test('a successful different-symbol sink write cannot acknowledge a failed symbol',async()=>{
  const pending=new Map([['BTCUSDT',{symbol:'BTCUSDT'}],['ETHUSDT',{symbol:'ETHUSDT'}]]);
  const failures=new Set(['BTCUSDT']);
  const feed={symbols:['BTCUSDT','ETHUSDT'],ingest(){},needsTradeRestart(){return false;},needsSnapshot(){return false;},
    takeObservation(symbol){const result=pending.get(symbol)??null;pending.delete(symbol);return result;},
    reset(){},invalidateAll(){},health(symbol){return {symbol,status:'FRESH',reason:'SYNCHRONIZED'};}};
  const s=setup({symbols:feed.symbols,feedFactory:()=>feed,customSink:async o=>{if(failures.has(o.symbol))throw Error('Unavailable journal');}});
  await start(s);await s.worker.cycle();
  assert.deepEqual(s.worker.health().failedSinkSymbols,['BTCUSDT']);assert.equal(s.worker.health().sinkHealthy,false);
  assert.equal(s.observations.length,1);assert.equal(s.observations[0].symbol,'ETHUSDT');
  failures.clear();pending.set('BTCUSDT',{symbol:'BTCUSDT'});await s.worker.cycle();
  assert.equal(s.worker.health().sinkHealthy,true);assert.deepEqual(s.worker.health().failedSinkSymbols,[]);s.worker.stop();
});

test('a depth response started before disconnect cannot synchronize the post-gap epoch',async()=>{
  let finishSnapshot;let installed=0;
  const s=setup({snapshotResponse:()=>new Promise(resolve=>{finishSnapshot=resolve;}),feedFactory:symbols=>{
    const feed=new BinanceMarketFeed(symbols);const install=feed.installSnapshot.bind(feed);
    feed.installSnapshot=(...args)=>{installed++;return install(...args);};return feed;
  }});
  await start(s);s.advance(1000);const cycle=s.worker.cycle();
  assert.equal(typeof finishSnapshot,'function');s.sockets[1].emit('close');
  finishSnapshot(new Response(JSON.stringify({lastUpdateId:10,bids:[['99','1']],asks:[['101','1']]})));
  await cycle;assert.equal(installed,0);assert.equal(s.observations.length,0);s.worker.stop();
});

test('concurrent start calls cannot create duplicate subscription lifecycles',async()=>{
  let finish;
  const s=setup({exchangeInfoResponse:()=>new Promise(resolve=>{finish=resolve;})});
  const first=s.worker.start({activationApproved:true,environment:'local-replay'});
  s.advance(2000);
  await assert.rejects(s.worker.start({activationApproved:true,environment:'local-replay'}),/WORKER_START_PENDING/);
  assert.equal(s.requests.length,1);
  finish(new Response(JSON.stringify({symbols:[{symbol:'BTCUSDT',status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT'}]})));
  await first;assert.equal(s.sockets.length,3);s.worker.stop();
});

test('stopping during discovery prevents the pending start from opening any sockets',async()=>{
  let finish;
  const s=setup({exchangeInfoResponse:()=>new Promise(resolve=>{finish=resolve;})});
  const starting=s.worker.start({activationApproved:true,environment:'local-replay'});
  s.worker.stop();
  finish(new Response(JSON.stringify({symbols:[{symbol:'BTCUSDT',status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT'}]})));
  await assert.rejects(starting,/WORKER_START_CANCELLED/);
  assert.equal(s.sockets.length,0);assert.equal(s.worker.health().running,false);
});
