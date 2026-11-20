import type { MarketObservation } from './contracts';

type Row = Record<string, unknown>;
type Book = { bids: Map<number, number>; asks: Map<number, number>; last: number; bridged: boolean; valid: boolean; time: number; buffer: Row[] };
type SymbolState = { tickerTime: number; tickerReceived: number; price: number; quote24h: number; lastTrade: number | null; tradeTime: number; tradeReceived: number; tradeValid: boolean; tradeCount: number; pendingBuy: number; pendingSell: number; pendingStart: number; pendingReceivedAt: number; lastPublishedAt: number; minimumEventTime: number; fundingRate?: number; fundingTime: number; book: Book; reason: string };
const record = (x: unknown): x is Row => !!x && typeof x === 'object' && !Array.isArray(x);
const positive = (x: unknown) => typeof x === 'string' || typeof x === 'number' ? Number.isFinite(Number(x)) && Number(x) > 0 : false;
const numeric = (x: unknown) => (typeof x === 'number' || (typeof x === 'string' && x.trim()!=='')) && Number.isFinite(Number(x));
const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const symbolName = (x: unknown): x is string => typeof x === 'string' && /^[\p{L}\p{N}_]{1,40}$/u.test(x) && x === x.toUpperCase();
const blankBook = (): Book => ({ bids: new Map(), asks: new Map(), last: 0, bridged: false, valid: false, time: 0, buffer: [] });
const blank = (): SymbolState => ({ tickerTime: 0, tickerReceived: 0, price: 0, quote24h: 0, lastTrade: null, tradeTime: 0, tradeReceived: 0, tradeValid: true, tradeCount: 0, pendingBuy: 0, pendingSell: 0, pendingStart: 0, pendingReceivedAt:0, lastPublishedAt:0, minimumEventTime:0, fundingTime: 0, book: blankBook(), reason: 'WARMING_UP' });

export interface MarketEligibilityPolicy { quoteAssets: readonly string[]; contractTypes: readonly string[] }
export const DEFAULT_MARKET_ELIGIBILITY: Readonly<MarketEligibilityPolicy> = Object.freeze({quoteAssets:Object.freeze(['USDT','USDC']),contractTypes:Object.freeze(['PERPETUAL'])});
/** Official exchangeInfo, never a guessed/synthetic universe. Delivery contracts require an explicit policy. */
export function discoverEligibleSymbols(body: unknown, policy: MarketEligibilityPolicy = DEFAULT_MARKET_ELIGIBILITY): string[] {
  if (!record(body) || !Array.isArray(body.symbols)) throw new Error('INVALID_EXCHANGE_INFORMATION');
  if (!policy.quoteAssets.length||!policy.contractTypes.length||policy.quoteAssets.some(x=>!['USDT','USDC'].includes(x))||policy.contractTypes.some(x=>!['PERPETUAL','CURRENT_QUARTER','NEXT_QUARTER'].includes(x)))throw new Error('INVALID_ELIGIBILITY_POLICY');
  const symbols = body.symbols.filter(record).filter(x => x.status === 'TRADING' && policy.contractTypes.includes(String(x.contractType)) && policy.quoteAssets.includes(String(x.quoteAsset)) && x.marginAsset === x.quoteAsset && symbolName(x.symbol)).map(x => x.symbol as string);
  const result = [...new Set(symbols)].sort();
  if (!result.length || result.length > 5000) throw new Error('UNSUPPORTED_SYMBOL_UNIVERSE');
  return result;
}

export interface FeedHealth { symbol: string; status: 'FRESH' | 'STALE' | 'UNAVAILABLE'; sequenceValid: boolean; lagMs: number | null; reason: string; quoteVolume24h: number | null }

