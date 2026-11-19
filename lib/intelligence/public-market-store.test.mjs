import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import os from 'node:os';
import ts from 'typescript';
import { NextRequest } from 'next/server.js';

const modules=new Map();
function load(file,stubs={}) {
  const source=path.resolve(file);if(!Object.keys(stubs).length&&modules.has(source))return modules.get(source).exports;
  const mod=new Module(source);mod.filename=source;mod.paths=Module._nodeModulePaths(path.dirname(source));
  if(!Object.keys(stubs).length)modules.set(source,mod);
  const delegate=mod.require.bind(mod);
  mod.require=key=>{
    if(key in stubs)return stubs[key];
    if(key.startsWith('.')){let resolved=path.resolve(path.dirname(source),key);if(!resolved.endsWith('.ts'))resolved+='.ts';if(fs.existsSync(resolved))return load(resolved);}
    return delegate(key);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,source);
  return mod.exports;
}
const {PostgresPublicMarketStore,PUBLIC_MARKET_SOURCE}=load('lib/intelligence/public-market-store.ts');
const {marketJournalBatchId,marketJournalEnvelopeHash}=load('lib/intelligence/public-market-tailer.ts');
const {readPublicMarketView}=load('lib/intelligence/public-market-reader.ts');
const {PublicMarketTailer}=load('lib/intelligence/public-market-tailer.ts');
const {PublicMarketImporter}=load('lib/intelligence/public-market-importer.ts');
const now=1_800_000_000_000;
const obs=(at=now)=>({source:'BINANCE_USDM',symbol:'BTCUSDT',eventTime:at-100,receivedAt:at,price:100,bid:99,ask:101,
  quoteVolume:100,buyQuoteVolume:60,sellQuoteVolume:40,bidDepth:100000,askDepth:100000,
  fresh:true,sequenceValid:true,feedEpoch:1_000_001,requiredInputTimes:{ticker:at-100,trade:at-200,depth:at-300}});
function batch(from=null,observation=obs()) {
  const envelope={version:1,runId:1,epoch:observation.feedEpoch,sequence:(from?.sequence??0)+1,observation};
  const bytes=JSON.stringify(envelope),cursor={version:1,runId:1,epoch:envelope.epoch,segment:0,
    byteOffset:(from?.byteOffset??0)+Buffer.byteLength(bytes)+1,sequence:envelope.sequence,lineHash:marketJournalEnvelopeHash(envelope)};
  const records=[{envelope,cursor}];return {version:1,batchId:marketJournalBatchId(from,cursor,records),from,to:cursor,records};
}
function database() {
  const state={row:null,commitLost:false,failWrite:false,queries:[],releases:[]};let tail=Promise.resolve();
  state.connect=async()=>{
    let pending,unlock;
    return {release:discard=>state.releases.push(Boolean(discard)),query:async(sql,p=[])=>{
      state.queries.push({sql,p});
      if(sql==='BEGIN'){pending=null;return {rows:[]};}
      if(sql.startsWith('SET LOCAL'))return {rows:[]};
      if(sql.includes('pg_advisory_xact_lock')){const prior=tail;tail=new Promise(resolve=>{unlock=resolve;});await prior;return {rows:[]};}
      if(sql.startsWith('SELECT revision')){assert.equal(p[0],PUBLIC_MARKET_SOURCE);return {rows:state.row?[structuredClone(state.row)]:[]};}
      if(sql.startsWith('INSERT')){
        if(state.failWrite)throw Error('injected write failure');if(state.row)return {rowCount:0};
        pending={revision:p[1],cursor:JSON.parse(p[2]),checkpoint:JSON.parse(p[3]),last_batch_id:p[4]};return {rowCount:1};
      }
      if(sql.startsWith('UPDATE')){
        assert.equal(p[4],PUBLIC_MARKET_SOURCE);if(state.failWrite)throw Error('injected write failure');
        if(state.row.revision!==p[5])return {rowCount:0};pending={revision:p[0],cursor:JSON.parse(p[1]),checkpoint:JSON.parse(p[2]),last_batch_id:p[3]};return {rowCount:1};
      }
      if(sql==='COMMIT'){if(pending)state.row=pending;unlock?.();unlock=null;if(state.commitLost)throw Error('injected lost commit response');return {rows:[]};}
      if(sql==='ROLLBACK'){pending=null;unlock?.();unlock=null;return {rows:[]};}
      throw Error('Unexpected SQL in local fixture');
    }};
  };return state;
}
const store=db=>new PostgresPublicMarketStore(db,'ghecpkpaxbrvehquhzkr',['BTCUSDT'],['BTCUSDT']);
const stage={SMARTEXIT_PUBLIC_MARKET_READS_ENABLED:'true',VERCEL_ENV:'preview',SMARTEXIT_STAGING_SUPABASE_PROJECT_REF:'ghecpkpaxbrvehquhzkr',
  SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF:'kafsdnzzjawikoavkhvm',NEXT_PUBLIC_SUPABASE_URL:'https://ghecpkpaxbrvehquhzkr.supabase.co',SUPABASE_DB_USER:'postgres.ghecpkpaxbrvehquhzkr'};

