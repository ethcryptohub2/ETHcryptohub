// Local persistent-disk helpers only. No network, database or secrets.
import fs from 'node:fs/promises';
import path from 'node:path';

/** Single-writer segmented journal. Call only while the worker's exclusive lock is held. */
export async function openObservationJournal(directory, { segmentBytes=16*1024*1024, segments=8, io=fs, runId }={}) {
  if (!Number.isSafeInteger(segmentBytes)||segmentBytes<1024||segmentBytes>100*1024*1024||!Number.isInteger(segments)||segments<2||segments>32) throw Error('INVALID_RETENTION_BOUNDS');
  if(runId!==undefined&&(!Number.isSafeInteger(runId)||runId<1))throw Error('INVALID_JOURNAL_RUN_ID');
  const pattern=/^observations\.([0-9]{12})\.ndjson$/;
  const entries=(await io.readdir(directory)).filter(name=>pattern.test(name)).sort();
  let sequence=entries.length?Number(pattern.exec(entries.at(-1))[1]):0;
  // Never delete unrelated files or legacy observations.ndjson.
  let handle, size=0;
  const open=async()=>{
    const name=`observations.${String(sequence).padStart(12,'0')}.ndjson`,file=path.join(directory,name);
    handle=await io.open(file,'a+',0o600);size=(await handle.stat()).size;
    if(size>segmentBytes){await handle.close();throw Error('EXISTING_SEGMENT_EXCEEDS_BOUND');}
    if(size){const tail=Buffer.alloc(1);await handle.read(tail,0,1,size-1);if(tail[0]!==10){await handle.close();throw Error('JOURNAL_INCOMPLETE_TAIL_REQUIRES_REVIEW');}}
  };
  await open();
  if(runId!==undefined) {
    try {
      // A new run must not append legacy rows or reuse an old process identity.
      // Search backwards across a possible empty last segment after a crash.
      for(const name of [...entries].reverse()) {
        const previous=await io.open(path.join(directory,name),'r');
        try {
          const stat=await previous.stat();if(!stat.size)continue;
          const length=Math.min(stat.size,1024*1024),buffer=Buffer.alloc(length);
          await previous.read(buffer,0,length,stat.size-length);
          if(buffer.at(-1)!==10)throw Error('JOURNAL_INCOMPLETE_TAIL_REQUIRES_REVIEW');
          const begin=buffer.lastIndexOf(10,buffer.length-2)+1;
          const last=JSON.parse(buffer.subarray(begin,buffer.length-1).toString('utf8'));
          if(last.version!==1||!Number.isSafeInteger(last.runId)||last.runId>=runId||!Number.isSafeInteger(last.sequence)||last.sequence<1||!last.observation)throw Error('JOURNAL_LEGACY_OR_RUN_REUSE_REQUIRES_REVIEW');
          break;
        } finally {await previous.close();}
      }
    } catch(error) {await handle.close();throw error;}
  }
  let recordSequence=0;
  let closed=false, poisoned=false, pending=Promise.resolve(), closing;
  return {
    write(observation) {
      if(closed)return Promise.reject(Error('JOURNAL_CLOSED'));
      if(poisoned)return Promise.reject(Error('JOURNAL_POISONED_REQUIRES_REVIEW'));
      const operation=pending.then(async()=>{
      if(poisoned)throw Error('JOURNAL_POISONED_REQUIRES_REVIEW');
      if(runId!==undefined&&(!Number.isSafeInteger(observation?.feedEpoch)||observation.feedEpoch<0))throw Error('INVALID_JOURNAL_FEED_EPOCH');
      if(!Number.isSafeInteger(recordSequence+1))throw Error('JOURNAL_RECORD_SEQUENCE_EXHAUSTED');
      const value=runId===undefined?observation:{version:1,runId,epoch:observation.feedEpoch,sequence:recordSequence+1,observation};
      const row=JSON.stringify(value)+'\n';const bytes=Buffer.byteLength(row);
      if(bytes>segmentBytes)throw Error('OBSERVATION_EXCEEDS_SEGMENT');
      if(size+bytes>segmentBytes) {
        await handle.close();if(++sequence>999999999999)throw Error('JOURNAL_SEQUENCE_EXHAUSTED');await open();
      }
      await handle.writeFile(row);await handle.sync();size+=bytes;recordSequence++;
      const names=(await io.readdir(directory)).filter(name=>pattern.test(name)).sort();
      for(const name of names.slice(0,Math.max(0,names.length-segments))) await io.unlink(path.join(directory,name));
      });
      pending=operation.catch(error=>{poisoned=true;throw error;});
      return pending;
    },
    close(){if(!closing){closed=true;closing=pending.catch(()=>{}).then(()=>handle.close());}return closing;},
    bounds:{segmentBytes,segments,maxObservationBytes:segmentBytes*segments},
  };
}

export async function writeHealth(directory, health, now=Date.now()) {
  const target=path.join(directory,'health.json'), temporary=path.join(directory,'health.next');
  const handle=await fs.open(temporary,'w',0o600);
  try{await handle.writeFile(JSON.stringify({version:1,at:now,...health}));await handle.sync();}finally{await handle.close();}
  await fs.rename(temporary,target);
}

/** Liveness and readiness deliberately differ: a connected but stale feed is not ready. */
export function assessWorkerHealth(value,now=Date.now()) {
  if(!value||value.version!==1||!Number.isSafeInteger(value.at)||value.at>now||now-value.at>45_000)return {live:false,ready:false,reason:'HEARTBEAT_MISSING_OR_STALE'};
  const live=value.running===true;
  const ready=live&&value.sinkHealthy===true&&Array.isArray(value.connections)&&value.connections.length>0&&value.connections.every(c=>c.connected===true)&&value.researchCoverage?.selected>0&&value.researchCoverage.fresh===value.researchCoverage.selected&&value.queueOldestAgeMs<=1000;
  return {live,ready,reason:ready?'SELECTED_COVERAGE_FRESH':live?'FEED_NOT_READY':'WORKER_STOPPED'};
}
