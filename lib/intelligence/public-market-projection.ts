import { createHash } from 'node:crypto';
import type { MarketObservation } from './contracts';

const keys = ['symbol', 'source', 'eventTime', 'receivedAt', 'volumeIntervalMs', 'price', 'bid', 'ask', 'quoteVolume',
  'buyQuoteVolume', 'sellQuoteVolume', 'bidDepth', 'askDepth', 'openInterest', 'fundingRate', 'fresh', 'sequenceValid', 'feedEpoch'] as const;
const symbolPattern = /^[\p{L}\p{N}_]{2,40}$/u;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = (value: number) => Number.isSafeInteger(value) && value > 0;
function symbols(values: readonly string[], maximum: number) {
  if (!values.length || values.length > maximum || new Set(values).size !== values.length ||
      values.some(value => typeof value !== 'string' || !symbolPattern.test(value) || value !== value.toUpperCase())) {
    throw new Error('Invalid public projection universe.');
  }
  return [...values].sort();
}
function observation(raw: MarketObservation, now: number, maxAgeMs: number): MarketObservation {
  if (!raw || typeof raw !== 'object' || Object.keys(raw).some(key => !(keys as readonly string[]).includes(key)) ||
      raw.source !== 'BINANCE_USDM' || !symbolPattern.test(raw.symbol) || raw.symbol !== raw.symbol.toUpperCase() ||
      !time(raw.eventTime) || !time(raw.receivedAt) || raw.eventTime > raw.receivedAt || raw.receivedAt > now ||
      now - raw.eventTime > maxAgeMs || raw.fresh !== true || raw.sequenceValid !== true ||
      !Number.isSafeInteger(raw.feedEpoch) || raw.feedEpoch! < 0 ||
      [raw.price, raw.bid, raw.ask].some(value => !Number.isFinite(value) || value <= 0) || raw.bid >= raw.ask ||
      [raw.quoteVolume, raw.buyQuoteVolume, raw.sellQuoteVolume, raw.bidDepth, raw.askDepth].some(value => !Number.isFinite(value) || value < 0) ||
      Math.abs(raw.quoteVolume - raw.buyQuoteVolume - raw.sellQuoteVolume) > Math.max(1e-8, raw.quoteVolume * 1e-10) ||
      (raw.volumeIntervalMs !== undefined && (!Number.isFinite(raw.volumeIntervalMs) || raw.volumeIntervalMs <= 0 || raw.volumeIntervalMs > maxAgeMs)) ||
      (raw.openInterest !== undefined && (!Number.isFinite(raw.openInterest) || raw.openInterest < 0)) ||
      (raw.fundingRate !== undefined && !Number.isFinite(raw.fundingRate))) {
    throw new Error('Invalid or stale public market observation.');
  }
  // Stable field order makes duplicate hashes independent of JSON key ordering.
  return Object.fromEntries(keys.filter(key => raw[key] !== undefined).map(key => [key, raw[key]])) as unknown as MarketObservation;
}

