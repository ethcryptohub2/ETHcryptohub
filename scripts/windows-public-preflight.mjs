// Manual finite diagnostic only. Importing this file opens no sockets or files.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Resolver } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { BinanceMarketFeed, discoverEligibleSymbols } from '../lib/intelligence/market-feed.ts';
import { subscriptionPlan } from '../lib/intelligence/market-worker.ts';
import { assertPublicWorkerEnvironment } from './market-intelligence-worker.mjs';
import { qualifyPublicPreflight } from './qualify-public-preflight.mjs';
import { publicHttpsGet, openControlSocket, assertPublicHttpTarget } from './public-preflight-wire.mjs';
import watchlist from '../deploy/market-worker/soak-watchlist.json' with {type:'json'};

export function parseWindowsPreflightArguments(args,env=process.env,nodeVersion=process.versions.node) {
  if(args.length!==4||args[0]!=='--execute-approved-public-only'||args[1]!=='--eligibility-confirmed'||args[2]!=='--output'||!args[3])throw Error('SEPARATE_FINITE_PREFLIGHT_APPROVAL_REQUIRED');
  if(/^(?:\\\\|\/\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(args[3]))throw Error('LOCAL_EVIDENCE_DIRECTORY_REQUIRED');
  if(nodeVersion.split('.')[0]!=='24')throw Error('NODE_24_REQUIRED');
  assertPublicWorkerEnvironment(env);
  if(Object.keys(env).some(key=>/PROXY|^NODE_OPTIONS$|^NODE_EXTRA_CA_CERTS$|^NODE_TLS_REJECT_UNAUTHORIZED$|^NODE_USE_ENV_PROXY$/i.test(key)&&env[key]))throw Error('PROXY_OR_TLS_OVERRIDE_NOT_ALLOWED');
  return {output:path.resolve(args[3]),durationMs:480_000,context:'windows-local',approved:true};
}
export async function resolvePublicHosts(signal,{ResolverType=Resolver}={}) {
  const resolver=new ResolverType({timeout:3000,tries:1}),result={};
  const cancel=()=>resolver.cancel();signal.addEventListener('abort',cancel,{once:true});
  try {
    for(const host of ['fapi.binance.com','fstream.binance.com']) {
      if(signal.aborted)throw Error('PREFLIGHT_ABORTED');
      const start=performance.now(),addresses=await resolver.resolve4(host,{ttl:true});
      if(!addresses.length||addresses.length>64)throw Error('INVALID_PUBLIC_DNS');
      if(addresses.some(({address})=>!publicIPv4(address)))throw Error('NON_PUBLIC_DNS_RESPONSE');
      result[host]={at:Date.now(),durationMs:performance.now()-start,addresses};
    }
    return result;
  } finally {signal.removeEventListener('abort',cancel);}
}
export function publicIPv4(address) {
  if(typeof address!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(address))return false;
  const n=address.split('.').map(Number);if(n.some(x=>!Number.isInteger(x)||x<0||x>255))return false;
  return !(n[0]===0||n[0]===10||n[0]===127||n[0]>=224||n[0]===169&&n[1]===254||n[0]===172&&n[1]>=16&&n[1]<=31||n[0]===192&&[0,168].includes(n[1])||n[0]===100&&n[1]>=64&&n[1]<=127||n[0]===198&&[18,19,51].includes(n[1])||n[0]===203&&n[1]===0&&n[2]===113);
}
export function snapshotSample(snapshot,at) {
  const levels=side=>{
    if(!Array.isArray(side)||!side.length||side.length>100)throw Error('INVALID_DEPTH_SNAPSHOT');
    const rows=side.map(row=>{if(!Array.isArray(row)||row.length!==2||!row.every(x=>typeof x==='string'&&x.trim()!==''&&Number.isFinite(Number(x))&&Number(x)>0))throw Error('INVALID_DEPTH_LEVEL');return row.map(Number);});
    if(new Set(rows.map(r=>r[0])).size!==rows.length)throw Error('DUPLICATE_DEPTH_LEVEL');return rows;
  };
  const bids=levels(snapshot.bids).sort((a,b)=>b[0]-a[0]),asks=levels(snapshot.asks).sort((a,b)=>a[0]-b[0]);
  if(bids[0][0]>=asks[0][0])throw Error('CROSSED_DEPTH');
  return {at,bid:bids[0][0],ask:asks[0][0],bidDepthQuote:bids.slice(0,20).reduce((n,[p,q])=>n+p*q,0),askDepthQuote:asks.slice(0,20).reduce((n,[p,q])=>n+p*q,0)};
}
const percentile=values=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]:null;
const code=error=>/^[A-Z0-9_]{1,80}$/.test(error?.code??'')?error.code:/^[A-Z0-9_]{1,80}$/.test(error?.message??'')?error.message:'NETWORK_OR_PROTOCOL_ERROR';

