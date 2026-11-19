import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { MarketObservation } from './contracts';

export interface MarketJournalEnvelope { version: 1; runId: number; epoch: number; sequence: number; observation: MarketObservation }
export interface MarketJournalCursor { version: 1; runId: number; epoch: number; segment: number; byteOffset: number; sequence: number; lineHash: string }
export interface MarketJournalBatch {
  version: 1; batchId: string; from: MarketJournalCursor | null; to: MarketJournalCursor;
  records: Array<{ envelope: MarketJournalEnvelope; cursor: MarketJournalCursor }>;
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical((value as Record<string,unknown>)[key])])) : value;
/** Semantic content hash, independent of JSON whitespace/key order. Physical
 * byte offsets and complete newline boundaries are separately checked. */
export const marketJournalEnvelopeHash = (value: MarketJournalEnvelope) => digest(JSON.stringify(canonical(value)));
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
const cursorKeys = ['version','runId','epoch','segment','byteOffset','sequence','lineHash'];
export function validateMarketJournalCursor(raw: unknown): MarketJournalCursor {
  const value = raw as MarketJournalCursor;
  if (!value || Object.keys(value).length !== cursorKeys.length || Object.keys(value).some(key=>!cursorKeys.includes(key)) ||
      value.version !== 1 || !integer(value.runId,1) || !integer(value.epoch) || !integer(value.segment) || value.segment > 999999999999 ||
      !integer(value.byteOffset,1) || value.byteOffset > 100*1024*1024 || !integer(value.sequence,1) || !/^[a-f0-9]{64}$/.test(value.lineHash)) throw Error('INVALID_JOURNAL_CURSOR');
  return {version:1,runId:value.runId,epoch:value.epoch,segment:value.segment,byteOffset:value.byteOffset,sequence:value.sequence,lineHash:value.lineHash};
}
export function marketJournalBatchId(from: MarketJournalCursor|null,to: MarketJournalCursor,records: MarketJournalBatch['records']) {
  return digest(JSON.stringify({version:1,from:from===null?null:validateMarketJournalCursor(from),to:validateMarketJournalCursor(to),
    lineHashes:records.map(record=>validateMarketJournalCursor(record.cursor).lineHash)}));
}
function envelope(raw: unknown): MarketJournalEnvelope {
  const value = raw as MarketJournalEnvelope;
  if (!value || Object.keys(value).sort().join(',') !== 'epoch,observation,runId,sequence,version' || value.version !== 1 ||
      !integer(value.runId,1) || !integer(value.epoch) || !integer(value.sequence,1) || !value.observation ||
      value.observation.feedEpoch !== value.epoch) throw Error('INVALID_OR_LEGACY_JOURNAL_ENVELOPE');
  return value;
}
function parseLine(bytes: Buffer) {
  try {return envelope(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
  catch {throw Error('INVALID_OR_LEGACY_JOURNAL_ENVELOPE');}
}
const filename = (segment: number) => `observations.${String(segment).padStart(12,'0')}.ndjson`;

/** Local bounded reader. Reading NEVER acknowledges data. Persist batch.to in the
 * same transaction as its projection, then acknowledge; restore that durable
 * cursor at restart. There is no database, network or implicit cursor file. */
export class PublicMarketTailer {
  private directory: string;
  private cursor: MarketJournalCursor|null;
  private pending: MarketJournalBatch|null = null;
  private reading = false;
  private maxRecords: number;
  private maxBytes: number;
  private maxLineBytes: number;
  constructor(directory: string,cursor: MarketJournalCursor|null=null,limits: {maxRecords?:number;maxBytes?:number;maxLineBytes?:number}={}) {
    this.directory=path.resolve(directory);this.cursor=cursor===null?null:validateMarketJournalCursor(cursor);
    this.maxRecords=limits.maxRecords??128;this.maxBytes=limits.maxBytes??1024*1024;this.maxLineBytes=limits.maxLineBytes??64*1024;
    if (!integer(this.maxRecords,1)||this.maxRecords>1000||!integer(this.maxBytes,1024)||this.maxBytes>4*1024*1024||
        !integer(this.maxLineBytes,256)||this.maxLineBytes>=this.maxBytes) throw Error('INVALID_TAILER_BOUNDS');
  }
  acknowledgedCursor() { return structuredClone(this.cursor); }
  acknowledge(batchId: string) {
    if (!this.pending || this.pending.batchId!==batchId) throw Error('JOURNAL_ACK_CONFLICT');
    this.cursor=structuredClone(this.pending.to);this.pending=null;return structuredClone(this.cursor);
  }
  async read(): Promise<MarketJournalBatch|null> {
    if (this.pending) return structuredClone(this.pending);
    if (this.reading) throw Error('TAILER_READ_ALREADY_RUNNING');
    this.reading=true;
    try {
      const entries=(await fs.readdir(this.directory)).filter(name=>/^observations\.\d{12}\.ndjson$/.test(name)).sort();
      if (entries.length>32) throw Error('JOURNAL_SEGMENT_CAPACITY_EXCEEDED');
      if (!entries.length) {if(this.cursor)throw Error('JOURNAL_CURSOR_SEGMENT_MISSING');return null;}
      const segments=entries.map(name=>Number(name.slice(13,25)));
      if ((this.cursor && !segments.includes(this.cursor.segment)) || (!this.cursor && segments[0]!==0)) throw Error('JOURNAL_RETENTION_GAP');
      const start=this.cursor?.segment??0;
      const available=segments.filter(n=>n>=start);
      if (available.some((n,i)=>i>0&&n!==available[i-1]!+1)) throw Error('JOURNAL_SEGMENT_GAP');
      const records: MarketJournalBatch['records']=[];
      let previous=this.cursor, bytesRead=0;
      for (const segment of available) {
        const handle=await fs.open(path.join(this.directory,filename(segment)),'r');
        try {
          const stat=await handle.stat();
          if (!stat.isFile() || stat.size>100*1024*1024) throw Error('INVALID_JOURNAL_SEGMENT');
          let offset=segment===start?(this.cursor?.byteOffset??0):0;
          if (offset>stat.size) throw Error('JOURNAL_CURSOR_TRUNCATED');
          if (this.cursor && segment===start) {
            const length=Math.min(offset,this.maxLineBytes+1), buffer=Buffer.alloc(length);
            await handle.read(buffer,0,length,offset-length);
            if (buffer.at(-1)!==10) throw Error('JOURNAL_CURSOR_NOT_LINE_BOUNDARY');
            const begin=buffer.lastIndexOf(10,buffer.length-2)+1;
            const anchor=buffer.subarray(begin,buffer.length-1);
            const stored=parseLine(anchor);
            if (marketJournalEnvelopeHash(stored)!==this.cursor.lineHash) throw Error('JOURNAL_CURSOR_ANCHOR_CHANGED');
            if(stored.runId!==this.cursor.runId||stored.epoch!==this.cursor.epoch||stored.sequence!==this.cursor.sequence)throw Error('JOURNAL_CURSOR_ANCHOR_CHANGED');
          }
          if(offset<stat.size&&records.length<this.maxRecords&&bytesRead<this.maxBytes) {
            const count=Math.min(stat.size-offset,this.maxBytes-bytesRead);
            const buffer=Buffer.alloc(count);const read=await handle.read(buffer,0,count,offset);
            if(read.bytesRead!==count)throw Error('JOURNAL_CHANGED_DURING_READ');
            bytesRead+=read.bytesRead;
            const data=buffer.subarray(0,read.bytesRead);let local=0;
            while(local<data.length&&records.length<this.maxRecords) {
            const newline=data.indexOf(10,local);
            if(newline<0) {
              if (data.length-local>this.maxLineBytes) throw Error('JOURNAL_LINE_OVERSIZED');
              if(offset+data.length-local===stat.size&&segment!==available.at(-1)) throw Error('JOURNAL_INCOMPLETE_SEALED_SEGMENT');
              break; // Partial current row stays unacknowledged until completed.
            }
            if(newline-local>this.maxLineBytes)throw Error('JOURNAL_LINE_OVERSIZED');
            const line=data.subarray(local,newline), value=parseLine(line);
            if(previous) {
              if(value.runId<previous.runId||(value.runId===previous.runId&&value.sequence!==previous.sequence+1)||
                (value.runId>previous.runId&&value.sequence!==1))throw Error('JOURNAL_SEQUENCE_GAP_OR_REWIND');
            } else if(value.sequence!==1) throw Error('JOURNAL_INITIAL_SEQUENCE_GAP');
            offset+=newline-local+1;local=newline+1;
            const cursor:MarketJournalCursor={version:1,runId:value.runId,epoch:value.epoch,segment,byteOffset:offset,sequence:value.sequence,lineHash:marketJournalEnvelopeHash(value)};
            records.push({envelope:value,cursor});previous=cursor;
            }
          }
          if(records.length>=this.maxRecords||bytesRead>=this.maxBytes||offset<stat.size)break;
        } finally {await handle.close();}
      }
      if(!records.length)return null;
      const to=records.at(-1)!.cursor;
      this.pending={version:1,batchId:marketJournalBatchId(this.cursor,to,records),from:structuredClone(this.cursor),to,records};
      return structuredClone(this.pending);
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code==='ENOENT') throw Error('JOURNAL_SEGMENT_DISAPPEARED');
      throw error;
    } finally {this.reading=false;}
  }
}