test('actual journal→tailer→bounded importer→transactional adapter→website view recovers commit loss and partial tails offline',async()=>{
  const {openObservationJournal}=await import('../../scripts/market-worker-storage.mjs');
  const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'smartexit-public-pipeline-'));let journal;
  try {
    journal=await openObservationJournal(dir,{runId:1});await journal.write(obs());await journal.close();
    let tailer=new PublicMarketTailer(dir),proposal=await tailer.read();const db=database();
    let importer=new PublicMarketImporter(PUBLIC_MARKET_SOURCE,store(db));importer.enqueue(proposal,now);
    db.commitLost=true;await assert.rejects(importer.flushOne(now),/outcome unknown/);
    assert.equal(tailer.acknowledgedCursor(),null);assert.equal(importer.health().queuedBatches,1);
    db.commitLost=false;importer=new PublicMarketImporter(PUBLIC_MARKET_SOURCE,store(db));importer.enqueue(proposal,now);
    const ack=await importer.flushOne(now);assert.equal(ack.duplicate,true);tailer.acknowledge(ack.batchId);
    const recovered=await store(db).readAcknowledgement(now);
    assert.equal(recovered.batchId,ack.batchId);
    tailer=new PublicMarketTailer(dir,recovered.cursor);assert.equal(await tailer.read(),null);
    const next=batch(db.row.cursor,obs(now+1000)),line=JSON.stringify(next.records[0].envelope),file=path.join(dir,'observations.000000000000.ndjson');
    await fs.promises.appendFile(file,line.slice(0,30));assert.equal(await tailer.read(),null);
    await fs.promises.appendFile(file,line.slice(30)+'\n');proposal=await tailer.read();
    importer.enqueue(proposal,now+1000);const secondAck=await importer.flushOne(now+1000);tailer.acknowledge(secondAck.batchId);
    assert.equal(db.row.revision,2);assert.deepEqual(db.row.cursor,tailer.acknowledgedCursor());
    const liveFixture=await readPublicMarketView(stage,now+1000,async()=>db.row);
    assert.equal(liveFixture.market.rows[0].freshnessVerified,true);assert.deepEqual(liveFixture.market.candidates,[]);
    const outage=await readPublicMarketView(stage,now+7000,async()=>db.row);assert.equal(outage.market.rows[0].price,null);
  } finally {await journal?.close();await fs.promises.rm(dir,{recursive:true,force:true});}
});

