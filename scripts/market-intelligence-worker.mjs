// Persistent Node24 process, not a Vercel function/CRON entry point.
// Merely importing this script never activates network ingestion.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BinanceMarketFeed, BoundedMarketQueue, discoverEligibleSymbols } from '../lib/intelligence/market-feed.ts';
import { PublicMarketWorker } from '../lib/intelligence/market-worker.ts';
import { openObservationJournal, writeHealth } from './market-worker-storage.mjs';

export async function activateApprovedWorker(env = process.env, args = process.argv.slice(2)) {
  if (!args.includes('--activate-approved-worker') || env.SMARTEXIT_MARKET_WORKER_APPROVAL !== 'START_STAGING_PUBLIC_MARKET_WORKER' || env.SMARTEXIT_DEPLOYMENT_ENV !== 'staging' || env.VERCEL) throw new Error('Separate persistent Staging worker activation approval is required.');
  const symbols=(env.SMARTEXIT_MARKET_SYMBOLS??'').split(',').map(x=>x.trim()).filter(Boolean);
  if (!symbols.length||symbols.length>200) throw new Error('An explicit 1–200 discovered-symbol coverage list is required.');
  const directory=path.resolve(env.SMARTEXIT_MARKET_OUTPUT_DIRECTORY??'storage/market-intelligence');
  await fs.mkdir(directory,{recursive:true});
  const lock=path.join(directory,'worker.lock');
  const lockHandle=await fs.open(lock,'wx');
  let journal;
  let worker;
  let publishing=false;
  let healthWrite=Promise.resolve();
  let stopped=false;
  let stopping;
  const stop=async()=>{
    if(stopping)return stopping;stopped=true;
    stopping=(async()=>{
    worker?.stop();
    await healthWrite.catch(()=>{});
    await journal?.close();
    if(worker)await writeHealth(directory,worker.health());
    await lockHandle.close();await fs.unlink(lock);
    })();
    return stopping;
  };
  const stopSafely=()=>{void stop().catch(()=>{process.exitCode=1;console.error('Worker cleanup failed; retained state requires operator review.');});};
  try {
    const epochPath=path.join(directory,'epoch.json');
    let epoch=0;
    try { const saved=JSON.parse(await fs.readFile(epochPath,'utf8'));if(!Number.isSafeInteger(saved.run)||saved.run<0)throw new Error('Invalid epoch journal');epoch=saved.run; }
    catch(error){if(error?.code!=='ENOENT')throw error;}
    epoch++;
    if(!Number.isSafeInteger(epoch*1_000_000)||epoch*1_000_000>Number.MAX_SAFE_INTEGER-1_000_000)throw new Error('Epoch capacity exhausted');
    const epochTemp=path.join(directory,'epoch.next');
    const epochHandle=await fs.open(epochTemp,'w');
    try {await epochHandle.writeFile(JSON.stringify({run:epoch}));await epochHandle.sync();}finally{await epochHandle.close();}
    await fs.rename(epochTemp,epochPath);
    journal=await openObservationJournal(directory);
    worker=new PublicMarketWorker({
      fetch:globalThis.fetch,
      connect:url=>new WebSocket(url),
      sink:async observation=>{
        await journal.write(observation);
      },
      now:Date.now,
      timer:{set:(fn,ms)=>setTimeout(fn,ms),clear:id=>clearTimeout(id)},
      discover:discoverEligibleSymbols,
      makeFeed:all=>new BinanceMarketFeed(all,5000,1000,256,epoch*1_000_000),
      makeQueue:()=>new BoundedMarketQueue(),
    },symbols);
    await worker.start({activationApproved:true,environment:'staging-worker'});
    await writeHealth(directory,worker.health());
    const healthTimer=setInterval(()=>{
      if(publishing||stopped)return;publishing=true;
      const h=worker.health();
      healthWrite=writeHealth(directory,h);
      void healthWrite.then(()=>{console.log(JSON.stringify({at:new Date().toISOString(),running:h.running,tickerCoverage:h.tickerCoverage,researchCoverage:h.researchCoverage,queue:h.queueSize,queueOldestAgeMs:h.queueOldestAgeMs,failures:h.failures}));}).catch(()=>{process.exitCode=1;clearInterval(healthTimer);stopSafely();}).finally(()=>{publishing=false;});
    },15_000);
    process.once('SIGINT',()=>{clearInterval(healthTimer);stopSafely();});
    process.once('SIGTERM',()=>{clearInterval(healthTimer);stopSafely();});
    return {worker,stop:async()=>{clearInterval(healthTimer);await stop();}};
  }catch(error){await stop();throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  activateApprovedWorker().catch(()=>{console.error('Market worker did not start. Check approval, coverage, journal lock and public provider availability; no credentials/orders are used.');process.exitCode=1;});
}
