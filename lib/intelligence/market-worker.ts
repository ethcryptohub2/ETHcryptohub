import type { MarketObservation } from './contracts';
import type { BinanceMarketFeed, BoundedMarketQueue } from './market-feed';

export const MARKET_WS = 'wss://fstream.binance.com/market/stream';
export const PUBLIC_WS = 'wss://fstream.binance.com/public/stream';
export const PUBLIC_REST = 'https://fapi.binance.com';
const MAX_CONNECTION_MS = 23 * 60 * 60_000;
export interface MarketSocket {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
  close(): void;
}
export interface WorkerTimer { set(callback: () => void, delay: number): unknown; clear(id: unknown): void }
export interface WorkerDependencies {
  fetch: typeof fetch;
  connect: (url: string) => MarketSocket;
  sink: (observation: MarketObservation) => Promise<void>;
  now: () => number;
  timer: WorkerTimer;
  discover: (body: unknown) => string[];
  makeFeed: (symbols: string[]) => BinanceMarketFeed;
  makeQueue: () => BoundedMarketQueue;
}

/** Explicit sharding; trade/book coverage is selected, all-market ticker discovery is shared. */
export function subscriptionPlan(trackedSymbols: readonly string[], shardSize = 100) {
  if (!trackedSymbols.length || trackedSymbols.length > 200 || new Set(trackedSymbols).size !== trackedSymbols.length || trackedSymbols.some(x => !/^[\p{L}\p{N}_]{1,40}$/u.test(x) || x !== x.toUpperCase()) || !Number.isInteger(shardSize) || shardSize < 1 || shardSize > 100) throw new Error('INVALID_SUBSCRIPTION_PLAN');
  const result: Array<{url:string;symbols:string[];kind:'ticker'|'trades'|'depth'}> = [{ url: `${MARKET_WS}?streams=!ticker@arr/!markPrice@arr@1s`, symbols: [...trackedSymbols], kind: 'ticker' }];
  for (let offset=0;offset<trackedSymbols.length;offset+=shardSize) {
    const symbols = trackedSymbols.slice(offset,offset+shardSize);
    result.push({ url: `${MARKET_WS}?streams=${symbols.map(x=>`${encodeURIComponent(x.toLowerCase())}@aggTrade`).join('/')}`, symbols, kind: 'trades' });
    result.push({ url: `${PUBLIC_WS}?streams=${symbols.map(x=>`${encodeURIComponent(x.toLowerCase())}@depth@100ms`).join('/')}`, symbols, kind: 'depth' });
  }
  return result;
}

type Connection = { socket: MarketSocket; url: string; symbols: string[]; openedAt: number; lastMessageAt: number; generation: number; attempt: number; retry: unknown; live: boolean };

