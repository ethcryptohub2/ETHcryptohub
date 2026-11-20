import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import watchlist from '../deploy/market-worker/soak-watchlist.json' with {type:'json'};
import { parseWindowsPreflightArguments,runWindowsPreflight,publicIPv4,snapshotSample,resolvePublicHosts } from './windows-public-preflight.mjs';
import { PublicFrameDecoder,maskedControlFrame,assertPublicHttpTarget,assertPublicSocketTarget,tlsEvidence,openControlSocket,publicHttpsGet } from './public-preflight-wire.mjs';
import { subscriptionPlan } from '../lib/intelligence/market-worker.ts';
import { buildWindowsPreflightBundle } from './build-windows-preflight-bundle.mjs';
import { spawnSync } from 'node:child_process';
const base=1_800_000_000_000;
const argv=out=>['--execute-approved-public-only','--eligibility-confirmed','--output',out];
const serverFrame=(opcode,payload,fin=true)=>Buffer.concat([Buffer.from([(fin?128:0)|opcode,payload.length]),Buffer.from(payload)]);

test('approval, Node version, credentials, proxies and TLS overrides fail before any I/O',()=>{
  assert.throws(()=>parseWindowsPreflightArguments([],{},'24.22.3'),/APPROVAL/);
  assert.throws(()=>parseWindowsPreflightArguments(argv('unused'),{},'27.0.0'),/NODE_24/);
  assert.throws(()=>parseWindowsPreflightArguments(argv('\\\\server\\share'),{},'24.22.3'),/LOCAL_EVIDENCE/);
  for(const env of [{SUPABASE_SERVICE_ROLE_KEY:'fixture-only'},{BINANCE_KEY:'fixture-only'},{HTTPS_PROXY:'fixture-only'},{NODE_TLS_REJECT_UNAUTHORIZED:'0'},{NODE_OPTIONS:'fixture-only'}])assert.throws(()=>parseWindowsPreflightArguments(argv('unused'),env,'24.22.3'));
  const config=parseWindowsPreflightArguments(argv('unused'),{},'24.22.3');assert.equal(config.durationMs,480_000);assert.equal(config.context,'windows-local');
});
test('wire targets cannot select orders, private streams, redirects, arbitrary symbols or hosts',async()=>{
  for(const value of ['https://fapi.binance.com/fapi/v1/order','https://fapi.binance.com/fapi/v1/depth?symbol=OTHERUSDT&limit=100','https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000','https://example.test/fapi/v1/ping','https://user:pass@fapi.binance.com/fapi/v1/ping'])assert.throws(()=>assertPublicHttpTarget(new URL(value)));
  assert.doesNotThrow(()=>assertPublicHttpTarget(new URL('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=100')));
  assert.throws(()=>assertPublicSocketTarget('wss://fstream.binance.com/private/ws/anything'));
  assert.throws(()=>tlsEvidence({authorized:false}),/TLS_NOT_AUTHORIZED/);
  await assert.rejects(publicHttpsGet(new URL('https://example.test/'),{request:()=>{throw Error('must not call');}}),/TARGET/);
  assert.equal(publicIPv4('127.0.0.1'),false);assert.equal(publicIPv4('10.0.0.1'),false);assert.equal(publicIPv4('8.8.8.8'),true);
});
test('fragmented text and interleaved real control ping decode; client pong is masked with matching payload',()=>{
  const texts=[],pings=[];const decoder=new PublicFrameDecoder({onText:text=>texts.push(text),onPing:p=>pings.push(p),onClose:()=>{}});
  const bytes=Buffer.concat([serverFrame(1,'{"a":',false),serverFrame(9,'ping'),serverFrame(0,'1}')]);
  for(const byte of bytes)decoder.push(Buffer.from([byte]));assert.deepEqual(texts,['{"a":1}']);assert.equal(pings[0].toString(),'ping');
  const frame=maskedControlFrame(10,pings[0],Buffer.from([1,2,3,4]));assert.equal(frame[0],138);assert.equal(frame[1],132);
  assert.equal(Buffer.from([...frame.subarray(6)].map((x,i)=>x^frame[2+i%4])).toString(),'ping');
});
test('invalid frame opcodes, masking, control fragmentation, UTF8 and oversized payloads fail closed',()=>{
  const make=()=>new PublicFrameDecoder({onText:()=>{},onPing:()=>{},onClose:()=>{},maxBytes:32});
  for(const frame of [Buffer.from([0x82,0]),Buffer.from([0x81,0x80]),Buffer.from([0x09,0]),Buffer.from([0x81,1,0xff]),Buffer.from([0x81,126,0,40])])assert.throws(()=>make().push(frame));
});
test('real HTTPS upgrade adapter writes a masked pong and rejects bad upgrade accept',async()=>{
  const {createHash}=await import('node:crypto');let transport,requestObject;const evidence=[],messages=[];
  function request(_url,options) {
    requestObject=new EventEmitter();requestObject.setTimeout=()=>{};requestObject.destroy=()=>{};
    requestObject.end=()=>queueMicrotask(()=>{
      transport=new EventEmitter();Object.assign(transport,{authorized:true,getPeerCertificate:()=>({fingerprint256:'fixture',valid_to:'future'}),getProtocol:()=> 'TLSv1.3',setTimeout:()=>{},destroy:()=>{},write:(bytes,callback)=>{transport.sent=bytes;callback?.();}});
      const accept=createHash('sha1').update(options.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      requestObject.emit('upgrade',{statusCode:101,headers:{upgrade:'websocket',connection:'Upgrade','sec-websocket-accept':accept}},transport,Buffer.alloc(0));
    });return requestObject;
  }
  const controller=new AbortController(),url=subscriptionPlan(watchlist.symbols)[0].url;
  const socket=await openControlSocket(url,{signal:controller.signal,request,onText:t=>messages.push(t),onEvidence:e=>evidence.push(e),onFailure:e=>{throw e;}});
  transport.emit('data',serverFrame(9,'public-ping'));transport.emit('data',serverFrame(1,'{}'));
  assert.equal(transport.sent[0],138);assert.equal(evidence.filter(e=>e.kind==='server_ping').length,1);
  assert.equal(evidence.find(e=>e.kind==='server_ping').hash,evidence.find(e=>e.kind==='pong_written').hash);assert.deepEqual(messages,['{}']);socket.close();
  const badRequest=()=>{const r=new EventEmitter();r.setTimeout=()=>{};r.destroy=()=>{};r.end=()=>queueMicrotask(()=>r.emit('upgrade',{statusCode:101,headers:{}},{destroy:()=>{}},Buffer.alloc(0)));return r;};
  await assert.rejects(openControlSocket(url,{signal:controller.signal,request:badRequest,onEvidence:()=>{},onText:()=>{},onFailure:()=>{}}),/UPGRADE/);
});
test('DNS adapter limits fixed IPv4 hosts, rejects private answers and cancels pending resolution',async()=>{
  const calls=[];let cancel;
  class FakeResolver {
    constructor(options){assert.deepEqual(options,{timeout:3000,tries:1});}
    async resolve4(host,options){calls.push(host);assert.equal(options.ttl,true);return [{address:'8.8.8.8',ttl:60}];}
    cancel(){}
  }
  const result=await resolvePublicHosts(new AbortController().signal,{ResolverType:FakeResolver});assert.deepEqual(Object.keys(result),['fapi.binance.com','fstream.binance.com']);assert.equal(calls.length,2);
  class PrivateResolver extends FakeResolver {async resolve4(){return [{address:'127.0.0.1',ttl:1}];}}
  await assert.rejects(resolvePublicHosts(new AbortController().signal,{ResolverType:PrivateResolver}),/NON_PUBLIC/);
  const controller=new AbortController();
  class WaitingResolver extends FakeResolver {
    resolve4(){const pending=Promise.withResolvers();cancel=()=>pending.reject(Error('DNS_CANCELLED'));queueMicrotask(()=>controller.abort());return pending.promise;}
    cancel(){cancel();}
  }
  await assert.rejects(resolvePublicHosts(controller.signal,{ResolverType:WaitingResolver}),/DNS_CANCELLED/);
});
test('HTTPS adapter verifies TLS and records denial/redirect evidence without following or retrying',async()=>{
  for(const status of [200,302,429,418]) {
    let calls=0;const records=[];
    const request=(_url,options,callback)=>{
      calls++;assert.equal(options.method,'GET');assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);
      assert.deepEqual(Object.keys(options.headers).sort(),['accept','user-agent']);
      const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=error=>{if(error)req.emit('error',error);};
      req.end=()=>queueMicrotask(()=>{
        const socket=new EventEmitter();Object.assign(socket,{authorized:true,getPeerCertificate:()=>({fingerprint256:'fixture',valid_to:'future'}),getProtocol:()=> 'TLSv1.3'});
        req.emit('socket',socket);socket.emit('secureConnect');
        const response=new EventEmitter();Object.assign(response,{statusCode:status,headers:{'retry-after':'60'},resume:()=>{},destroy:()=>{}});
        callback(response);response.emit('data',Buffer.from('{}'));response.emit('end');
      });return req;
    };
    const pending=publicHttpsGet(new URL('https://fapi.binance.com/fapi/v1/ping'),{signal:new AbortController().signal,request,onEvidence:r=>records.push(r)});
    if(status===200)assert.deepEqual(await pending,{});else await assert.rejects(pending);
    assert.equal(calls,1);assert.equal(records[0].status,status);assert.equal(records[0].tls.authorized,true);assert.equal(records[0].retryAfter,'60');
  }
});

