import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { activateApprovedWorker, assertPublicWorkerEnvironment } from './market-intelligence-worker.mjs';
import { buildPublicWorkerBundle, PUBLIC_WORKER_FILES } from './build-public-worker-bundle.mjs';
import watchlist from '../deploy/market-worker/soak-watchlist.json' with {type:'json'};

function runtime({failDiscovery=false,waitDiscovery,symbols=['BTCUSDT']}={}) {
  const sockets=[],signals=new EventEmitter(),timers=[],intervals=[],requests=[];
  return {sockets,signals,requests,intervals,
    overrides:{now:()=>1_000_000,signals,fail:()=>{},log:()=>{},error:()=>{},
      every:fn=>{intervals.push(fn);return fn;},clearEvery:fn=>{intervals.splice(intervals.indexOf(fn),1);},
      timer:{set:fn=>{timers.push(fn);return fn;},clear:fn=>{const i=timers.indexOf(fn);if(i>=0)timers.splice(i,1);}},
      fetch:async url=>{requests.push(String(url));await waitDiscovery;if(failDiscovery)throw Error('fixture discovery failure');return new Response(JSON.stringify({symbols:symbols.map(symbol=>({symbol,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT'}))}));},
      connect:url=>{const handlers={};const socket={url,closed:false,addEventListener:(name,fn)=>{handlers[name]=fn;},close(){this.closed=true;}};sockets.push(socket);return socket;},
    },
  };
}
const env=directory=>({SMARTEXIT_DEPLOYMENT_ENV:'staging',SMARTEXIT_MARKET_WORKER_APPROVAL:'START_STAGING_PUBLIC_MARKET_WORKER',SMARTEXIT_MARKET_SYMBOLS:'BTCUSDT',SMARTEXIT_MARKET_OUTPUT_DIRECTORY:directory});
const args=['--activate-approved-worker'];
const temporary=()=>fs.mkdtemp(path.join(os.tmpdir(),'smartexit-worker-preparation-'));

test('proposed twenty-symbol CLI plan creates three mock transports but never claims warmed coverage',async()=>{
  const directory=await temporary(),r=runtime({symbols:watchlist.symbols});let instance;
  try {
    assert.equal(watchlist.symbols.length,20);assert.equal(new Set(watchlist.symbols).size,20);
    instance=await activateApprovedWorker({...env(directory),SMARTEXIT_MARKET_SYMBOLS:watchlist.symbols.join(',')},args,r.overrides);
    assert.equal(r.sockets.length,3);
    assert.equal(r.sockets.filter(s=>s.url.includes('@aggTrade')).length,1);
    const health=JSON.parse(await fs.readFile(path.join(directory,'health.json'),'utf8'));
    assert.equal(health.researchCoverage.selected,20);assert.equal(health.researchCoverage.fresh,0);
    assert.equal(health.tickerCoverage.fresh,0);
  } finally {await instance?.stop();await fs.rm(directory,{recursive:true,force:true});}
});

test('public worker rejects inherited credentials before any filesystem or network operation',async()=>{
  for(const key of ['SUPABASE_SERVICE_ROLE_KEY','BINANCE_CREDENTIALS_KEY','BINANCE_KEY','AUTH_SECRET','SMTP_PASSWORD','AWS_ACCESS_TOKEN'])assert.throws(()=>assertPublicWorkerEnvironment({[key]:'fixture-only'}),/must not contain/);
  const directory=path.join(os.tmpdir(),`smartexit-must-not-create-${Date.now()}`),r=runtime();
  await assert.rejects(activateApprovedWorker({...env(directory),DATABASE_URL:'fixture-only'},args,r.overrides),/must not contain/);
  assert.equal(r.requests.length,0);await assert.rejects(fs.stat(directory),{code:'ENOENT'});
});

test('actual CLI starts mocked public transports, fences a duplicate writer and stops cleanly with a persisted run id',async()=>{
  const directory=await temporary(),r=runtime();let instance;
  try{
    instance=await activateApprovedWorker(env(directory),args,r.overrides);assert.equal(r.sockets.length,3);
    assert.ok(r.requests.every(url=>url==='https://fapi.binance.com/fapi/v1/exchangeInfo'));
    assert.equal(JSON.parse(await fs.readFile(path.join(directory,'health.json'),'utf8')).runId,1);
    await assert.rejects(activateApprovedWorker(env(directory),args,r.overrides),{code:'EEXIST'});
    await instance.stop();await instance.stop();assert.ok(r.sockets.every(s=>s.closed));
    assert.equal(r.signals.listenerCount('SIGTERM'),0);assert.equal(r.intervals.length,0);
    await assert.rejects(fs.stat(path.join(directory,'worker.lock')),{code:'ENOENT'});
    const restarted=await activateApprovedWorker(env(directory),args,r.overrides);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory,'health.json'),'utf8')).runId,2);await restarted.stop();
  }finally{await instance?.stop();await fs.rm(directory,{recursive:true,force:true});}
});

test('CLI startup failure cleans its owned lock; simulated crash lock is never stolen',async()=>{
  const directory=await temporary();
  try{
    const r=runtime({failDiscovery:true});await assert.rejects(activateApprovedWorker(env(directory),args,r.overrides),/fixture discovery/);
    assert.equal(r.signals.listenerCount('SIGINT'),0);await assert.rejects(fs.stat(path.join(directory,'worker.lock')),{code:'ENOENT'});
    await fs.writeFile(path.join(directory,'worker.lock'),'preserve-crash-evidence');
    const other=runtime();await assert.rejects(activateApprovedWorker(env(directory),args,other.overrides),{code:'EEXIST'});
    assert.equal(other.requests.length,0);assert.equal(await fs.readFile(path.join(directory,'worker.lock'),'utf8'),'preserve-crash-evidence');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('SIGTERM during discovery cancels startup without late subscriptions or leaked signal listeners',{timeout:5000},async()=>{
  const directory=await temporary();let resume;const held=new Promise(resolve=>{resume=resolve;});const r=runtime({waitDiscovery:held});
  try{
    const starting=activateApprovedWorker(env(directory),args,r.overrides);
    // Wait only for deterministic local filesystem setup to enter mocked fetch.
    while(!r.requests.length)await new Promise(resolve=>setImmediate(resolve));
    r.signals.emit('SIGTERM');resume();await assert.rejects(starting,/CANCELLED|cancelled/);
    assert.equal(r.sockets.length,0);assert.equal(r.signals.listenerCount('SIGTERM'),0);
    await assert.rejects(fs.stat(path.join(directory,'worker.lock')),{code:'ENOENT'});
  }finally{resume();await fs.rm(directory,{recursive:true,force:true});}
});

test('standalone bundle copies only public worker files and never merges with an existing target',async()=>{
  const directory=await temporary(),target=path.join(directory,'bundle');
  try{
    const result=await buildPublicWorkerBundle(target);assert.deepEqual(result.files,[...PUBLIC_WORKER_FILES]);
    const manifest=JSON.parse(await fs.readFile(path.join(target,'MANIFEST.json'),'utf8'));assert.equal(manifest.files.length,6);
    assert.ok(manifest.files.every(f=>/^[a-f0-9]{64}$/.test(f.sha256)));
    assert.deepEqual((await fs.readdir(target)).sort(),['MANIFEST.json','lib','package.json','scripts']);
    assert.ok(PUBLIC_WORKER_FILES.every(name=>!/(?:\.env|auth|db|order|notification|migration)/.test(name)));
    await assert.rejects(buildPublicWorkerBundle(target),{code:'EEXIST'});
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
