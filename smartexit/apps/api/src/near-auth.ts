import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import type { Database } from './database.js';

const SESSION_DAYS = 30;
const CHALLENGE_MINUTES = 5;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type NearNetwork = 'mainnet' | 'testnet';

export function configuredNearNetwork(value = process.env.NEAR_NETWORK ?? 'testnet'): NearNetwork {
  if (value !== 'mainnet' && value !== 'testnet') {
    throw new Error('NEAR_NETWORK must be either "mainnet" or "testnet".');
  }
  return value;
}

export function nearRpcUrls(network: NearNetwork): [string, string] {
  return network === 'testnet'
    ? ['https://near-testnet.drpc.org', 'https://test.rpc.fastnear.com']
    : ['https://near.drpc.org', 'https://free.rpc.fastnear.com'];
}

export interface PaperUser {
  id: string;
  nearAccountId: string;
  startingBalance: number;
  realizedPnl: number;
}

export interface PaperAssetBalance {
  asset: string;
  startingBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  cashBalance: number;
}

export interface NearChallenge {
  id: string;
  nonce: string;
  message: string;
  recipient: string;
}

interface LoginProof {
  challengeId: string;
  accountId: string;
  publicKey: string;
  signature: string;
  initialBalance: number;
}

function decodeBase58(value: string): Buffer {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Invalid base58 value.');
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function nearSignedMessagePayload(message: string, nonce: Buffer, recipient: string): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  return createHash('sha256')
    .update(Buffer.concat([tag, borshString(message), nonce, borshString(recipient), Buffer.from([0])]))
    .digest();
}