/** Bounded in-memory projection. A restart deliberately requires new trade warmup and depth synchronization. */
export class BinanceMarketFeed {
  readonly symbols: readonly string[];
  readonly freshnessMs: number;
  readonly maxBookLevels: number;
  readonly maxBufferedDepth: number;
  readonly epochSeed: number;
  private states = new Map<string, SymbolState>();
  private epochs = new Map<string, number>();
  private counters = { accepted: 0, rejected: 0, duplicate: 0, gaps: 0, bufferOverflows: 0 };
  constructor(symbols: readonly string[], freshnessMs = 5000, maxBookLevels = 1000, maxBufferedDepth = 256, epochSeed = 0) {
    this.symbols=[...symbols];this.freshnessMs=freshnessMs;this.maxBookLevels=maxBookLevels;this.maxBufferedDepth=maxBufferedDepth;this.epochSeed=epochSeed;
    if (!symbols.length || symbols.length > 5000 || new Set(symbols).size !== symbols.length || symbols.some(x => !symbolName(x)) || !Number.isFinite(freshnessMs) || freshnessMs <= 0 || !Number.isInteger(maxBookLevels) || maxBookLevels < 1 || maxBookLevels > 1000 || !Number.isInteger(maxBufferedDepth) || maxBufferedDepth < 1 || maxBufferedDepth > 2048) throw new Error('INVALID_FEED_BOUNDS');
    if (!Number.isSafeInteger(epochSeed) || epochSeed<0 || epochSeed>Number.MAX_SAFE_INTEGER-1_000_000) throw new Error('INVALID_FEED_EPOCH');
    for (const symbol of symbols) { this.states.set(symbol, blank()); this.epochs.set(symbol, epochSeed); }
  }
  metrics() { return { ...this.counters }; }
  /** Ticker coverage is independent of trade/book readiness; never equate the two. */
  tickerCoverage(now: number) {
    let fresh=0, stale=0, unseen=0; let maxFreshLagMs=0;
    for (const state of this.states.values()) {
      if (!state.tickerTime) { unseen++; continue; }
      const lag=now-state.tickerTime;
      if (lag>=0 && lag<=this.freshnessMs && now>=state.tickerReceived) { fresh++; maxFreshLagMs=Math.max(maxFreshLagMs,lag); }
      else stale++;
    }
    return { total:this.symbols.length, fresh, stale, unseen, maxFreshLagMs:fresh?maxFreshLagMs:null };
  }
  private advanceEpoch(symbol: string) {
    const next=(this.epochs.get(symbol)??this.epochSeed)+1;
    if(next>=this.epochSeed+1_000_000) { this.states.set(symbol,blank()); throw new Error('FEED_EPOCH_CAPACITY_EXCEEDED'); }
    this.epochs.set(symbol,next);
    const state=this.states.get(symbol);if(state)state.lastPublishedAt=0;
  }
  reset(symbol: string, reason = 'RECONNECT', minimumEventTime = 0) { if (this.states.has(symbol)) { this.states.set(symbol, { ...blank(), reason, minimumEventTime }); this.advanceEpoch(symbol); } }
  invalidateAll(reason: string, minimumEventTime = 0) { for (const symbol of this.symbols) this.reset(symbol, reason, minimumEventTime); }
  needsSnapshot(symbol: string) { return !this.states.get(symbol)?.book.valid; }
  needsTradeRestart(symbol: string) { return this.states.get(symbol)?.tradeValid===false; }
  private timestamp(event: Row, receivedAt: number) {
    return integer(event.E) && Number.isFinite(receivedAt) && event.E <= receivedAt + 1000 && event.E > 0;
  }
  private applyLevels(map: Map<number, number>, levels: unknown) {
    if (!Array.isArray(levels) || levels.length > 10000) throw new Error('INVALID_BOOK_LEVELS');
    for (const level of levels) {
      if (!Array.isArray(level) || level.length < 2 || !positive(level[0]) || !numeric(level[1]) || Number(level[1]) < 0) throw new Error('INVALID_BOOK_LEVEL');
      const price = Number(level[0]), quantity = Number(level[1]);
      if (quantity === 0) map.delete(price); else map.set(price, quantity);
    }
    // Trimming a diff book would make previously untracked levels appear reliable.
    // Fail closed and resnapshot rather than silently claiming full continuity.
    if (map.size > this.maxBookLevels) throw new Error('BOOK_CAPACITY_EXCEEDED');
  }
  private depth(state: SymbolState, event: Row) {
    const book = state.book;
    if (!integer(event.U) || !integer(event.u) || !integer(event.pu) || event.U > event.u) throw new Error('INVALID_DEPTH_SEQUENCE');
    if (event.u < book.last || (book.bridged && event.u === book.last)) { this.counters.duplicate++; return; }
    if (!book.bridged ? !(event.U <= book.last && event.u >= book.last) : event.pu !== book.last) {
      this.counters.gaps++; throw new Error('DEPTH_SEQUENCE_GAP');
    }
    this.applyLevels(book.bids, event.b);
    this.applyLevels(book.asks, event.a);
    if (!book.bids.size || !book.asks.size || Math.max(...book.bids.keys()) >= Math.min(...book.asks.keys())) throw new Error('CROSSED_OR_EMPTY_BOOK');
    book.last = event.u; book.bridged = true; book.time = event.E as number; book.valid = true;
  }
  installSnapshot(symbol: string, snapshot: unknown, receivedAt: number): boolean {
    const state = this.states.get(symbol);
    if (!state || !record(snapshot) || !integer(snapshot.lastUpdateId) || !Number.isFinite(receivedAt)) return false;
    const buffered = state.book.buffer;
    try {
      const book = blankBook();
      book.last = snapshot.lastUpdateId;
      this.applyLevels(book.bids, snapshot.bids);
      this.applyLevels(book.asks, snapshot.asks);
      if (!book.bids.size || !book.asks.size || Math.max(...book.bids.keys()) >= Math.min(...book.asks.keys())) throw new Error('INVALID_SNAPSHOT');
      state.book = book;
      for (const event of buffered) this.depth(state, event);
      state.reason = state.book.bridged ? 'SYNCHRONIZED' : 'AWAITING_DEPTH_BRIDGE';
      return true;
    } catch { state.book = blankBook(); state.pendingBuy=state.pendingSell=0; this.advanceEpoch(symbol); state.reason = 'DEPTH_RESYNC_REQUIRED'; return false; }
  }
  ingest(payload: unknown, receivedAt: number): void {
    if (Array.isArray(payload)) { if (payload.length > 5000) { this.counters.rejected++; return; } for (const event of payload) this.ingest(event, receivedAt); return; }
    if (!record(payload)) { this.counters.rejected++; return; }
    if ('stream' in payload && 'data' in payload) { this.ingest(payload.data, receivedAt); return; }
    const event = payload;
    const state = typeof event.s === 'string' ? this.states.get(event.s) : undefined;
    if (!state || (event.st !== undefined && event.st !== 1) || !this.timestamp(event, receivedAt) || (event.E as number)<state.minimumEventTime) { this.counters.rejected++; return; }
    try {
      if (event.e === '24hrTicker') {
        if (!positive(event.c) || !numeric(event.q) || Number(event.q) < 0) throw new Error('INVALID_TICKER');
        if ((event.E as number) <= state.tickerTime) { this.counters.duplicate++; return; }
        state.tickerTime = event.E as number; state.tickerReceived = receivedAt; state.price = Number(event.c); state.quote24h = Number(event.q);
      } else if (event.e === 'aggTrade') {
        if (!integer(event.a) || !positive(event.p) || !positive(event.q) || typeof event.m !== 'boolean' || (event.E as number) < state.tradeTime) throw new Error('INVALID_TRADE');
        if (state.lastTrade !== null && event.a <= state.lastTrade) { this.counters.duplicate++; return; }
        if (state.lastTrade !== null && event.a !== state.lastTrade + 1) { state.tradeValid = false; state.pendingBuy = state.pendingSell = 0; state.reason = 'TRADE_SEQUENCE_GAP'; this.counters.gaps++; this.advanceEpoch(event.s as string); }
        const notional = Number(event.p) * Number(event.q);
        if (!Number.isFinite(notional)) throw new Error('INVALID_NOTIONAL');
        if ((state.pendingStart>0&&(event.E as number)-state.pendingStart>this.freshnessMs) || (state.tradeTime>0&&(event.E as number)-state.tradeTime>this.freshnessMs)) {
          state.pendingBuy=state.pendingSell=0;state.pendingStart=0;state.tradeCount=0;this.advanceEpoch(event.s as string);state.reason='TRADE_WINDOW_EXPIRED';
        }
        state.lastTrade = event.a; state.tradeTime = event.E as number; state.tradeReceived = receivedAt; state.tradeCount++;
        if (state.tradeValid) { if(state.pendingBuy+state.pendingSell===0){state.pendingStart=event.E as number;state.pendingReceivedAt=receivedAt;}if (event.m) state.pendingSell += notional; else state.pendingBuy += notional; }
        if (!Number.isFinite(state.pendingBuy + state.pendingSell)) throw new Error('INVALID_NOTIONAL');
      } else if (event.e === 'depthUpdate') {
        if (!state.book.valid && state.book.last === 0) {
          if (state.book.buffer.length >= this.maxBufferedDepth) { state.book.buffer = []; state.pendingBuy=state.pendingSell=0; this.advanceEpoch(event.s as string); this.counters.bufferOverflows++; state.reason = 'DEPTH_BUFFER_OVERFLOW'; }
          else state.book.buffer.push(event);
        } else this.depth(state, event);
      } else if (event.e === 'markPriceUpdate') {
        if (!numeric(event.r) || (event.E as number) <= state.fundingTime) throw new Error('INVALID_FUNDING');
        state.fundingRate = Number(event.r); state.fundingTime = event.E as number;
      } else { this.counters.rejected++; return; }
      this.counters.accepted++;
    } catch (error) {
      state.reason = error instanceof Error ? error.message : 'INVALID_EVENT';
      if (event.e === 'depthUpdate') { state.book = blankBook(); state.pendingBuy=state.pendingSell=0; this.advanceEpoch(event.s as string); }
      if (event.e === 'aggTrade') { state.tradeValid = false; state.pendingBuy = state.pendingSell = 0; }
      this.counters.rejected++;
    }
  }
  health(symbol: string, now: number): FeedHealth {
    const s = this.states.get(symbol);
    if (!s) return { symbol, status: 'UNAVAILABLE', sequenceValid: false, lagMs: null, reason: 'NOT_DISCOVERED', quoteVolume24h: null };
    const times = [s.tickerTime, s.tradeTime, s.book.time];
    const initialized = s.price > 0 && s.tradeCount >= 2 && s.book.bridged;
    const sequenceValid = s.tradeValid && s.book.valid && s.book.bridged;
    const fresh = initialized && sequenceValid && times.every(t => t > 0 && now >= t && now-t <= this.freshnessMs) && now >= s.tickerReceived && now >= s.tradeReceived;
    return { symbol, status: fresh ? 'FRESH' : initialized ? 'STALE' : 'UNAVAILABLE', sequenceValid, lagMs: initialized ? Math.max(...times.map(t => now-t)) : null, reason: fresh ? 'SYNCHRONIZED' : s.reason === 'SYNCHRONIZED' ? 'STALE_REQUIRED_STREAM' : s.reason, quoteVolume24h: s.tickerTime ? s.quote24h : null };
  }
  /** Disjoint aggTrade notional sample; a ticker/book update alone cannot duplicate a sample. */
  takeObservation(symbol: string, now: number): MarketObservation | null {
    const s = this.states.get(symbol);
    if (!s || this.health(symbol, now).status !== 'FRESH' || s.pendingBuy+s.pendingSell <= 0) return null;
    if(now-s.pendingStart>this.freshnessMs) {s.pendingBuy=s.pendingSell=0;s.pendingStart=0;s.tradeCount=0;this.advanceEpoch(symbol);s.reason='TRADE_WINDOW_EXPIRED';return null;}
    const bid = Math.max(...s.book.bids.keys()), ask = Math.min(...s.book.asks.keys());
    const duration=now-(s.lastPublishedAt||s.pendingReceivedAt);
    const observation: MarketObservation = { symbol, source: 'BINANCE_USDM', eventTime: Math.max(s.tradeTime,s.tickerTime,s.book.time), receivedAt: now, requiredInputTimes:{ticker:s.tickerTime,trade:s.tradeTime,depth:s.book.time}, price: s.price, bid, ask, quoteVolume: s.pendingBuy+s.pendingSell, buyQuoteVolume: s.pendingBuy, sellQuoteVolume: s.pendingSell, bidDepth: [...s.book.bids].sort((a,b)=>b[0]-a[0]).slice(0,20).reduce((sum,[p,q]) => sum+p*q,0), askDepth: [...s.book.asks].sort((a,b)=>a[0]-b[0]).slice(0,20).reduce((sum,[p,q]) => sum+p*q,0), fresh: true, sequenceValid: true, feedEpoch:this.epochs.get(symbol)??0, ...(Number.isFinite(duration)&&duration>0?{volumeIntervalMs:duration}:{}), ...(s.fundingRate !== undefined && now >= s.fundingTime && now-s.fundingTime <= this.freshnessMs ? { fundingRate: s.fundingRate } : {}) };
    s.pendingBuy = s.pendingSell = 0; s.pendingStart=0;s.pendingReceivedAt=0;s.lastPublishedAt=now;
    return observation;
  }
}

