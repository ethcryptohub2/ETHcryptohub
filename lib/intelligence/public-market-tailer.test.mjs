import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PublicMarketTailer, marketJournalEnvelopeHash, marketJournalBatchId } from './public-market-tailer.ts';
import { openObservationJournal } from '../../scripts/market-worker-storage.mjs';

const name=n=>`observations.${String(n).padStart(12,'0')}.ndjson`;
const observation=(symbol='BTCUSDT',feedEpoch=1)=>({symbol,source:'BINANCE_USDM',feedEpoch,eventTime:1000,receivedAt:1000,
  price:100,bid:99,ask:101,quoteVolume:10,buyQuoteVolume:6,sellQuoteVolume:4,bidDepth:100,askDepth:100,fresh:true,sequenceValid:true,
  requiredInputTimes:{ticker:1000,trade:1000,depth:1000}});
const envelope=(sequence=1,runId=1,epoch=1)=>({version:1,runId,epoch,sequence,observation:observation('BTCUSDT',epoch)});
async function temporary(work) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'smartexit-durable-tailer-'));
  try {await work(dir);} finally {await fs.rm(dir,{recursive:true,force:true});}
}

test('actual journal envelopes tail with stable batches, explicit ack and durable cursor restart',async()=>temporary(async dir=>{
  const journal=await openObservationJournal(dir,{runId:1});
  await journal.write(observation());await journal.write(observation('ETHUSDT',0));await journal.close();
  const tailer=new PublicMarketTailer(dir,null,{maxRecords:1});
  const first=await tailer.read();assert.equal(first.records.length,1);assert.equal(first.from,null);
  assert.equal(tailer.acknowledgedCursor(),null);
  first.records[0].envelope.observation.price=999;
  const repeated=await tailer.read();assert.equal(repeated.records[0].envelope.observation.price,100);
  assert.equal(repeated.batchId,first.batchId);assert.throws(()=>tailer.acknowledge('wrong'),/ACK_CONFLICT/);
  // Simulated atomic sink persists its projection and cursor before source ack.
  const sink={projection:repeated.records,cursor:repeated.to};
  await fs.writeFile(path.join(dir,'sink-checkpoint.json'),JSON.stringify(sink));
  tailer.acknowledge(repeated.batchId);
  const saved=JSON.parse(await fs.readFile(path.join(dir,'sink-checkpoint.json'),'utf8'));
  const restart=new PublicMarketTailer(dir,saved.cursor);
  const second=await restart.read();assert.equal(second.records[0].envelope.sequence,2);
  assert.equal(second.records[0].envelope.epoch,0); // Per-symbol epochs need not globally increase.
  restart.acknowledge(second.batchId);assert.equal(await restart.read(),null);
}));

test('new run restarts sequence while duplicate run ids and legacy append are refused',async()=>temporary(async dir=>{
  let journal=await openObservationJournal(dir,{runId:1});await journal.write(observation());await journal.close();
  await assert.rejects(openObservationJournal(dir,{runId:1}),/RUN_REUSE/);
  journal=await openObservationJournal(dir,{runId:3});await journal.write(observation('BTCUSDT',3));await journal.close();
  const batch=await new PublicMarketTailer(dir).read();assert.deepEqual(batch.records.map(r=>[r.envelope.runId,r.envelope.sequence]),[[1,1],[3,1]]);
  const other=path.join(dir,'legacy');await fs.mkdir(other);await fs.writeFile(path.join(other,name(0)),JSON.stringify(observation())+'\n');
  await assert.rejects(openObservationJournal(other,{runId:1}),/LEGACY/);
  await assert.rejects(new PublicMarketTailer(other).read(),/LEGACY/);
}));

test('partial current line stays unacknowledged and recovers only after its complete newline',async()=>temporary(async dir=>{
  const one=JSON.stringify(envelope(1))+'\n',two=JSON.stringify(envelope(2));
  await fs.writeFile(path.join(dir,name(0)),one+two.slice(0,80));
  const tailer=new PublicMarketTailer(dir),first=await tailer.read();assert.equal(first.records.length,1);
  tailer.acknowledge(first.batchId);assert.equal(await tailer.read(),null);
  await fs.appendFile(path.join(dir,name(0)),two.slice(80)+'\n');
  const complete=await tailer.read();assert.equal(complete.records[0].envelope.sequence,2);
  assert.equal(complete.from.byteOffset,Buffer.byteLength(one));
}));

test('rotation continuity succeeds but retention gaps, missing segments and incomplete sealed lines fail closed',async()=>temporary(async dir=>{
  const journal=await openObservationJournal(dir,{runId:1,segmentBytes:1024,segments:8});
  for(let i=0;i<6;i++)await journal.write(observation());await journal.close();
  const tailer=new PublicMarketTailer(dir),batch=await tailer.read();assert.equal(batch.records.length,6);
  assert.ok(batch.to.segment>0);tailer.acknowledge(batch.batchId);
  await fs.unlink(path.join(dir,name(batch.to.segment)));await assert.rejects(tailer.read(),/RETENTION_GAP/);
  await fs.unlink(path.join(dir,name(0)));await assert.rejects(new PublicMarketTailer(dir).read(),/RETENTION_GAP/);
  const broken=path.join(dir,'broken');await fs.mkdir(broken);
  await fs.writeFile(path.join(broken,name(0)),JSON.stringify(envelope()).slice(0,20));
  await fs.writeFile(path.join(broken,name(1)),JSON.stringify(envelope(2))+'\n');
  await assert.rejects(new PublicMarketTailer(broken).read(),/INCOMPLETE_SEALED/);
}));

test('cursor anchor corruption, truncation, oversized rows and sequence jumps never advance ack',async()=>temporary(async dir=>{
  const file=path.join(dir,name(0)),one=JSON.stringify(envelope())+'\n';await fs.writeFile(file,one);
  const tailer=new PublicMarketTailer(dir),batch=await tailer.read();const cursor=tailer.acknowledge(batch.batchId);
  await fs.writeFile(file,one.replace('"price":100','"price":101'));
  await assert.rejects(new PublicMarketTailer(dir,cursor).read(),/ANCHOR_CHANGED/);
  await fs.writeFile(file,'');await assert.rejects(new PublicMarketTailer(dir,cursor).read(),/TRUNCATED/);
  await fs.writeFile(file,JSON.stringify(envelope(3))+'\n');await assert.rejects(new PublicMarketTailer(dir).read(),/INITIAL_SEQUENCE_GAP/);
  await fs.writeFile(file,'x'.repeat(2000)+'\n');
  await assert.rejects(new PublicMarketTailer(dir,null,{maxLineBytes:512,maxBytes:2048}).read(),/LINE_OVERSIZED/);
}));

test('semantic hashes bind payload despite key order and batch ids bind acknowledged cursor',()=>{
  const row=envelope(),reordered=Object.fromEntries(Object.entries(row).reverse());
  assert.equal(marketJournalEnvelopeHash(row),marketJournalEnvelopeHash(reordered));
  assert.notEqual(marketJournalEnvelopeHash(row),marketJournalEnvelopeHash({...row,observation:{...row.observation,price:101}}));
  const cursor={version:1,runId:1,epoch:1,segment:0,byteOffset:400,sequence:1,lineHash:marketJournalEnvelopeHash(row)};
  const records=[{envelope:row,cursor}];assert.equal(marketJournalBatchId(null,cursor,records),marketJournalBatchId(null,{...cursor},records));
  assert.notEqual(marketJournalBatchId(null,cursor,records),marketJournalBatchId(cursor,cursor,records));
});
