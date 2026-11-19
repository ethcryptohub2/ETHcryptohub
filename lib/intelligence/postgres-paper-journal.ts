import type { Pool, PoolClient } from 'pg';
import { assertPaperTenant, type PaperActor, type PaperJournal, type TenantPaperState } from './tenant-paper';
import { paperStateSchema } from './paper-state-schema';

const table = 'smartexit_private.paper_account_states';
const maximumStateBytes = 4 * 1024 * 1024;

function validateState(value: unknown, tenantId: number, revision: unknown): TenantPaperState {
  const state = value as TenantPaperState;
  if (!paperStateSchema.safeParse(value).success || state.tenantId !== tenantId || String(state.revision) !== String(revision)) {
    throw new Error('Paper database journal state is invalid.');
  }
  const encoded = JSON.stringify(state);
  if (Buffer.byteLength(encoded) > maximumStateBytes) throw new Error('Paper database journal capacity exceeded.');
  // Journals are credential-free. Reject unexpected fields instead of retaining
  // credentials accidentally added by a future caller or corrupt stored state.
  const allowed = ['version', 'revision', 'tenantId', 'configuration', 'equity', 'peakEquity', 'dayStartEquity',
    'day', 'realizedDailyPnl', 'consecutiveLosses', 'lastLossAt', 'killSwitch', 'exchangeAvailable', 'lastEventAt', 'orders', 'audit'];
  if (Object.keys(state).some(key => !allowed.includes(key)) ||
      /"(?:apiKey|apiSecret|accessToken|refreshToken|password|credentials|secret)"\s*:/i.test(encoded)) {
    throw new Error('Unsupported credential-bearing paper database journal state.');
  }
  return structuredClone(state);
}

/** Unwired storage foundation. No pool creation, environment reads or remote activation.
 * Actor MUST come from verified server identity, never request JSON or query parameters.
 * Use a separately reviewed private-schema database role; RLS does not constrain a bypass role.
 */
export class PostgresPaperJournal implements PaperJournal {
  private readonly tenantId: number;
  constructor(private readonly pool: Pick<Pool, 'connect'>, actor: PaperActor) {
    assertPaperTenant(actor);
    this.tenantId = actor.tenantId;
  }
  private assertTenant(tenantId: number) {
    if (tenantId !== this.tenantId) throw new Error('Paper account ownership is required.');
  }
  private async load(client: PoolClient, tenantId: number, lock: boolean) {
    const result = await client.query(`SELECT state, revision FROM ${table} WHERE tenant_user_id = $1${lock ? ' FOR UPDATE' : ''}`, [tenantId]);
    if (result.rows.length > 1) throw new Error('Paper database journal identity is ambiguous.');
    return result.rows.length ? validateState(result.rows[0].state, tenantId, result.rows[0].revision) : null;
  }
  async read(tenantId: number): Promise<TenantPaperState | null> {
    this.assertTenant(tenantId);
    const client = await this.pool.connect();
    try { return await this.load(client, tenantId, false); } finally { client.release(); }
  }
  async transact<T>(tenantId: number, work: (state: TenantPaperState | null) => { state: TenantPaperState; result: T }): Promise<T> {
    this.assertTenant(tenantId);
    const client = await this.pool.connect();
    let begun = false;
    let committing = false;
    let discard = false;
    try {
      await client.query('BEGIN'); begun = true;
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      // Transaction-scoped lock covers the absent-row first-write race too.
      // Never use session advisory locks with transaction-pooled Supabase connections.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`smartexit-paper:${tenantId}`]);
      const existing = await this.load(client, tenantId, true);
      const previousRevision = existing?.revision ?? 0;
      const previousEncoded = JSON.stringify(existing);
      const update = work(structuredClone(existing));
      if (update && typeof (update as unknown as { then?: unknown }).then === 'function') {
        void Promise.resolve(update).catch(() => undefined);
        throw new Error('Paper journal callbacks must be synchronous.');
      }
      const next = validateState(update.state, tenantId, update.state.revision);
      if (next.revision < previousRevision || next.revision > previousRevision + 1 ||
          (next.revision === previousRevision && JSON.stringify(next) !== previousEncoded)) {
        throw new Error('Paper database journal revision conflict.');
      }
      // Idempotent acknowledgements leave both state and revision unchanged.
      if (!existing || next.revision !== previousRevision) {
        const result = existing
          ? await client.query(`UPDATE ${table} SET state = $1::jsonb, revision = $2, updated_at = CURRENT_TIMESTAMP WHERE tenant_user_id = $3 AND revision = $4`, [JSON.stringify(next), next.revision, tenantId, previousRevision])
          : await client.query(`INSERT INTO ${table} (tenant_user_id, revision, state) VALUES ($1, $2, $3::jsonb) ON CONFLICT (tenant_user_id) DO NOTHING`, [tenantId, next.revision, JSON.stringify(next)]);
        if (result.rowCount !== 1) throw new Error('Paper database journal revision conflict.');
      }
      // Clone before COMMIT: a non-serializable result cannot cause an apparent
      // failure after a successful write.
      const response = structuredClone(update.result);
      committing = true;
      await client.query('COMMIT'); begun = false;
      return response;
    } catch (error) {
      if (committing) {
        discard = true;
        throw new Error('Paper commit outcome is unknown; reconcile using the original idempotency key before retrying.');
      }
      if (begun) try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }
}