/** Pure, bounded read-model foundation. No database, network, route or worker activation. */
export class PublicMarketProjection {
  readonly universe: readonly string[];
  readonly selected: readonly string[];
  readonly maxAgeMs: number;
  private latest = new Map<string, MarketObservation>();
  private revision = 0;
  constructor(universe: readonly string[], selected: readonly string[], maxAgeMs = 5000) {
    this.universe = Object.freeze(symbols(universe, 5000));
    this.selected = Object.freeze(symbols(selected, 200));
    if (this.selected.some(value => !this.universe.includes(value)) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 60_000) {
      throw new Error('Invalid selected projection coverage.');
    }
    this.maxAgeMs = maxAgeMs;
  }
  ingest(raw: MarketObservation, now: number): 'APPLIED' | 'DUPLICATE' | 'SUPERSEDED' {
    if (!time(now)) throw new Error('Invalid projection clock.');
    const next = observation(raw, now, this.maxAgeMs);
    if (!this.selected.includes(next.symbol)) throw new Error('Observation is outside selected coverage.');
    const previous = this.latest.get(next.symbol);
    if (previous) {
      if (next.feedEpoch! < previous.feedEpoch!) return 'SUPERSEDED';
      if (next.receivedAt < previous.receivedAt || next.eventTime < previous.eventTime) return 'SUPERSEDED';
      if (next.feedEpoch === previous.feedEpoch && next.receivedAt === previous.receivedAt && next.eventTime === previous.eventTime) {
        if (hash(next) !== hash(previous)) throw new Error('Conflicting public observation identity.');
        return 'DUPLICATE';
      }
    }
    if (!Number.isSafeInteger(this.revision + 1)) throw new Error('Projection revision exhausted.');
    this.latest.set(next.symbol, next); this.revision++;
    return 'APPLIED';
  }
  checkpoint() {
    return JSON.stringify({ version: 1, universe: this.universe, selected: this.selected, maxAgeMs: this.maxAgeMs,
      revision: this.revision, observations: this.selected.flatMap(symbol => this.latest.has(symbol) ? [this.latest.get(symbol)!] : []) });
  }
  static restore(serialized: string, now: number) {
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024 || !time(now)) throw new Error('Invalid projection checkpoint.');
    const value = JSON.parse(serialized);
    if (!value || Object.keys(value).sort().join(',') !== 'maxAgeMs,observations,revision,selected,universe,version' || value.version !== 1 ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.observations)) throw new Error('Invalid projection checkpoint.');
    const result = new PublicMarketProjection(value.universe, value.selected, value.maxAgeMs);
    if (value.observations.length > result.selected.length || value.revision < value.observations.length) throw new Error('Invalid projection checkpoint.');
    for (const raw of value.observations) {
      // Old snapshots remain old after restart. Validation uses their own receipt
      // time, while the website view always recomputes age against its clock.
      if (result.latest.has(raw.symbol) || raw.receivedAt > now) throw new Error('Invalid projection checkpoint.');
      const next = observation(raw, raw.receivedAt, result.maxAgeMs);
      if (!result.selected.includes(next.symbol)) throw new Error('Invalid projection checkpoint.');
      result.latest.set(next.symbol, next);
    }
    result.revision = value.revision;
    return result;
  }
  view(now: number) {
    if (!time(now)) throw new Error('Invalid projection clock.');
    const rows = this.selected.map(symbol => {
      const row = this.latest.get(symbol);
      const ageMs = row ? now - row.eventTime : null;
      const recent = row !== undefined && now >= row.receivedAt && ageMs! >= 0 && ageMs! <= this.maxAgeMs;
      // eventTime is the newest participating input, not the oldest. Recency
      // cannot extend the original worker's required-input freshness proof.
      return { symbol, state: !row ? 'UNAVAILABLE' as const : recent ? 'RECENT_OBSERVATION' as const : 'STALE' as const,
        price: recent ? row!.price : null, ageMs, feedEpoch: row?.feedEpoch ?? null,
        freshnessVerified: false as const, requiredInputFreshness: 'UNKNOWN_AFTER_RECEIPT' as const };
    });
    const times = [...this.latest.values()].map(row => row.receivedAt);
    return { market: { source: 'Validated Binance USD-M public observations', enabledSymbols: this.universe.length,
      snapshotSymbols: this.latest.size, latestSnapshotAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      continuousFeedVerified: false as const },
      tickerCoverage: { state: 'NOT_PROJECTED' as const, reason: 'Selected observations do not establish all-universe ticker coverage.' },
      selectedCoverage: { total: rows.length, recent: rows.filter(row => row.state === 'RECENT_OBSERVATION').length,
        stale: rows.filter(row => row.state === 'STALE').length, unavailable: rows.filter(row => row.state === 'UNAVAILABLE').length },
      rows, candidates: [], executionEnabled: false as const };
  }
  /** Pure proposal only. A future transaction must atomically compare this CAS
   * revision, commit the snapshot AND acknowledge its durable source cursor. */
  batchPlan(expectedRevision: number) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > this.revision) throw new Error('Invalid projection compare revision.');
    const checkpoint = this.checkpoint();
    return { mode: 'DRY_RUN_ONLY' as const, batchId: hash({ expectedRevision, checkpoint }), expectedRevision,
      nextRevision: this.revision, checkpoint, remoteWriteAuthorized: false as const };
  }
}