test('transaction commits projection and acknowledged cursor atomically, duplicates survive restart and stale reads hide price',async()=>{
  const db=database(),first=batch();assert.equal((await store(db).commit(PUBLIC_MARKET_SOURCE,first,now)).duplicate,false);
  assert.deepEqual(db.row.cursor,first.to);assert.equal(db.row.revision,1);
  assert.equal((await store(db).commit(PUBLIC_MARKET_SOURCE,first,now+100)).duplicate,true);assert.equal(db.row.revision,1);
  const second=batch(first.to,obs(now+1000));await store(db).commit(PUBLIC_MARKET_SOURCE,second,now+1000);
  assert.equal(db.row.revision,2);assert.deepEqual(db.row.cursor,second.to);
  assert.equal((await store(db).read(now+7000)).rows[0].price,null);
  assert.equal((await store(db).read(now+1000)).executionEnabled,false);
});
test('write failure rolls back both cursor and projection; lost commit response retries original ID without double application',async()=>{
  const db=database(),first=batch();db.failWrite=true;
  await assert.rejects(store(db).commit(PUBLIC_MARKET_SOURCE,first,now),/injected write/);assert.equal(db.row,null);
  db.failWrite=false;db.commitLost=true;
  await assert.rejects(store(db).commit(PUBLIC_MARKET_SOURCE,first,now),/outcome unknown/);
  assert.equal(db.row.revision,1);assert.equal(db.releases.at(-1),true);
  db.commitLost=false;assert.equal((await store(db).commit(PUBLIC_MARKET_SOURCE,first,now)).duplicate,true);assert.equal(db.row.revision,1);
});
test('lost BEGIN and failed rollback discard the connection without acknowledging data',async()=>{
  const statements=[],releases=[];
  const db={connect:async()=>({query:async sql=>{statements.push(sql);throw Error('injected connection loss');},release:discard=>releases.push(discard)})};
  await assert.rejects(store(db).commit(PUBLIC_MARKET_SOURCE,batch(),now),/connection loss/);
  assert.deepEqual(statements,['BEGIN','ROLLBACK']);assert.deepEqual(releases,[true]);
});
test('concurrent first batches serialize; source, target, forged metadata and wrong cursors fail closed',async()=>{
  const db=database(),first=batch();const results=await Promise.all([store(db).commit(PUBLIC_MARKET_SOURCE,first,now),store(db).commit(PUBLIC_MARKET_SOURCE,first,now)]);
  assert.deepEqual(results.map(r=>r.duplicate),[false,true]);assert.equal(db.row.revision,1);
  assert.throws(()=>new PostgresPublicMarketStore(db,'kafsdnzzjawikoavkhvm',['BTCUSDT'],['BTCUSDT']),/Staging/);
  await assert.rejects(store(db).commit('TENANT_2',first,now),/source/);
  const invalid=structuredClone(first);invalid.records[0].envelope.observation.tenantId=2;
  await assert.rejects(store(db).commit(PUBLIC_MARKET_SOURCE,invalid,now));
  await assert.rejects(store(db).commit(PUBLIC_MARKET_SOURCE,batch(null,obs(now+1000)),now+1000),/compare-and-set/);
  assert.equal(db.row.revision,1);
});
test('disabled/Production reader never queries; enabled reader preserves timestamp evidence and handles outage',async()=>{
  let reads=0;const read=async()=>{reads++;return null;};
  assert.equal((await readPublicMarketView({},now,read)).state,'DISABLED');
  assert.equal((await readPublicMarketView({...stage,VERCEL_ENV:'production'},now,read)).state,'DISABLED');assert.equal(reads,0);
  const db=database();await store(db).commit(PUBLIC_MARKET_SOURCE,batch(),now);
  const snapshot=await readPublicMarketView(stage,now,async source=>{assert.equal(source,PUBLIC_MARKET_SOURCE);return db.row;});
  assert.equal(snapshot.state,'SNAPSHOT');assert.deepEqual(snapshot.market.candidates,[]);
  assert.equal((await readPublicMarketView(stage,now+7000,async()=>db.row)).market.rows[0].price,null);
  assert.equal((await readPublicMarketView(stage,now,async()=>{throw Error('provider storage outage');})).state,'UNAVAILABLE');
});
test('website public-data API rejects guests and tenant selectors, and cannot accept remote writes',async()=>{
  class AuthError extends Error{constructor(status){super('denied');this.status=status;}}
  let actor=null,reads=0;
  const route=load('app/api/intelligence/market/route.ts',{
    '../../../../lib/auth':{AuthError,requireUser:async()=>{if(!actor)throw new AuthError(401);return actor;}},
    '../../../../lib/http':load('lib/http.ts'),
    '../../../../lib/intelligence/public-market-server-reader':{readPublicMarketStatus:async()=>{reads++;return {state:'DISABLED',market:null};}},
  });
  assert.equal((await route.GET(new NextRequest('https://staging.example/api/intelligence/market'))).status,401);assert.equal(reads,0);
  for(const id of [2,3]){actor={id,role:'user'};assert.equal((await route.GET(new NextRequest('https://staging.example/api/intelligence/market?tenantId=1'))).status,422);
    const response=await route.GET(new NextRequest('https://staging.example/api/intelligence/market'));assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).data.state,'DISABLED');}
  const token='a'.repeat(64);const response=await route.POST(new NextRequest('https://staging.example/api/intelligence/market',{method:'POST',
    body:JSON.stringify({enabled:true,tenantId:1}),headers:{host:'staging.example',origin:'https://staging.example',cookie:`ethcryptohub_csrf=${token}`,'x-csrf-token':token}}));
  assert.equal(response.status,503);assert.equal((await response.json()).code,'PUBLIC_MARKET_INGESTION_DISABLED');
});