function fixture({denial,missingPings=false,gap=false,timeout=false}={}) {
  let elapsed=0,deadline,deadlineMs;const connections=[],requests=[],signals=new EventEmitter();
  const depth=new Map(watchlist.symbols.map(s=>[s,100])),trade=new Map(watchlist.symbols.map(s=>[s,0]));
  const now=()=>base+elapsed;
  const emit=()=>{
    if(connections.length!==3)return;
    const tickers=watchlist.symbols.map(s=>({e:'24hrTicker',s,E:now(),c:'100',q:'50000000'}));
    connections[0].options.onText(JSON.stringify({stream:'!ticker@arr',data:tickers}));
    for(const symbol of watchlist.symbols) {
      const a=trade.get(symbol)+1;trade.set(symbol,a);connections[1].options.onText(JSON.stringify({stream:symbol.toLowerCase()+'@aggTrade',data:{e:'aggTrade',s:symbol,E:now(),a,p:'100',q:'10',m:false}}));
      const prior=depth.get(symbol),u=prior+1;depth.set(symbol,u);
      connections[2].options.onText(JSON.stringify({stream:symbol.toLowerCase()+'@depth@100ms',data:{e:'depthUpdate',s:symbol,E:now(),U:u,u,pu:gap&&elapsed>200_000?0:prior,b:[],a:[]}}));
    }
    if(!missingPings)for(const c of connections)for(const at of [180_000,360_000])if(elapsed>=at&&!c.pinged.has(at)){
      c.pinged.add(at);c.options.onEvidence({kind:'server_ping',at:base+at,hash:'fixture-payload',bytes:0});c.options.onEvidence({kind:'pong_written',at:base+at+1,hash:'fixture-payload',bytes:0});
    }
  };
  const deps={now,mono:()=>elapsed,signals,setTimer:(fn,ms)=>{deadline=fn;deadlineMs=ms;return fn;},clearTimer:()=>{},
    sleep:async(ms,signal)=>{if(timeout){deadline();throw Error('PREFLIGHT_ABORTED');}if(signal.aborted)throw Error('PREFLIGHT_ABORTED');if(ms>1000){elapsed+=ms-100;emit();elapsed+=100;}else elapsed+=ms;emit();},
    resolve:async()=>Object.fromEntries(['fapi.binance.com','fstream.binance.com'].map(host=>[host,{at:now(),durationMs:1,addresses:[{address:'8.8.8.8',ttl:60}]}])),
    connect:async(url,options)=>{const socket={url,options,pinged:new Set(),closed:false,close(){this.closed=true;}};connections.push(socket);
      options.signal.addEventListener('abort',()=>{if(!socket.closed)options.onFailure(Error('UNEXPECTED_ABORT_WHILE_OPEN'));},{once:true});
      options.onEvidence({kind:'ws_open',at:now(),url,tls:{authorized:true}});return socket;},
    get:async(url,options)=>{
      if(options.signal.aborted)throw Error('PREFLIGHT_ABORTED');requests.push({url:String(url),at:elapsed});elapsed+=10;emit();
      const status=denial&&requests.length===2?denial:200;
      options.onEvidence({kind:'http',at:now(),path:url.pathname+url.search,status,rttMs:10,tls:{authorized:true},usedWeight:null,retryAfter:status===200?null:'60'});
      if(status!==200)throw Error(`PROVIDER_DENIAL_${status}`);
      if(url.pathname.endsWith('/ping'))return {};
      if(url.pathname.endsWith('/time'))return {serverTime:now()-5};
      if(url.pathname.endsWith('/exchangeInfo'))return {rateLimits:[{rateLimitType:'REQUEST_WEIGHT',interval:'MINUTE',intervalNum:1,limit:2400}],symbols:watchlist.symbols.map(symbol=>({symbol,status:'TRADING',quoteAsset:'USDT',marginAsset:'USDT',contractType:'PERPETUAL'}))};
      const symbol=url.searchParams.get('symbol');
      if(url.pathname.endsWith('/depth'))return {lastUpdateId:depth.get(symbol),bids:[['99.99','5000']],asks:[['100.01','5000']]};
      return {symbol,quoteVolume:'50000000',highPrice:'101',lowPrice:'99',lastPrice:'100'};
    }};
  return {deps,requests,connections,get deadlineMs(){return deadlineMs;}};
}
async function runFixture(options={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'smartexit-windows-preflight-')),output=path.join(dir,'evidence'),f=fixture(options);
  try {const report=await runWindowsPreflight({...parseWindowsPreflightArguments(argv(output),{},'24.22.3'),fixtureMode:true},f.deps);return {report,...f,files:await fs.readdir(output)};}
  finally{await fs.rm(dir,{recursive:true,force:true});}
}
test('finite Windows-local fixtures qualify all20, close all sockets and retain honest evidence context',async()=>{
  const result=await runFixture();assert.equal(result.report.status,'COMPLETE_OFFLINE_FIXTURE');assert.equal(result.report.liveProviderPreflightExecuted,false);assert.equal(result.report.context,'OFFLINE_FIXTURE_WINDOWS_LOCAL_NOT_CLOUD');assert.equal(result.report.cloudRegionalConnectivity,'NOT_TESTED');
  assert.equal(result.report.persistentWorkerStarted,false);assert.equal(result.report.websiteRefreshed,false);assert.equal(result.report.durationMs,480_000);
  assert.equal(result.requests.length,263);assert.ok(result.connections.every(s=>s.closed));assert.equal(result.deps.signals.listenerCount('SIGINT'),0);
  assert.equal(result.files.length,7);assert.ok(result.report.pingPong.every(p=>p.serverPings===2&&p.matchingPongWrites===2));
  for(const r of result.requests){const rolling=result.requests.filter(x=>x.at<=r.at&&r.at-x.at<60_000);const weight=rolling.reduce((n,x)=>n+(x.url.includes('/depth?')?5:1),0);assert.ok(weight<=250);}
});
test('429/418/403/451 denials stop immediately without retries or new sockets',async()=>{
  for(const denial of [429,418,403,451]){const r=await runFixture({denial});assert.equal(r.report.status,'ABORTED');assert.equal(r.report.failure,`PROVIDER_DENIAL_${denial}`);assert.equal(r.requests.length,2);assert.equal(r.connections.length,0);}
});
test('unobserved ping/pong cannot pass; gaps/deadline close every socket without a persistent process',async()=>{
  assert.equal((await runFixture({missingPings:true})).report.status,'INCOMPLETE');
  const gap=await runFixture({gap:true});assert.equal(gap.report.status,'ABORTED');assert.equal(gap.report.failure,'DEPTH_OR_TRADE_CONTINUITY_LOST');assert.ok(gap.connections.every(s=>s.closed));
  const timed=await runFixture({timeout:true});assert.equal(timed.report.failure,'PREFLIGHT_15_MINUTE_DEADLINE');assert.equal(timed.requests.length,1);assert.equal(timed.deadlineMs,900_000);
});
test('book evidence rejects crossed or malformed levels before qualification',()=>{
  assert.throws(()=>snapshotSample({bids:[['2','1']],asks:[['1','1']]},base),/CROSSED/);
  assert.throws(()=>snapshotSample({bids:[['1','NaN']],asks:[['2','1']]},base),/LEVEL/);
});
test('prepared ten-source-file artifact has no install dependencies and refuses unapproved execution',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'smartexit-free-preflight-bundle-')),output=path.join(dir,'bundle');
  try {
    const result=await buildWindowsPreflightBundle(output);assert.equal(result.files.length,10);assert.equal(result.livePreflightApproved,false);
    const manifest=JSON.parse(await fs.readFile(path.join(output,'MANIFEST.json'),'utf8'));assert.equal(manifest.files.length,10);
    assert.ok(manifest.files.every(f=>/^[a-f0-9]{64}$/.test(f.sha256)&&!/(?:\.env|\/db\.|postgres|email|notification|migration)/.test(f.name)));
    const child=spawnSync(process.execPath,[path.join(output,'scripts/windows-public-preflight.mjs')],{encoding:'utf8',env:{SystemRoot:process.env.SystemRoot??'C:\\Windows'}});
    assert.equal(child.status,1);assert.match(child.stderr,/SEPARATE_FINITE_PREFLIGHT_APPROVAL_REQUIRED/);
    await assert.rejects(buildWindowsPreflightBundle(output),{code:'EEXIST'});
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
