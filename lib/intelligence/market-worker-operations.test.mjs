import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BinanceMarketFeed, BoundedMarketQueue } from './market-feed.ts';
import { subscriptionPlan } from './market-worker.ts';
import { openObservationJournal, writeHealth, assessWorkerHealth } from '../../scripts/market-worker-storage.mjs';
import { checkWorkerHealth } from '../../scripts/check-market-worker-health.mjs';

test('522-symbol ticker coverage never implies unselected trade/book readiness',()=>{
  const symbols=Array.from({length:522},(_,i)=>`TOKEN${i}USDT`), feed=new BinanceMarketFeed(symbols);
  feed.ingest(symbols.map(s=>({e:'24hrTicker',s,E:10_000,c:'100',q:'50000'})),10_000);
  assert.deepEqual(feed.tickerCoverage(10_100),{total:522,fresh:522,stale:0,unseen:0,maxFreshLagMs:100});
  assert.ok(symbols.every(s=>feed.health(s,10_100).status==='UNAVAILABLE'));
  assert.equal(feed.tickerCoverage(16_000).fresh,0);assert.equal(feed.tickerCoverage(16_000).stale,522);
  const selected=symbols.slice(0,200), plan=subscriptionPlan(selected);
  assert.equal(plan.length,5);assert.deepEqual(plan.filter(p=>p.kind==='depth').map(p=>p.symbols.length),[100,100]);
  assert.throws(()=>subscriptionPlan(symbols),/INVALID_SUBSCRIPTION_PLAN/);
});

test('queue age and bytes expose pressure and reset after drain',()=>{
  const queue=new BoundedMarketQueue(2,1024);queue.enqueue({payload:{},bytes:100,receivedAt:1000});
  assert.equal(queue.oldestAgeMs(2500),1500);assert.equal(queue.byteSize,100);queue.drain();assert.equal(queue.byteSize,0);assert.equal(queue.oldestAgeMs(2500),0);
});

test('a high-coverage depth burst exceeds the actual queue service envelope visibly',()=>{
  const queue=new BoundedMarketQueue();let rejected=0;
  // Synthetic 200 symbols × 10 depth frames/s. This is a capacity scenario,
  // not a measured Binance arrival rate or a throughput service guarantee.
  for(let tick=0;tick<10;tick++){
    for(let symbol=0;symbol<200;symbol++)if(!queue.enqueue({payload:{symbol},receivedAt:tick*100,bytes:200}))rejected++;
    queue.drain(128);
  }
  assert.ok(rejected>0);assert.equal(queue.dropped,rejected);assert.ok(queue.size<=256);
});

test('an interrupted journal tail fails closed rather than appending corrupt replay evidence',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'smartexit-worker-tail-'));
  try{await fs.writeFile(path.join(dir,'observations.000000000000.ndjson'),'{"partial":');await assert.rejects(openObservationJournal(dir,{segmentBytes:1024,segments:2}),/INCOMPLETE_TAIL/);}
  finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('partial write and fsync failure poison the writer until explicit tail review',async()=>{
  for(const failure of ['writeFile','sync']) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'smartexit-worker-poison-'));
    try{
      const io={...fs,open:async(...args)=>{
        const handle=await fs.open(...args);
        return {stat:()=>handle.stat(),read:(...a)=>handle.read(...a),close:()=>handle.close(),
          writeFile:async text=>{if(failure==='writeFile'){await handle.writeFile(text.slice(0,5));throw Error('Injected partial write');}await handle.writeFile(text);},
          sync:async()=>{if(failure==='sync')throw Error('Injected fsync failure');await handle.sync();}};
      }};
      const journal=await openObservationJournal(dir,{segmentBytes:1024,segments:2,io});
      await assert.rejects(journal.write({id:1}),/Injected/);const file=path.join(dir,'observations.000000000000.ndjson'), before=await fs.readFile(file,'utf8');
      await assert.rejects(journal.write({id:2}),/POISONED/);assert.equal(await fs.readFile(file,'utf8'),before);await journal.close();
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  }
});