function mapUser(row: Record<string, unknown>): PaperUser {
  return {
    id: String(row.id),
    nearAccountId: String(row.near_account_id),
    startingBalance: Number(row.starting_balance),
    realizedPnl: Number(row.realized_pnl),
  };
}

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export class NearAuthService {
  constructor(
    private readonly db: Database,
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly network: NearNetwork = configuredNearNetwork(),
  ) {}

  async createChallenge(recipient: string): Promise<NearChallenge> {
    const id = randomUUID();
    const nonce = randomBytes(32);
    const now = this.now();
    const message = `Sign in to SmartExit paper trading. Challenge: ${id}. Issued: ${now.toISOString()}.`;
    const expiresAt = new Date(now.getTime() + CHALLENGE_MINUTES * 60_000).toISOString();
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM auth_challenges WHERE expires_at <= $1', [now.toISOString()]);
      await tx.query('DELETE FROM paper_sessions WHERE expires_at <= $1', [now.toISOString()]);
      await tx.query(
        'INSERT INTO auth_challenges (id, nonce, message, recipient, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [id, nonce, message, recipient, expiresAt],
      );
    });
    return { id, nonce: nonce.toString('base64'), message, recipient };
  }

  async login(proof: LoginProof): Promise<{ user: PaperUser; sessionToken: string }> {
    const accountId = proof.accountId.toLowerCase();
    if (!/^(?:[a-z0-9_-]+\.)*(?:near|testnet|[a-z0-9_-]+)$/.test(accountId) || accountId.length > 64) {
      throw new NearAuthError(400, 'Invalid NEAR account ID.');
    }
    if (
      !Number.isFinite(proof.initialBalance) ||
      proof.initialBalance < 1 ||
      proof.initialBalance > 1_000_000_000
    ) {
      throw new NearAuthError(400, 'Starting paper balance must be between 1 and 1,000,000,000 USDT.');
    }
    const { rows: challenges } = await this.db.query('SELECT * FROM auth_challenges WHERE id = $1', [
      proof.challengeId,
    ]);
    const challenge = challenges[0];
    if (!challenge || dateValue(challenge.expires_at).getTime() <= this.now().getTime()) {
      throw new NearAuthError(401, 'Sign-in challenge expired. Please try again.');
    }
    const publicKey = proof.publicKey.split(':');
    if (publicKey.length !== 2 || publicKey[0] !== 'ed25519') {
      throw new NearAuthError(400, 'Only NEAR Ed25519 wallet keys are supported for sign-in.');
    }
    let keyBytes: Buffer;
    try {
      keyBytes = decodeBase58(publicKey[1]!);
    } catch {
      throw new NearAuthError(400, 'Invalid NEAR public-key encoding.');
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(proof.signature)) {
      throw new NearAuthError(400, 'Invalid NEAR signature encoding.');
    }
    const signatureBytes = Buffer.from(proof.signature, 'base64');
    if (keyBytes.length !== 32 || signatureBytes.length !== 64) {
      throw new NearAuthError(400, 'Invalid NEAR sign-in proof.');
    }
    const nonce = Buffer.isBuffer(challenge.nonce) ? challenge.nonce : Buffer.from(challenge.nonce as Uint8Array);
    if (
      !verify(
        null,
        nearSignedMessagePayload(String(challenge.message), nonce, String(challenge.recipient)),
        createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]), format: 'der', type: 'spki' }),
        signatureBytes,
      )
    ) {
      throw new NearAuthError(401, 'NEAR wallet signature did not match the sign-in challenge.');
    }
    await this.verifyAccountKey(accountId, proof.publicKey);

    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + SESSION_DAYS * 24 * 60 * 60_000).toISOString();
    const user = await this.db.transaction(async (tx) => {
      const { rows: currentChallenges } = await tx.query(
        'SELECT id FROM auth_challenges WHERE id = $1 AND expires_at > $2 FOR UPDATE',
        [proof.challengeId, this.now().toISOString()],
      );
      if (!currentChallenges[0]) throw new NearAuthError(401, 'Sign-in challenge has already been used.');
      const { rows: existingUsers } = await tx.query('SELECT * FROM paper_users WHERE near_account_id = $1', [
        accountId,
      ]);
      let row = existingUsers[0];
      if (!row) {
        const id = randomUUID();
        const createdAt = this.now().toISOString();
        await tx.query(
          `INSERT INTO paper_users (id, near_account_id, starting_balance, created_at)
           VALUES ($1, $2, $3, $4) ON CONFLICT (near_account_id) DO NOTHING`,
          [id, accountId, proof.initialBalance, createdAt],
        );
        const { rows: insertedUsers } = await tx.query('SELECT * FROM paper_users WHERE near_account_id = $1', [
          accountId,
        ]);
        row = insertedUsers[0]!;
        await tx.query(
          `INSERT INTO paper_asset_balances (user_id, asset, starting_balance, realized_pnl)
           VALUES ($1, 'USDT', $2, 0) ON CONFLICT DO NOTHING`,
          [String(row.id), proof.initialBalance],
        );
        await tx.query(
          `INSERT INTO risk_settings
           (user_id, paper_equity, max_open_positions, max_risk_per_trade_percent,
            max_daily_loss_percent, kill_switch_enabled, updated_at)
           VALUES ($1, $2, 3, 1, 3, FALSE, $3) ON CONFLICT (user_id) DO NOTHING`,
          [String(row.id), proof.initialBalance, createdAt],
        );
      }
      await tx.query('DELETE FROM auth_challenges WHERE id = $1', [proof.challengeId]);
      await tx.query('INSERT INTO paper_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
        createHash('sha256').update(sessionToken).digest('hex'),
        String(row.id),
        expiresAt,
      ]);
      return mapUser(row);
    });
    return { user, sessionToken };
  }

  async authenticate(token: string | undefined): Promise<PaperUser | null> {
    if (!token) return null;
    const { rows } = await this.db.query(
      `SELECT u.* FROM paper_sessions s JOIN paper_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [createHash('sha256').update(token).digest('hex'), this.now().toISOString()],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) {
      await this.db.query('DELETE FROM paper_sessions WHERE token_hash = $1', [
        createHash('sha256').update(token).digest('hex'),
      ]);
    }
  }

  async portfolio(userId: string): Promise<{
    startingBalance: number;
    realizedPnl: number;
    unrealizedPnl: number;
    assetBalances: PaperAssetBalance[];
  }> {
    const { rows: users } = await this.db.query(
      'SELECT starting_balance, realized_pnl FROM paper_users WHERE id = $1',
      [userId],
    );
    const user = users[0];
    if (!user) throw new NearAuthError(404, 'Paper portfolio not found.');
    const { rows: balances } = await this.db.query(
      'SELECT asset, starting_balance, realized_pnl FROM paper_asset_balances WHERE user_id = $1',
      [userId],
    );
    const { rows: unrealized } = await this.db.query(
      `SELECT quote_asset AS asset,
       SUM(CASE WHEN side = 'LONG' THEN (current_price - entry_price) * quantity
         ELSE (entry_price - current_price) * quantity END) AS unrealized_pnl
       FROM trades WHERE user_id = $1 AND status IN ('OPEN', 'TP1_HIT_TRAILING', 'TP2_HIT_TRAILING')
       GROUP BY quote_asset`,
      [userId],
    );
    const unrealizedByAsset = new Map(
      unrealized.map((item) => [String(item.asset), Number(item.unrealized_pnl)]),
    );
    const knownAssets = new Set([
      ...balances.map((item) => String(item.asset)),
      ...unrealizedByAsset.keys(),
      'USDT',
    ]);
    const assetBalances = [...knownAssets].sort().map((asset) => {
      const balance = balances.find((item) => item.asset === asset);
      const startingBalance = Number(balance?.starting_balance ?? (asset === 'USDT' ? user.starting_balance : 0));
      const realizedPnl = Number(balance?.realized_pnl ?? 0);
      return {
        asset,
        startingBalance,
        realizedPnl,
        unrealizedPnl: unrealizedByAsset.get(asset) ?? 0,
        cashBalance: startingBalance + realizedPnl,
      };
    });
    return {
      startingBalance: Number(user.starting_balance),
      realizedPnl: Number(user.realized_pnl),
      unrealizedPnl: unrealizedByAsset.get('USDT') ?? 0,
      assetBalances,
    };
  }

  async updateStartingBalance(userId: string, startingBalance: number): Promise<void> {
    if (!Number.isFinite(startingBalance) || startingBalance < 1 || startingBalance > 1_000_000_000) {
      throw new NearAuthError(400, 'Starting paper balance must be between 1 and 1,000,000,000 USDT.');
    }
    await this.db.transaction(async (tx) => {
      await tx.query('UPDATE paper_users SET starting_balance = $1 WHERE id = $2', [startingBalance, userId]);
      await tx.query(
        'UPDATE risk_settings SET paper_equity = $1, updated_at = $2 WHERE user_id = $3',
        [startingBalance, this.now().toISOString(), userId],
      );
      await tx.query(
        `INSERT INTO paper_asset_balances (user_id, asset, starting_balance, realized_pnl)
         VALUES ($1, 'USDT', $2, 0)
         ON CONFLICT (user_id, asset) DO UPDATE SET starting_balance = EXCLUDED.starting_balance`,
        [userId, startingBalance],
      );
    });
  }

  async resetPaperPortfolio(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query('SELECT id FROM paper_users WHERE id = $1 FOR UPDATE', [userId]);
      if (!rows[0]) throw new NearAuthError(404, 'Paper portfolio not found.');
      const now = this.now().toISOString();
      await tx.query('DELETE FROM trade_events WHERE trade_id IN (SELECT id FROM trades WHERE user_id = $1)', [
        userId,
      ]);
      await tx.query('DELETE FROM trades WHERE user_id = $1', [userId]);
      await tx.query('DELETE FROM daily_stats WHERE user_id = $1', [userId]);
      await tx.query('DELETE FROM paper_asset_balances WHERE user_id = $1', [userId]);
      await tx.query('UPDATE paper_users SET starting_balance = 10000, realized_pnl = 0 WHERE id = $1', [userId]);
      await tx.query(
        `INSERT INTO paper_asset_balances (user_id, asset, starting_balance, realized_pnl)
         VALUES ($1, 'USDT', 10000, 0)`,
        [userId],
      );
      await tx.query('UPDATE risk_settings SET paper_equity = 10000, updated_at = $1 WHERE user_id = $2', [
        now,
        userId,
      ]);
    });
  }

  private async verifyAccountKey(accountId: string, publicKey: string): Promise<void> {
    let response: Response;
    try {
      const [rpcUrl] = nearRpcUrls(this.network);
      response = await this.request(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'smartexit-wallet-auth',
          method: 'query',
          params: {
            request_type: 'view_access_key',
            finality: 'final',
            account_id: accountId,
            public_key: publicKey,
          },
        }),
      });
    } catch {
      throw new NearAuthError(503, 'NEAR account verification is temporarily unavailable.');
    }
    if (!response.ok) throw new NearAuthError(503, 'NEAR account verification is temporarily unavailable.');
    let body: { result?: unknown; error?: unknown };
    try {
      body = (await response.json()) as { result?: unknown; error?: unknown };
    } catch {
      throw new NearAuthError(503, 'NEAR account verification returned an invalid response.');
    }
    const result = body.result;
    const isAccessKey =
      typeof result === 'object' &&
      result !== null &&
      'nonce' in result &&
      typeof result.nonce === 'number' &&
      'permission' in result;
    if (!isAccessKey || body.error)
      throw new NearAuthError(401, 'The signed key is not registered to this NEAR account.');
  }
}

export class NearAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
