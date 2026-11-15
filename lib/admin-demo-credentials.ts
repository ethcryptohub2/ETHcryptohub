import 'server-only';

import { decryptCredential } from './binance-credentials';
import type { AdminDemoQuery } from './admin-demo-execution-repository';

export type AdminDemoCredentials = {
  testAccountId: string;
  apiKey: string;
  apiSecret: string;
  environment: 'DEMO';
};

export async function loadAdminDemoCredentials(
  db: AdminDemoQuery,
  adminUserId: number,
  testAccountId: string,
): Promise<AdminDemoCredentials> {
  if (!Number.isSafeInteger(adminUserId) || adminUserId <= 0 || !/^[1-9]\d*$/.test(testAccountId)) {
    throw new Error('Dedicated Admin Demo credential scope is invalid.');
  }
  const result = await db<{
    id: string;
    api_key_ciphertext: string;
    api_secret_ciphertext: string;
    owner_confirmed_at: string;
  }>(
    `SELECT id::TEXT, api_key_ciphertext, api_secret_ciphertext, owner_confirmed_at
       FROM public.admin_binance_demo_test_accounts
      WHERE id = $1 AND admin_user_id = $2
        AND exchange = 'BINANCE' AND environment = 'DEMO'
        AND owner_confirmed_at IS NOT NULL AND revoked_at IS NULL
      LIMIT 1`,
    [testAccountId, adminUserId],
  );
  const row = result.rows[0];
  if (!row?.api_key_ciphertext || !row.api_secret_ciphertext) {
    throw new Error('Dedicated Binance Demo credentials are not configured or have been revoked.');
  }
  try {
    return {
      testAccountId: row.id,
      apiKey: decryptCredential(row.api_key_ciphertext),
      apiSecret: decryptCredential(row.api_secret_ciphertext),
      environment: 'DEMO',
    };
  } catch {
    throw new Error('Dedicated Binance Demo credentials could not be decrypted.');
  }
}
