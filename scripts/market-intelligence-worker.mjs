// Persistent Node24 process, not a Vercel function/CRON entry point.
// Merely importing this script never activates network ingestion.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BinanceMarketFeed, BoundedMarketQueue, discoverEligibleSymbols } from '../lib/intelligence/market-feed.ts';
import { PublicMarketWorker, subscriptionPlan } from '../lib/intelligence/market-worker.ts';
import { openObservationJournal, writeHealth } from './market-worker-storage.mjs';

export function assertPublicWorkerEnvironment(env) {
  // Deploy a minimal standalone bundle, never the web application's .env or
  // service identity. Reject accidental credential inheritance before any I/O.
  if (Object.entries(env).some(([key,value]) => value && /SECRET|TOKEN|PASSWORD|CREDENTIAL|DATABASE|SUPABASE|SMTP|WEB_PUSH|AUTH_|(?:^|_)API_KEY|(?:^|_)PRIVATE_KEY|^(?:BINANCE|BYBIT|OKX|GATE)_/i.test(key))) {
    throw new Error('Public market worker environment must not contain application or trading credentials.');
  }
}

/** Injection is for finite local fixtures only; defaults retain real transports behind approval. */
export async function activateApprovedWorker(env = process.env, args = process.argv.slice(2), overrides = {}) {
  if (!args.includes('--activate-approved-worker') || env.SMARTEXIT_MARKET_WORKER_APPROVAL !== 'START_STAGING_PUBLIC_MARKET_WORKER' || env.SMARTEXIT_DEPLOYMENT_ENV !== 'staging' || env.VERCEL) throw new Error('Separate persistent Staging worker activation approval is required.');
  assertPublicWorkerEnvironment(env);
  const symbols=(env.SMARTEXIT_MARKET_SYMBOLS??'').split(',').map(x=>x.trim()).filter(Boolean);
  if (!symbols.length||symbols.length>200) throw new Error('An explicit 1–200 discovered-symbol coverage list is required.');
  subscriptionPlan(symbols);
  const runtime={fetch:globalThis.fetch,connect:url=>new WebSocket(url),now:Date.now,
    timer:{set:(fn,ms)=>setTimeout(fn,ms),clear:id=>clearTimeout(id)},
    every:setInterval,clearEvery:clearInterval,signals:process,
    fail:()=>{process.exitCode=1;},log:console.log,error:console.error,...overrides};
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
  let healthTimer;
  let epoch=0;
  let finishStartup;
  const startupFinished=new Promise(resolve=>{finishStartup=resolve;});
  const health=()=>({runId:epoch,...worker.health()});
  const stop=async()=>{
    if(stopping)return stopping;stopped=true;
    worker?.stop();
    stopping=(async()=>{
    await startupFinished;
    if(healthTimer!==undefined)runtime.clearEvery(healthTimer);
    runtime.signals.off('SIGINT',stopSafely);runtime.signals.off('SIGTERM',stopSafely);
    worker?.stop();
    await healthWrite.catch(()=>{});
    await journal?.close();
    if(worker)await writeHealth(directory,health(),runtime.now());
    await lockHandle.close();await fs.unlink(lock);
    })();
    return stopping;
  };
  const stopSafely=()=>{void stop().catch(()=>{runtime.fail();runtime.error('Worker cleanup failed; retained state requires operator review.');});};
  runtime.signals.once('SIGINT',stopSafely);runtime.signals.once('SIGTERM',stopSafely);
  try {
    const epochPath=path.join(directory,'epoch.json');
    try { const saved=JSON.parse(await fs.readFile(epochPath,'utf8'));if(!Number.isSafeInteger(saved.run)||saved.run<0)throw new Error('Invalid epoch journal');epoch=saved.run; }
    catch(error){if(error?.code!=='ENOENT')throw error;}
    epoch++;
    if(!Number.isSafeInteger(epoch*1_000_000)||epoch*1_000_000>Number.MAX_SAFE_INTEGER-1_000_000)throw new Error('Epoch capacity exhausted');
    const epochTemp=path.join(directory,'epoch.next');
    const epochHandle=await fs.open(epochTemp,'w');
    try {await epochHandle.writeFile(JSON.stringify({run:epoch}));await epochHandle.sync();}finally{await epochHandle.close();}
    await fs.rename(epochTemp,epochPath);
    if(stopped)throw new Error('Worker startup cancelled.');
    journal=await openObservationJournal(directory);
    if(stopped)throw new Error('Worker startup cancelled.');
    worker=new PublicMarketWorker({
      fetch:runtime.fetch,
      connect:runtime.connect,
      sink:async observation=>{
        await journal.write(observation);
      },
      now:runtime.now,
      timer:runtime.timer,
      discover:discoverEligibleSymbols,
      makeFeed:all=>new BinanceMarketFeed(all,5000,1000,256,epoch*1_000_000),
      makeQueue:()=>new BoundedMarketQueue(),
    },symbols);
    await worker.start({activationApproved:true,environment:'staging-worker'});
    if(stopped)throw new Error('Worker startup cancelled.');
    await writeHealth(directory,health(),runtime.now());
    healthTimer=runtime.every(()=>{
      if(publishing||stopped)return;publishing=true;
      const h=health();
      healthWrite=writeHealth(directory,h,runtime.now());
      void healthWrite.then(()=>{runtime.log(JSON.stringify({at:new Date(runtime.now()).toISOString(),runId:h.runId,running:h.running,tickerCoverage:h.tickerCoverage,researchCoverage:h.researchCoverage,queue:h.queueSize,queueOldestAgeMs:h.queueOldestAgeMs,failures:h.failures}));}).catch(()=>{runtime.fail();runtime.clearEvery(healthTimer);stopSafely();}).finally(()=>{publishing=false;});
    },15_000);
    finishStartup();
    return {worker,stop};
  }catch(error){finishStartup();await stop();throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  activateApprovedWorker().catch(()=>{console.error('Market worker did not start. Check approval, coverage, journal lock and public provider availability; no credentials/orders are used.');process.exitCode=1;});
}