test('close drains an in-flight journal write before closing the file and rejects later writes',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'smartexit-worker-drain-'));
  let resume,entered;const started=new Promise(r=>{entered=r;}),hold=new Promise(r=>{resume=r;});let closed=false;
  try{
    const io={...fs,open:async(...args)=>{const handle=await fs.open(...args);return {stat:()=>handle.stat(),read:(...a)=>handle.read(...a),close:async()=>{closed=true;await handle.close();},writeFile:async text=>{entered();await hold;await handle.writeFile(text);},sync:()=>handle.sync()};}};
    const journal=await openObservationJournal(dir,{segmentBytes:1024,segments:2,io});const writing=journal.write({id:1});await started;const closing=journal.close();
    await assert.rejects(journal.write({id:2}),/CLOSED/);assert.equal(closed,false);resume();await writing;await closing;assert.equal(closed,true);
    assert.deepEqual(JSON.parse((await fs.readFile(path.join(dir,'observations.000000000000.ndjson'),'utf8')).trim()),{id:1});
  }finally{resume?.();await fs.rm(dir,{recursive:true,force:true});}
});

test('segmented durable journal bounds retention, survives restart and preserves unrelated files',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'smartexit-worker-retention-'));
  try{
    await fs.writeFile(path.join(dir,'observations.ndjson'),'legacy-preserved');await fs.writeFile(path.join(dir,'operator-note'),'keep');
    let journal=await openObservationJournal(dir,{segmentBytes:1024,segments:2});
    for(let i=0;i<8;i++)await journal.write({id:i,payload:'x'.repeat(700)});await journal.close();
    let names=(await fs.readdir(dir)).filter(n=>/^observations\.\d{12}\.ndjson$/.test(n));assert.equal(names.length,2);
    assert.deepEqual(await Promise.all(names.map(async n=>JSON.parse((await fs.readFile(path.join(dir,n),'utf8')).trim()).id)),[6,7]);
    journal=await openObservationJournal(dir,{segmentBytes:1024,segments:2});await journal.write({id:8,payload:'x'.repeat(700)});await journal.close();
    names=(await fs.readdir(dir)).filter(n=>/^observations\.\d{12}\.ndjson$/.test(n));assert.equal(names.length,2);
    assert.equal(await fs.readFile(path.join(dir,'observations.ndjson'),'utf8'),'legacy-preserved');assert.equal(await fs.readFile(path.join(dir,'operator-note'),'utf8'),'keep');
    await assert.rejects(journal.write({}),/CLOSED/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('read-only heartbeat probe distinguishes live, ready, stale and corrupt health without activation',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'smartexit-worker-health-'));
  const state={running:true,sinkHealthy:true,connections:[{connected:true}],researchCoverage:{selected:2,fresh:2},queueOldestAgeMs:0};
  try{
    assert.equal((await checkWorkerHealth(dir,100_000)).live,false);
    await writeHealth(dir,state,100_000);assert.deepEqual(await checkWorkerHealth(dir,100_100),{live:true,ready:true,reason:'SELECTED_COVERAGE_FRESH'});
    assert.equal((await checkWorkerHealth(dir,146_000)).live,false);
    assert.equal(assessWorkerHealth({version:1,at:100_000,...state,researchCoverage:{selected:2,fresh:1}},100_100).ready,false);
    assert.equal(assessWorkerHealth({version:1,at:100_000,...state,queueOldestAgeMs:1001},100_100).ready,false);
    assert.equal(assessWorkerHealth({version:1,at:100_000,...state,sinkHealthy:false},100_100).ready,false);
    await fs.writeFile(path.join(dir,'health.json'),'bad');assert.equal((await checkWorkerHealth(dir)).reason,'HEARTBEAT_UNREADABLE');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