/** Dependencies are injectable for finite offline fixtures, never a remote scheduler. */
export async function runWindowsPreflight(config,dependencies={}) {
  if(config.approved!==true||config.context!=='windows-local'||!Number.isSafeInteger(config.durationMs)||config.durationMs<420_000||config.durationMs>840_000)throw Error('INVALID_FINITE_DIAGNOSTIC_CONFIG');
  if(Object.keys(dependencies).length&&config.fixtureMode!==true)throw Error('INJECTED_TRANSPORT_REQUIRES_FIXTURE_LABEL');
  if(config.fixtureMode===true&&['resolve','get','connect','now','mono','sleep','setTimer','clearTimer','signals'].some(key=>dependencies[key]===undefined))throw Error('OFFLINE_FIXTURE_DEPENDENCY_MISSING');
  const d={now:Date.now,mono:()=>performance.now(),sleep:(ms,signal)=>delay(ms,undefined,{signal}),resolve:resolvePublicHosts,
    get:publicHttpsGet,connect:openControlSocket,setTimer:setTimeout,clearTimer:clearTimeout,signals:process,...dependencies};
  // Exclusive creation: no overwriting an existing evidence folder or its files.
  await fs.mkdir(config.output,{mode:0o700});
  const started=d.now(),startMono=d.mono(),controller=new AbortController(),sockets=[],http=[],controls=[],statistics=[];
  const samples=new Map(watchlist.symbols.map(s=>[s,[]]));let failure=null,feed=null,dns=null,info=null,infoAt=0,qualificationInput=null,qualification=null,nextRest=0,weights=[];
  const established=new Set();
  let wireBytes=0,frames=0,clockEvidence=null,restBudget=250;
  const closeSockets=()=>{for(const s of sockets)try{s.close();}catch{failure??='SOCKET_CLEANUP_FAILED';}};
  const stop=error=>{failure??=code(error);closeSockets();controller.abort();};
  const signalStop=()=>stop(Error('OPERATOR_CANCELLED'));
  d.signals.once('SIGINT',signalStop);d.signals.once('SIGTERM',signalStop);
  const deadline=d.setTimer(()=>stop(Error('PREFLIGHT_15_MINUTE_DEADLINE')),900_000);
  const boundedPush=(list,row,max)=>{if(list.length>=max)throw Error('EVIDENCE_CAPACITY_EXCEEDED');list.push(row);};
  const evidence=row=>{
    if(row.kind==='http') {
      boundedPush(http,row,400);
      const used=Number(row.usedWeight);if(row.status===200&&Number.isFinite(used)&&used>=300)throw Error('SHARED_IP_WEIGHT_LIMIT');
    } else boundedPush(controls,row,200);
  };
  const waitUntil=async when=>{if(when>d.mono())await d.sleep(when-d.mono(),controller.signal);if(failure||controller.signal.aborted)throw Error(failure??'PREFLIGHT_ABORTED');};
  const rest=async(pathname,weight)=>{
    const url=new URL(pathname,'https://fapi.binance.com');assertPublicHttpTarget(url);
    await waitUntil(nextRest);let clock=d.mono();weights=weights.filter(x=>clock-x.at<60_000);
    if(weight>restBudget)throw Error('PROVIDER_RATE_BUDGET_TOO_SMALL');
    while(weights.reduce((sum,x)=>sum+x.weight,0)+weight>restBudget){await waitUntil(weights[0].at+60_001);clock=d.mono();weights=weights.filter(x=>clock-x.at<60_000);}
    weights.push({at:clock,weight});nextRest=clock+1000;
    return d.get(url,{signal:controller.signal,lookup,onEvidence:evidence,now:d.now});
  };
  let lookup;
  try {
    dns=await d.resolve(controller.signal);
    lookup=(hostname,options,callback)=>{
      const rows=dns[hostname]?.addresses;if(!rows?.length||rows.some(r=>!publicIPv4(r.address))){callback(Error('UNEXPECTED_DNS_TARGET'));return;}
      if(options.all)callback(null,rows.map(r=>({address:r.address,family:4})));else callback(null,rows[0].address,4);
    };
    await rest('/fapi/v1/ping',1);
    const server=await rest('/fapi/v1/time',1),timing=http.at(-1);
    clockEvidence={serverTime:server.serverTime,receivedAt:timing?.at,rttMs:timing?.rttMs,offsetMs:server.serverTime-(timing?.at-timing?.rttMs/2)};
    if(!Number.isSafeInteger(server.serverTime)||!Number.isFinite(clockEvidence.offsetMs)||Math.abs(clockEvidence.offsetMs)>1000)throw Error('CLOCK_OFFSET_OVER_1S');
    info=await rest('/fapi/v1/exchangeInfo',1);infoAt=d.now();
    const rates=info.rateLimits?.filter(r=>r.rateLimitType==='REQUEST_WEIGHT');
    if(!rates?.length||rates.some(r=>r.interval!=='MINUTE'||r.intervalNum!==1||!Number.isSafeInteger(r.limit)||r.limit<1))throw Error('PROVIDER_RATE_BUDGET_UNVERIFIED');
    restBudget=Math.min(250,...rates.map(r=>Math.floor(r.limit/2)));
    const universe=discoverEligibleSymbols(info);
    if(watchlist.symbols.some(s=>!universe.includes(s)))throw Error('WATCHLIST_SYMBOL_NOT_ELIGIBLE');
    feed=new BinanceMarketFeed(universe);
    const plans=subscriptionPlan(watchlist.symbols);
    for(const plan of plans) {
      const opened=await d.connect(plan.url,{signal:controller.signal,lookup,now:d.now,
        onEvidence:row=>evidence({...row,connection:plan.kind}),onFailure:stop,
        onText:text=>{
          if(failure||controller.signal.aborted)return;
          try {
            wireBytes+=Buffer.byteLength(text);if(wireBytes>256*1024*1024||++frames>2_000_000)throw Error('MARKET_TRAFFIC_CAP');
            const body=JSON.parse(text);if(body&&typeof body.code==='number')throw Error('PROVIDER_WS_ERROR');
            feed.ingest(body,d.now());const m=feed.metrics();if(m.gaps||m.bufferOverflows)throw Error('DEPTH_OR_TRADE_CONTINUITY_LOST');
            for(const symbol of watchlist.symbols) {
              const health=feed.health(symbol,d.now());
              if(established.has(symbol)&&!health.sequenceValid)throw Error('DEPTH_OR_TRADE_CONTINUITY_LOST');
              if(health.sequenceValid)established.add(symbol);
              // Consume disjoint samples in memory only, matching feed lifecycle;
              // this diagnostic has no observation sink, journal or database.
              feed.takeObservation(symbol,d.now());
            }
          }catch(error){stop(error);}
        },
      });
      sockets.push(opened);if(failure)throw Error(failure);
    }
    // Seed books before their bounded diff buffers fill, then capture the five
    // minute qualification window near the end of the finite diagnostic.
    for(const symbol of watchlist.symbols) {
      const snapshot=await rest(`/fapi/v1/depth?symbol=${symbol}&limit=100`,5);
      if(!feed.installSnapshot(symbol,snapshot,d.now()))throw Error('DEPTH_SNAPSHOT_CANNOT_BRIDGE');
    }
    // Leave five seconds of slack for per-symbol REST latency variation.
    const samplingStart=Math.max(d.mono(),startMono+config.durationMs-355_000);
    for(let round=0;round<11;round++) {
      await waitUntil(samplingStart+round*30_500);
      for(const symbol of watchlist.symbols) {
        const snapshot=await rest(`/fapi/v1/depth?symbol=${symbol}&limit=100`,5),at=d.now();
        samples.get(symbol).push(snapshotSample(snapshot,at));
      }
      boundedPush(statistics,{at:d.now(),round,feed:feed.metrics(),tickerCoverage:feed.tickerCoverage(d.now()),selected:watchlist.symbols.map(s=>feed.health(s,d.now()))},12);
    }
    await waitUntil(startMono+config.durationMs-30_000);
    const rows=[];
    for(const symbol of watchlist.symbols) {
      const ticker=await rest(`/fapi/v1/ticker/24hr?symbol=${symbol}`,1),meta=info.symbols.find(x=>x.symbol===symbol);
      if(ticker.symbol!==symbol)throw Error('TICKER_SYMBOL_MISMATCH');
      rows.push({symbol,status:meta.status,quoteAsset:meta.quoteAsset,marginAsset:meta.marginAsset,contractType:meta.contractType,
        tickerAt:d.now(),quoteVolume24h:Number(ticker.quoteVolume),high:Number(ticker.highPrice),low:Number(ticker.lowPrice),last:Number(ticker.lastPrice),samples:samples.get(symbol)});
    }
    qualificationInput={version:1,region:'windows-local',collectedAt:d.now(),exchangeInfoAt:infoAt,symbols:rows};
    qualification=qualifyPublicPreflight(qualificationInput,d.now(),{expectedRegion:'windows-local'});
    await waitUntil(startMono+config.durationMs);
  } catch(error){failure??=code(error);}
  finally {closeSockets();controller.abort();d.clearTimer(deadline);d.signals.off('SIGINT',signalStop);d.signals.off('SIGTERM',signalStop);}
  const selected=feed?watchlist.symbols.map(s=>feed.health(s,d.now())):[];
  const pingPong=subscriptionPlan(watchlist.symbols).map(plan=>{
    const pings=controls.filter(x=>x.connection===plan.kind&&x.kind==='server_ping'),pongs=controls.filter(x=>x.connection===plan.kind&&x.kind==='pong_written');
    let matched=0;for(const ping of pings){const index=pongs.findIndex(pong=>pong.hash===ping.hash&&pong.at>=ping.at);if(index>=0){matched++;pongs.splice(index,1);}}
    return {connection:plan.kind,serverPings:pings.length,matchingPongWrites:matched};
  });
  const networkVerified=['fapi.binance.com','fstream.binance.com'].every(h=>dns?.[h]?.addresses?.length>0)&&http.length>0&&http.every(h=>h.status===200&&h.tls?.authorized===true&&Number.isFinite(h.rttMs)&&h.rttMs>=0)&&['ticker','trades','depth'].every(kind=>controls.some(c=>c.connection===kind&&c.kind==='ws_open'&&c.tls?.authorized===true));
  const complete=!failure&&networkVerified&&qualification?.status==='QUALIFIED_FROM_SUPPLIED_EVIDENCE'&&pingPong.every(p=>p.serverPings>=2&&p.matchingPongWrites===p.serverPings)&&selected.length===20&&selected.every(s=>s.sequenceValid&&s.status==='FRESH');
  const summary={version:1,context:config.fixtureMode===true?'OFFLINE_FIXTURE_WINDOWS_LOCAL_NOT_CLOUD':'WINDOWS_LOCAL_NOT_CLOUD',startedAt:started,endedAt:d.now(),durationMs:d.mono()-startMono,
    runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},
    status:failure?'ABORTED':complete?(config.fixtureMode===true?'COMPLETE_OFFLINE_FIXTURE':'COMPLETE_LOCAL_EVIDENCE'):'INCOMPLETE',failure,liveProviderPreflightExecuted:config.fixtureMode!==true,networkEvidenceComplete:networkVerified,
    legalEligibility:'OPERATOR_ASSERTED_NOT_INDEPENDENTLY_CLEARED',cloudRegionalConnectivity:'NOT_TESTED',paidResourcesUsed:false,
    httpRequests:http.length,httpRttP95Ms:percentile(http.map(x=>x.rttMs)),clockEvidence,pingPong,frames,wireBytes,selected,
    tickerCoverage:feed?.tickerCoverage(d.now())??null,qualificationStatus:qualification?.status??'NOT_COMPLETED',
    persistentWorkerStarted:false,websiteRefreshed:false,activationAuthorized:false};
  const write=(name,value)=>fs.writeFile(path.join(config.output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  await write('dns.json',dns);await write('http.json',http);await write('websocket-control.json',controls);await write('feed-health.json',statistics);
  await write('qualification-input.json',qualificationInput);await write('qualification-result.json',qualification);await write('summary.json',summary);
  return summary;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config=parseWindowsPreflightArguments(process.argv.slice(2));
    if(process.platform!=='win32')throw Error('WINDOWS_LOCAL_RUNNER_REQUIRED');
    const result=await runWindowsPreflight(config);console.log(JSON.stringify({status:result.status,context:result.context,output:config.output}));process.exitCode=result.status==='COMPLETE_LOCAL_EVIDENCE'?0:1;
  }catch(error){console.error(code(error));process.exitCode=1;}
}
