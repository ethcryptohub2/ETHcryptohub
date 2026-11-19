import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { PaperJournal, TenantPaperState } from './tenant-paper';

/** Local persistent-worker journal. Never use ephemeral serverless disk for durability. */
export class AtomicFilePaperJournal implements PaperJournal {
  private readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  private paths(tenantId: number) {
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error('Invalid paper journal tenant.');
    const name = createHash('sha256').update(`paper-tenant:${tenantId}`).digest('hex');
    return { data: join(this.directory, `${name}.json`), lock: join(this.directory, `${name}.lock`) };
  }
  async read(tenantId: number): Promise<TenantPaperState | null> {
    const path = this.paths(tenantId).data;
    let text: string;
    try { text = await readFile(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Paper journal could not be read.');
    }
    let state: TenantPaperState;
    try { state = JSON.parse(text) as TenantPaperState; } catch { throw new Error('Paper journal is corrupt.'); }
    if (state.version !== 1 || state.tenantId !== tenantId || !Number.isInteger(state.revision) ||
        !Array.isArray(state.orders) || !Array.isArray(state.audit) || !state.configuration ||
        !Number.isFinite(state.equity) || !Number.isFinite(state.lastEventAt)) throw new Error('Paper journal schema is invalid.');
    return structuredClone(state);
  }
  async transact<T>(tenantId: number, work: (state: TenantPaperState | null) => { state: TenantPaperState; result: T }): Promise<T> {
    const paths = this.paths(tenantId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await open(paths.lock, 'wx', 0o600); } catch { throw new Error('Paper journal is busy or requires crash-lock recovery.'); }
    let temporary: string | undefined;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, tenantId, startedAt: Date.now() }));
      await lock.sync();
      const update = work(await this.read(tenantId));
      if (update.state.tenantId !== tenantId || update.state.version !== 1) throw new Error('Paper journal tenant mismatch.');
      temporary = `${paths.data}.${randomBytes(8).toString('hex')}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(update.state)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, paths.data);
      temporary = undefined;
      return structuredClone(update.result);
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
      await lock.close();
      await unlink(paths.lock);
    }
  }
}