export interface QueuedFrame { payload: unknown; receivedAt: number; bytes: number }
export class BoundedMarketQueue {
  readonly capacity: number;
  readonly byteLimit: number;
  private frames: QueuedFrame[] = [];
  private bytes = 0;
  dropped = 0;
  constructor(capacity = 256, byteLimit = 8 * 1024 * 1024) {
    this.capacity=capacity;this.byteLimit=byteLimit;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000 || !Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > 64*1024*1024) throw new Error('INVALID_QUEUE_BOUNDS');
  }
  enqueue(frame: QueuedFrame) {
    if (!Number.isSafeInteger(frame.bytes) || frame.bytes < 1 || this.frames.length >= this.capacity || this.bytes+frame.bytes > this.byteLimit) { this.dropped++; return false; }
    this.frames.push(frame); this.bytes += frame.bytes; return true;
  }
  drain(limit = 128) { if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('INVALID_DRAIN_LIMIT'); const items=this.frames.splice(0,limit); this.bytes-=items.reduce((n,x)=>n+x.bytes,0); return items; }
  clear() { this.frames=[]; this.bytes=0; }
  get size() { return this.frames.length; }
  get byteSize() { return this.bytes; }
  oldestAgeMs(now: number) { return this.frames.length ? Math.max(0,now-this.frames[0].receivedAt) : 0; }
}
