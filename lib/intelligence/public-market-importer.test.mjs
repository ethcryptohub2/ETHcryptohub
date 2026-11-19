import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import ts from 'typescript';
import * as tailer from './public-market-tailer.ts';
import * as projection from './public-market-projection.ts';

const filename = path.resolve('lib/intelligence/public-market-importer.ts');
const mod = new Module(filename);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));
mod.require=key=>key==='./public-market-tailer'?tailer:key==='./public-market-projection'?projection:Module.createRequire(filename)(key);
mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const {PublicMarketImporter,validatePublicMarketBatch}=mod.exports;
const at=1_800_000_000_000;
const sample=(changes={})=>({symbol:'BTCUSDT',source:'BINANCE_USDM',eventTime:at,receivedAt:at,price:100,bid:99,ask:101,
  quoteVolume:400,buyQuoteVolume:200,sellQuoteVolume:200,bidDepth:1000,askDepth:1100,fresh:true,sequenceValid:true,feedEpoch:1,
  requiredInputTimes:{ticker:at,trade:at-100,depth:at-200},...changes});
function batch(observation=sample(),from=null,sequence=1) {
  const envelope={version:1,runId:1,epoch:observation.feedEpoch,sequence,observation};
  const to={version:1,runId:1,epoch:envelope.epoch,segment:0,byteOffset:sequence*1000,sequence,lineHash:tailer.marketJournalEnvelopeHash(envelope)};
  const records=[{envelope,cursor:to}];return {version:1,batchId:tailer.marketJournalBatchId(from,to,records),from,to,records};
}
const acknowledgement=b=>({batchId:b.batchId,cursor:b.to,duplicate:false});

test('bounded importer validates public evidence and invokes only its injected source-bound sink',async()=>{
  const calls=[],sink={commit:async(...args)=>{calls.push(args);return acknowledgement(args[1]);}};
  const importer=new PublicMarketImporter('BINANCE_USDM_STAGING',sink,{maxBatches:1,maxBytes:1024*1024});
  const first=batch();assert.equal(importer.enqueue(first,at).duplicate,false);assert.equal(importer.enqueue(first,at).duplicate,true);
  const second=batch(sample({eventTime:at+1,receivedAt:at+1,requiredInputTimes:{ticker:at+1,trade:at,depth:at}}),first.to,2);
  assert.throws(()=>importer.enqueue(second,at+1),/BACKPRESSURE/);
  first.records[0].envelope.observation.price=500;
  const result=await importer.flushOne(at+100);
  assert.equal(result.batchId,calls[0][1].batchId);assert.equal(calls[0][0],'BINANCE_USDM_STAGING');
  assert.equal(calls[0][1].records[0].envelope.observation.price,100);assert.equal(importer.health().queuedBatches,0);
  assert.equal(importer.health().remoteTransportActivated,false);
});

test('missing oldest-input evidence, secret fields, tampering and cursor gaps fail before persistence',()=>{
  for(const changes of [{requiredInputTimes:undefined},{requiredInputTimes:{ticker:at,trade:at-5001,depth:at}},
    {requiredInputTimes:{ticker:at+1,trade:at,depth:at}},{apiKey:'fixture-only'},{sequenceValid:false}]) {
    assert.throws(()=>validatePublicMarketBatch(batch(sample(changes)),at));
  }
  const tampered=batch();tampered.records[0].envelope.observation.price=500;
  assert.throws(()=>validatePublicMarketBatch(tampered,at),/HASH_MISMATCH/);
  const wrong=batch();wrong.tenantId=2;assert.throws(()=>validatePublicMarketBatch(wrong,at),/INVALID_PUBLIC_BATCH/);
  const first=batch();const gap=batch(sample(),first.to,3);assert.throws(()=>validatePublicMarketBatch(gap,at),/GAP/);
});

test('sink outage, lost commit response and wrong acknowledgements keep original pending identity',async()=>{
  let mode='outage',calls=0;
  const importer=new PublicMarketImporter('BINANCE_USDM_STAGING',{commit:async(_source,b)=>{
    calls++;if(mode==='outage')throw Error('ambiguous commit response');
    return mode==='badAck'?{...acknowledgement(b),batchId:'0'.repeat(64)}:{...acknowledgement(b),duplicate:true};
  }});
  const first=batch();importer.enqueue(first,at);
  await assert.rejects(importer.flushOne(at),/ambiguous/);assert.equal(calls,1);assert.equal(importer.health().queuedBatches,1);
  mode='badAck';await assert.rejects(importer.flushOne(at),/ACK_CONFLICT/);assert.equal(importer.health().queuedBatches,1);
  mode='recovered';assert.equal((await importer.flushOne(at+100)).duplicate,true);assert.equal(importer.health().queuedBatches,0);
});

test('historical coherent batches remain historical and oldest required input bounds current freshness',()=>{
  const validated=validatePublicMarketBatch(batch(),at+60_000);
  const state=new projection.PublicMarketProjection(['BTCUSDT'],['BTCUSDT']);
  const row=validated.records[0].envelope.observation;state.ingest(row,row.receivedAt);
  assert.equal(state.view(at+100).rows[0].freshnessVerified,true);
  assert.equal(state.view(at+4900).rows[0].freshnessVerified,false); // depth is already 5100ms old
  assert.equal(state.view(at+4900).rows[0].state,'STALE');
  assert.equal(state.view(at+4900).rows[0].price,null);
  assert.equal(state.view(at+60_000).rows[0].price,null);assert.deepEqual(state.view(at).candidates,[]);
  const restored=projection.PublicMarketProjection.restore(state.checkpoint(),at+60_000);
  assert.equal(restored.view(at+60_000).rows[0].freshnessVerified,false);
});

test('concurrent flushes never submit the same queue head simultaneously',async()=>{
  let resume;const held=new Promise(resolve=>{resume=resolve;});
  const importer=new PublicMarketImporter('BINANCE_USDM_STAGING',{commit:async(_source,b)=>{await held;return acknowledgement(b);}});
  importer.enqueue(batch(),at);const pending=importer.flushOne(at);
  await assert.rejects(importer.flushOne(at),/ALREADY_RUNNING/);resume();await pending;
});
