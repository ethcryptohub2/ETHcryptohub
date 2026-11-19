import type { Pool, PoolClient } from 'pg';
import { PublicMarketProjection } from './public-market-projection';
import { validatePublicMarketBatch, type PublicMarketImportSink } from './public-market-importer';
import { validateMarketJournalCursor, type MarketJournalBatch, type MarketJournalCursor } from './public-market-tailer';
import { PUBLIC_MARKET_SOURCE } from './public-market-source';

export { PUBLIC_MARKET_SOURCE } from './public-market-source';
const table = 'smartexit_private.public_market_streams';
export function cursorIdentity(cursor: MarketJournalCursor | null): string {
  if (cursor === null) return 'INITIAL';
  validateMarketJournalCursor(cursor);
  return [cursor.version,cursor.runId,cursor.epoch,cursor.segment,cursor.byteOffset,cursor.sequence,cursor.lineHash].join('/');
}
interface StoredStream { revision: string | number; cursor: MarketJournalCursor; checkpoint: unknown; last_batch_id: string }

/** Unwired adapter: caller supplies a separately reviewed private-role pool.
 * No pool construction, secret/environment lookup or automatic write retry. */
export class PostgresPublicMarketStore implements PublicMarketImportSink {
  private readonly universe: readonly string[];
  private readonly selected: readonly string[];
  constructor(private readonly connection: Pick<Pool,'connect'>, targetRef: string, universe: readonly string[], selected: readonly string[]) {
    if (targetRef !== 'ghecpkpaxbrvehquhzkr') throw Error('Public storage requires the explicit Staging target.');
    const projection=new PublicMarketProjection(universe,selected);
    this.universe=projection.universe; this.selected=projection.selected;
  }
  private decode(row: StoredStream, now: number) {
    const revision=Number(row.revision);
    if (!Number.isSafeInteger(revision)||revision<1||!/^[a-f0-9]{64}$/.test(row.last_batch_id)) throw Error('Invalid persisted public stream.');
    cursorIdentity(row.cursor);
    const checkpoint=typeof row.checkpoint==='string'?row.checkpoint:JSON.stringify(row.checkpoint);
    const projection=PublicMarketProjection.restore(checkpoint,now);
    if (JSON.stringify(projection.universe)!==JSON.stringify(this.universe)||JSON.stringify(projection.selected)!==JSON.stringify(this.selected)) throw Error('Public stream coverage mismatch.');
    return {revision,projection,cursor:row.cursor,lastBatchId:row.last_batch_id};
  }
  private async load(client: PoolClient, lock: boolean) {
    const result=await client.query<StoredStream>(`SELECT revision, cursor, checkpoint, last_batch_id FROM ${table} WHERE source_id = $1${lock?' FOR UPDATE':''}`,[PUBLIC_MARKET_SOURCE]);
    if(result.rows.length>1)throw Error('Ambiguous public stream identity.');
    return result.rows[0];
  }
  async read(now: number) {
    const client=await this.connection.connect();
    try {const row=await this.load(client,false);return row?this.decode(row,now).projection.view(now):null;} finally {client.release();}
  }
  async readAcknowledgement(now: number) {
    const client=await this.connection.connect();
    try {
      const row=await this.load(client,false);if(!row)return null;
      const decoded=this.decode(row,now);
      return {cursor:structuredClone(decoded.cursor),revision:decoded.revision,batchId:decoded.lastBatchId};
    } finally {client.release();}
  }
  async commit(sourceId: string, raw: MarketJournalBatch, now: number) {
    if(sourceId!==PUBLIC_MARKET_SOURCE)throw Error('Untrusted public stream source.');
    const batch=validatePublicMarketBatch(raw,now);
    cursorIdentity(batch.to); if(batch.from)cursorIdentity(batch.from);
    const client=await this.connection.connect(); let begun=false,committing=false,discard=false;
    try {
      // BEGIN's response can be lost after the server opened a transaction.
      // Attempt rollback (or discard) even when that first await rejects.
      begun=true;await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '3s'");await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[`public-market:${PUBLIC_MARKET_SOURCE}`]);
      const row=await this.load(client,true),existing=row?this.decode(row,now):null;
      let duplicate=false;
      if(existing?.lastBatchId===batch.batchId) {
        if(cursorIdentity(existing.cursor)!==cursorIdentity(batch.to))throw Error('Public batch acknowledgement conflict.');
        duplicate=true;
      } else {
        if(cursorIdentity(existing?.cursor??null)!==cursorIdentity(batch.from))throw Error('Public cursor compare-and-set conflict.');
        const projection=existing?.projection??new PublicMarketProjection(this.universe,this.selected);
        for(const record of batch.records)projection.ingest(record.envelope.observation,record.envelope.observation.receivedAt);
        const revision=(existing?.revision??0)+1;if(!Number.isSafeInteger(revision))throw Error('Public revision exhausted.');
        const checkpoint=projection.checkpoint();if(Buffer.byteLength(checkpoint)>4*1024*1024)throw Error('Public checkpoint capacity exceeded.');
        const result=existing
          ?await client.query(`UPDATE ${table} SET revision=$1, cursor=$2::jsonb, checkpoint=$3::jsonb, last_batch_id=$4, updated_at=CURRENT_TIMESTAMP WHERE source_id=$5 AND revision=$6`,[revision,JSON.stringify(batch.to),checkpoint,batch.batchId,PUBLIC_MARKET_SOURCE,existing.revision])
          :await client.query(`INSERT INTO ${table} (source_id,revision,cursor,checkpoint,last_batch_id) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5) ON CONFLICT (source_id) DO NOTHING`,[PUBLIC_MARKET_SOURCE,revision,JSON.stringify(batch.to),checkpoint,batch.batchId]);
        if(result.rowCount!==1)throw Error('Public revision compare-and-set conflict.');
      }
      const response={batchId:batch.batchId,cursor:structuredClone(batch.to),duplicate};
      committing=true;await client.query('COMMIT');begun=false;return response;
    } catch(error) {
      if(committing){discard=true;throw Error('Public commit outcome unknown; retry the original batch identity after reconciliation.');}
      if(begun)try{await client.query('ROLLBACK');}catch{discard=true;}
      throw error;
    } finally {client.release(discard);}
  }
}
