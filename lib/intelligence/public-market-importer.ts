import {
  marketJournalBatchId, marketJournalEnvelopeHash, validateMarketJournalCursor,
  type MarketJournalBatch, type MarketJournalCursor,
} from './public-market-tailer';
import { validatePublicMarketObservation, validRequiredInputTimes } from './public-market-projection';

const exact = (raw: unknown, names: string[]) => !!raw && typeof raw === 'object' &&
  Object.keys(raw).sort().join(',') === [...names].sort().join(',');
const equalCursor = (a: MarketJournalCursor, b: MarketJournalCursor) => JSON.stringify(a) === JSON.stringify(b);
const maxBatchBytes = 4 * 1024 * 1024;

/** Shared hostile-input boundary for transport and persistence. Historical rows
 * retain original timestamps; current freshness is evaluated by the read model. */
export function validatePublicMarketBatch(raw: unknown, now: number): MarketJournalBatch {
  if (!Number.isSafeInteger(now) || now <= 0) throw Error('INVALID_IMPORT_CLOCK');
  const encoded = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (!encoded || Buffer.byteLength(encoded) > maxBatchBytes) throw Error('PUBLIC_BATCH_CAPACITY_EXCEEDED');
  const value = (typeof raw === 'string' ? JSON.parse(raw) : raw) as MarketJournalBatch;
  if (!exact(value, ['version','batchId','from','to','records']) || value.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(value.batchId) || !Array.isArray(value.records) || value.records.length < 1 || value.records.length > 1000) {
    throw Error('INVALID_PUBLIC_BATCH');
  }
  const from = value.from === null ? null : validateMarketJournalCursor(value.from);
  const to = validateMarketJournalCursor(value.to);
  let previous = from;
  const records = value.records.map(record => {
    if (!exact(record, ['envelope','cursor']) || !exact(record.envelope, ['version','runId','epoch','sequence','observation'])) throw Error('INVALID_PUBLIC_RECORD');
    const envelope = record.envelope;
    const cursor = validateMarketJournalCursor(record.cursor);
    if (envelope.version !== 1 || !Number.isSafeInteger(envelope.runId) || envelope.runId < 1 ||
        !Number.isSafeInteger(envelope.epoch) || envelope.epoch < 0 || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 ||
        envelope.runId !== cursor.runId || envelope.epoch !== cursor.epoch || envelope.sequence !== cursor.sequence ||
        !envelope.observation || envelope.observation.receivedAt > now || envelope.observation.feedEpoch !== envelope.epoch ||
        !validRequiredInputTimes(envelope.observation)) throw Error('INVALID_PUBLIC_EVIDENCE');
    const observation = validatePublicMarketObservation(envelope.observation, envelope.observation.receivedAt);
    const validated = { version: 1 as const, runId: envelope.runId, epoch: envelope.epoch, sequence: envelope.sequence, observation };
    if (Buffer.byteLength(JSON.stringify(validated)) > 64*1024 || marketJournalEnvelopeHash(validated) !== cursor.lineHash) throw Error('PUBLIC_RECORD_HASH_MISMATCH');
    if (previous) {
      if (cursor.runId < previous.runId || (cursor.runId === previous.runId && cursor.sequence !== previous.sequence+1) ||
          (cursor.runId > previous.runId && cursor.sequence !== 1) || cursor.segment < previous.segment || cursor.segment > previous.segment+1 ||
          (cursor.segment === previous.segment && cursor.byteOffset <= previous.byteOffset)) throw Error('PUBLIC_CURSOR_GAP_OR_REWIND');
    } else if (cursor.sequence !== 1 || cursor.segment !== 0) throw Error('PUBLIC_INITIAL_CURSOR_GAP');
    previous = cursor;
    return { envelope: validated, cursor };
  });
  if (!equalCursor(to, records.at(-1)!.cursor) || value.batchId !== marketJournalBatchId(from,to,records)) throw Error('PUBLIC_BATCH_HASH_MISMATCH');
  return { version:1, batchId:value.batchId, from, to, records };
}

export interface PublicMarketImportSink {
  /** Must atomically commit validated snapshots and acknowledged cursor. */
  commit(sourceId: string, batch: MarketJournalBatch, now: number): Promise<{batchId:string;cursor:MarketJournalCursor;duplicate:boolean}>;
}
/** A future authenticated transport may deliver bounded JSON to enqueue. This
 * class has no listener, credentials, fetch, database pool or retry scheduler. */
export class PublicMarketImporter {
  private queue: Array<{batch:MarketJournalBatch;bytes:number}> = [];
  private queuedBytes = 0;
  private processing = false;
  constructor(readonly sourceId: string, private readonly sink: PublicMarketImportSink,
    private readonly limits = {maxBatches:8,maxBytes:8*1024*1024}) {
    if (!/^[A-Z0-9_]{1,64}$/.test(sourceId) || !Number.isSafeInteger(limits.maxBatches) || limits.maxBatches < 1 || limits.maxBatches > 64 ||
        !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1024 || limits.maxBytes > 32*1024*1024) throw Error('INVALID_IMPORTER_CONFIGURATION');
    this.limits = Object.freeze({...limits});
  }
  enqueue(raw: unknown, now: number) {
    const batch = validatePublicMarketBatch(raw,now);
    if (this.queue.some(item=>item.batch.batchId === batch.batchId)) return {batchId:batch.batchId,duplicate:true};
    const bytes = Buffer.byteLength(JSON.stringify(batch));
    if (this.queue.length >= this.limits.maxBatches || this.queuedBytes+bytes > this.limits.maxBytes) throw Error('PUBLIC_IMPORT_BACKPRESSURE');
    this.queue.push({batch,bytes}); this.queuedBytes += bytes;
    return {batchId:batch.batchId,duplicate:false};
  }
  health() { return {queuedBatches:this.queue.length,queuedBytes:this.queuedBytes,processing:this.processing,remoteTransportActivated:false}; }
  async flushOne(now: number) {
    if (this.processing) throw Error('PUBLIC_IMPORT_ALREADY_RUNNING');
    const item = this.queue[0]; if (!item) return null;
    this.processing = true;
    try {
      const batch = validatePublicMarketBatch(item.batch,now);
      const result = await this.sink.commit(this.sourceId,batch,now);
      const cursor = validateMarketJournalCursor(result.cursor);
      if (result.batchId !== item.batch.batchId || typeof result.duplicate !== 'boolean' || !equalCursor(cursor,item.batch.to)) throw Error('PUBLIC_IMPORT_ACK_CONFLICT');
      this.queue.shift(); this.queuedBytes -= item.bytes;
      return {batchId:result.batchId,cursor,duplicate:result.duplicate};
    } finally { this.processing = false; }
  }
}