/** Long-lived process service, deliberately not imported/started by any Vercel route. */
export class PublicMarketWorker {
  private deps: WorkerDependencies;
  private trackedSymbols: string[];
  private running = false;
  private starting = false;
  private queue: BoundedMarketQueue;
  private feed: BinanceMarketFeed | null = null;
  private connections: Connection[] = [];
  private cycleTimer: unknown;
  private processing = false;
  private nextRestAt = 0;
  private restWindow = 0;
  private restWeight = 0;
  private snapshotsAt = new Map<string, number>();
  private failedSinkSymbols = new Set<string>();
  private lifecycle = 0;
  private synchronization = 0;
  private lastCycleAt: number | null = null;
  private lastCycleDurationMs = 0;
  private lastSinkAt: number | null = null;
  private maxSinkDurationMs = 0;
  private processedFrames = 0;
  private failures = { malformedFrames:0, disconnects:0, sinkFailures:0, snapshotFailures:0, restRateLimits:0, backpressure:0 };
  constructor(deps: WorkerDependencies, trackedSymbols: string[]) { this.deps=deps;this.trackedSymbols=[...trackedSymbols];this.queue=deps.makeQueue(); subscriptionPlan(trackedSymbols); }
  private async get(path: string, weight: number) {
    const now=this.deps.now();
    if (now<this.nextRestAt) throw new Error('REST_BACKOFF_ACTIVE');
    if (now-this.restWindow>=60_000) { this.restWindow=now; this.restWeight=0; }
    if (this.restWeight+weight>300) throw new Error('LOCAL_REST_WEIGHT_LIMIT');
    this.restWeight+=weight; this.nextRestAt=now+1000;
    const url=new URL(path,PUBLIC_REST);
    if (url.origin!==PUBLIC_REST || !['/fapi/v1/exchangeInfo','/fapi/v1/depth'].includes(url.pathname)) throw new Error('PUBLIC_ENDPOINT_REQUIRED');
    const response=await this.deps.fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10_000)});
    if (response.status===429 || response.status===418) {
      const seconds=Number(response.headers.get('retry-after'));
      this.nextRestAt=now+Math.max(60_000,Math.min(15*60_000,Number.isFinite(seconds)&&seconds>0?seconds*1000:60_000));
      this.failures.restRateLimits++; throw new Error('PROVIDER_RATE_LIMIT');
    }
    const usedWeight=Number(response.headers.get('x-mbx-used-weight-1m'));
    if (Number.isFinite(usedWeight)&&usedWeight>=2000) this.nextRestAt=now+60_000;
    if (!response.ok) throw new Error(`PUBLIC_HTTP_${response.status}`);
    const contentLength=Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength)&&contentLength>4*1024*1024) throw new Error('REST_RESPONSE_TOO_LARGE');
    if(!response.body)throw new Error('EMPTY_PUBLIC_RESPONSE');
    const reader=response.body.getReader();const decoder=new TextDecoder();let text='';let total=0;
    try {
      while(true){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>4*1024*1024){await reader.cancel();throw new Error('REST_RESPONSE_TOO_LARGE');}text+=decoder.decode(next.value,{stream:true});}
      text+=decoder.decode();
    }finally{reader.releaseLock();}
    return JSON.parse(text) as unknown;
  }
  async start(approval: { activationApproved: boolean; environment: 'local-replay' | 'staging-worker' }) {
    if (approval.activationApproved!==true || !['local-replay','staging-worker'].includes(approval.environment)) throw new Error('SEPARATE_WORKER_ACTIVATION_APPROVAL_REQUIRED');
    if (this.running) throw new Error('WORKER_ALREADY_RUNNING');
    if (this.starting) throw new Error('WORKER_START_PENDING');
    if (this.processing) throw new Error('WORKER_STOP_PENDING');
    this.starting=true;
    const startLifecycle=this.lifecycle;
    try {
    const universe=this.deps.discover(await this.get('/fapi/v1/exchangeInfo',1));
    if (startLifecycle!==this.lifecycle) throw new Error('WORKER_START_CANCELLED');
    if (this.trackedSymbols.some(x=>!universe.includes(x))) throw new Error('UNDISCOVERED_TRACKED_SYMBOL');
    this.feed=this.deps.makeFeed(universe);
    this.connections=[];this.queue.clear();this.snapshotsAt.clear();this.failedSinkSymbols.clear();this.lifecycle++;
    this.running=true;
    for (const plan of subscriptionPlan(this.trackedSymbols)) {
      const c: Connection={...plan,socket:null as unknown as MarketSocket,openedAt:this.deps.now(),lastMessageAt:this.deps.now(),generation:0,attempt:0,retry:null,live:false};
      this.connections.push(c); this.open(c);
    }
    this.schedule();
    } finally { this.starting=false; }
  }
  private open(c: Connection) {
    if (!this.running) return;
    const generation=++c.generation;
    c.live=false; c.openedAt=this.deps.now(); c.lastMessageAt=this.deps.now();
    try {
      c.socket=this.deps.connect(c.url);
      c.socket.addEventListener('open',()=>{ if (this.running&&generation===c.generation) { c.live=true; } });
      c.socket.addEventListener('message',event=>{
        if (!this.running||generation!==c.generation) return;
        // Successful frames, not TCP-open alone, eventually reset reconnect backoff.
        if (typeof event.data!=='string') { this.failures.malformedFrames++; this.disconnect(c); return; }
        const bytes=new TextEncoder().encode(event.data).byteLength;
        if (bytes>4*1024*1024) { this.failures.malformedFrames++; this.disconnect(c); return; }
        let payload: unknown;
        try { payload=JSON.parse(event.data); } catch { this.failures.malformedFrames++; this.disconnect(c); return; }
        c.lastMessageAt=this.deps.now();
        if (!this.queue.enqueue({payload,receivedAt:this.deps.now(),bytes})) {
          this.synchronization++;
          this.failures.backpressure++; this.queue.clear(); this.feed?.invalidateAll('BACKPRESSURE_RESYNC_REQUIRED',this.deps.now());
          for (const tracked of this.trackedSymbols) this.snapshotsAt.delete(tracked);
        }
        if (this.deps.now()-c.openedAt>60_000) c.attempt=0;
      });
      c.socket.addEventListener('close',()=>{ if (generation===c.generation) this.disconnect(c); });
      c.socket.addEventListener('error',()=>{ if (generation===c.generation) this.disconnect(c); });
    } catch { this.disconnect(c); }
  }
  private disconnect(c: Connection) {
    if (!this.running||c.retry!==null) return;
    c.generation++; c.live=false; this.failures.disconnects++;
    this.synchronization++;
    try { c.socket?.close(); } catch { /* no data inferred from a broken socket */ }
    // Aggregate-trade continuity cannot be repaired by a depth snapshot.
    this.queue.clear();this.feed?.invalidateAll('DISCONNECTED',this.deps.now());
    for (const symbol of this.trackedSymbols) this.snapshotsAt.delete(symbol);
    const delay=Math.min(60_000,1000*2**Math.min(c.attempt++,6));
    c.retry=this.deps.timer.set(()=>{c.retry=null;this.open(c);},delay);
  }
  private schedule() { const lifecycle=this.lifecycle;if (this.running) this.cycleTimer=this.deps.timer.set(()=>{ if(this.running&&lifecycle===this.lifecycle)void this.cycle().finally(()=>{if(lifecycle===this.lifecycle)this.schedule();}); },100); }
  /** Public for deterministic replay tests; timer and network are dependency-injected. */
  async cycle() {
    if (!this.running||!this.feed||this.processing) return;
    const lifecycle=this.lifecycle;
    const cycleStarted=this.deps.now();
    this.processing=true;
    try {
      for (const c of this.connections) if (this.deps.now()-c.openedAt>=MAX_CONNECTION_MS || (!c.live&&this.deps.now()-c.openedAt>15_000) || (c.live&&this.deps.now()-c.lastMessageAt>60_000)) this.disconnect(c);
      for (const frame of this.queue.drain(128)) { this.feed.ingest(frame.payload,frame.receivedAt); this.processedFrames++; }
      for (const symbol of this.trackedSymbols) if (this.feed.needsTradeRestart(symbol)) { this.feed.reset(symbol,'TRADE_WINDOW_RESTART_REQUIRED',this.deps.now()); this.snapshotsAt.delete(symbol); }
      if (!this.connections.every(c=>c.live)) return;
      const now=this.deps.now();
      for (const symbol of this.trackedSymbols) {
        if (this.feed.needsSnapshot(symbol)&&now>=this.nextRestAt&&now-(this.snapshotsAt.get(symbol)??-Infinity)>=10_000) {
          this.snapshotsAt.set(symbol,now);
          const synchronization=this.synchronization;
          try { const snapshot=await this.get(`/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=100`,5); if(!this.running||lifecycle!==this.lifecycle||synchronization!==this.synchronization)return;this.feed.installSnapshot(symbol,snapshot,this.deps.now()); }
          catch { this.failures.snapshotFailures++; }
          break; // one bounded REST task per cycle, global pacing and weight budget
        }
      }
      for (const symbol of this.trackedSymbols) {
        if(!this.running||lifecycle!==this.lifecycle)return;
        const observation=this.feed.takeObservation(symbol,this.deps.now());
        if (observation) {
          const sinkStarted=this.deps.now();
          try { await this.deps.sink(observation); this.failedSinkSymbols.delete(symbol); this.lastSinkAt=this.deps.now(); }
          catch { this.failedSinkSymbols.add(symbol); this.failures.sinkFailures++; this.feed.reset(symbol,'SINK_WRITE_FAILED',this.deps.now()); this.snapshotsAt.delete(symbol); }
          finally { this.maxSinkDurationMs=Math.max(this.maxSinkDurationMs,this.deps.now()-sinkStarted); }
        }
      }
    } finally { this.lastCycleDurationMs=this.deps.now()-cycleStarted;this.lastCycleAt=this.deps.now();this.processing=false; }
  }
  health() {
    const now=this.deps.now();
    const symbols=this.trackedSymbols.map(symbol=>this.feed?.health(symbol,now)??{symbol,status:'UNAVAILABLE',reason:'WORKER_NOT_STARTED'});
    return { running:this.running, sinkHealthy:this.failedSinkSymbols.size===0, failedSinkSymbols:[...this.failedSinkSymbols], discoveredSymbols:this.feed?.symbols.length??0, trackedSymbols:this.trackedSymbols.length, tickerCoverage:this.feed?.tickerCoverage(now)??{total:0,fresh:0,stale:0,unseen:0,maxFreshLagMs:null}, researchCoverage:{selected:symbols.length,fresh:symbols.filter(s=>s.status==='FRESH').length}, queueSize:this.queue.size, queueBytes:this.queue.byteSize, queueOldestAgeMs:this.queue.oldestAgeMs(now), queueDropped:this.queue.dropped, processedFrames:this.processedFrames, lastCycleAt:this.lastCycleAt, lastCycleDurationMs:this.lastCycleDurationMs, lastSinkAt:this.lastSinkAt,maxSinkDurationMs:this.maxSinkDurationMs, connections:this.connections.map(c=>({connected:c.live,reconnectAttempts:c.attempt,lastMessageAgeMs:Math.max(0,now-c.lastMessageAt)})), failures:{...this.failures}, symbols };
  }
  stop() {
    this.running=false;
    this.lifecycle++;
    this.deps.timer.clear(this.cycleTimer);
    for (const c of this.connections) { c.generation++; if(c.retry!==null)this.deps.timer.clear(c.retry); c.retry=null;c.live=false;try{c.socket.close();}catch{ /* Stop stays fail closed even if transport teardown fails. */ } }
    this.queue.clear(); this.feed?.invalidateAll('WORKER_STOPPED');
  }
}
