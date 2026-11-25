import { decryptCredential, encryptCredential } from '../binance-credentials';
import { query } from '../db';
import { getExchangeDefinition } from './registry';
import { assertExchangeFoundationReady } from './schema';
import type { ExchangeCredentials, ExchangeEnvironment, ExchangeId } from './types';
import { isExchangeEnvironment } from './types';

type CredentialRow = {
  api_key_ciphertext: string;
  api_secret_ciphertext: string;
  passphrase_ciphertext: string | null;
  environment_confirmed: boolean;
};

function assertCredentialFields(exchange: ExchangeId, credentials: ExchangeCredentials) {
  const definition = getExchangeDefinition(exchange, exchange === 'GATE' ? 'TESTNET' : 'DEMO');
  if (
    typeof credentials.apiKey !== 'string' || credentials.apiKey.trim().length < 8 || credentials.apiKey.length > 256 ||
    typeof credentials.apiSecret !== 'string' || credentials.apiSecret.trim().length < 8 || credentials.apiSecret.length > 512
  ) {
    throw new Error('Enter valid API key and secret values.');
  }
  if (
    definition.requiredCredentialFields.includes('passphrase') &&
    (typeof credentials.passphrase !== 'string' || credentials.passphrase.trim().length < 1 || credentials.passphrase.length > 256)
  ) {
    throw new Error(`${definition.name} requires an API passphrase.`);
  }
  if (!definition.requiredCredentialFields.includes('passphrase') && credentials.passphrase !== undefined) {
    throw new Error(`${definition.name} does not accept a passphrase.`);
  }
}

export async function saveExchangeCredentials(
  userId: number,
  exchange: ExchangeId,
  environment: ExchangeEnvironment,
  credentials: ExchangeCredentials,
) {
  await assertExchangeFoundationReady();
  if (!isExchangeEnvironment(exchange, environment)) throw new Error(`${exchange} does not support ${environment}.`);
  assertCredentialFields(exchange, credentials);
  const apiKey = credentials.apiKey.trim();
  const encryptedKey = encryptCredential(apiKey);
  const encryptedSecret = encryptCredential(credentials.apiSecret.trim());
  await query(
    `INSERT INTO public.exchange_api_credentials (
       user_id, exchange, environment, api_key_ciphertext, api_secret_ciphertext,
       passphrase_ciphertext, api_key_suffix, environment_confirmed, last_verified_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NULL, NOW())
     ON CONFLICT (user_id, exchange, environment) DO UPDATE SET
       api_key_ciphertext = EXCLUDED.api_key_ciphertext,
       api_secret_ciphertext = EXCLUDED.api_secret_ciphertext,
       passphrase_ciphertext = EXCLUDED.passphrase_ciphertext,
       api_key_suffix = EXCLUDED.api_key_suffix,
       environment_confirmed = TRUE,
       last_verified_at = NULL,
       updated_at = NOW()`,
    [
      userId,
      exchange,
      environment,
      encryptedKey,
      encryptedSecret,
      credentials.passphrase === undefined ? null : encryptCredential(credentials.passphrase),
      apiKey.slice(-4),
    ],
  );
  if (exchange === 'BINANCE') {
    try {
      await query(
        `INSERT INTO public.binance_api_credentials (
           user_id, environment, api_key_ciphertext, api_secret_ciphertext, environment_confirmed, updated_at
         ) VALUES ($1, $2, $3, $4, TRUE, NOW())
         ON CONFLICT (user_id, environment) DO UPDATE SET
           api_key_ciphertext = EXCLUDED.api_key_ciphertext,
           api_secret_ciphertext = EXCLUDED.api_secret_ciphertext,
           environment_confirmed = TRUE,
           updated_at = NOW()`,
        [userId, environment, encryptedKey, encryptedSecret],
      );
    } catch {}
  }
}

export async function removeExchangeCredentials(
  userId: number,
  exchange: ExchangeId,
  environment: ExchangeEnvironment,
) {
  await assertExchangeFoundationReady();
  if (!isExchangeEnvironment(exchange, environment)) throw new Error(`${exchange} does not support ${environment}.`);
  await query(
    'DELETE FROM public.exchange_api_credentials WHERE user_id = $1 AND exchange = $2 AND environment = $3',
    [userId, exchange, environment],
  );
  if (exchange === 'BINANCE') {
    try {
      await query('DELETE FROM public.binance_api_credentials WHERE user_id = $1 AND environment = $2', [userId, environment]);
    } catch {}
  }
}

export async function loadExchangeCredentials(
  userId: number,
  exchange: ExchangeId,
  environment: ExchangeEnvironment,
): Promise<ExchangeCredentials> {
  await assertExchangeFoundationReady();
  if (!isExchangeEnvironment(exchange, environment)) throw new Error(`${exchange} does not support ${environment}.`);
  const result = await query<CredentialRow>(
    `SELECT api_key_ciphertext, api_secret_ciphertext, passphrase_ciphertext, environment_confirmed
       FROM public.exchange_api_credentials
      WHERE user_id = $1 AND exchange = $2 AND environment = $3`,
    [userId, exchange, environment],
  );
  let stored = result.rows[0];
  if (!stored && exchange === 'BINANCE') {
    const legacy = await query<{ api_key_ciphertext: string; api_secret_ciphertext: string; environment_confirmed: boolean }>(
      `SELECT api_key_ciphertext, api_secret_ciphertext, environment_confirmed
         FROM public.binance_api_credentials
        WHERE user_id = $1 AND environment = $2`,
      [userId, environment],
    );
    if (legacy.rows[0]) {
      stored = { ...legacy.rows[0], passphrase_ciphertext: null };
    }
  }
  if (!stored) throw new Error(`Save ${exchange} ${environment} API credentials before connecting.`);
  if (!stored.environment_confirmed) {
    throw new Error(`Re-enter the ${exchange} ${environment} credentials to confirm their environment before connecting.`);
  }
  try {
    return {
      apiKey: decryptCredential(stored.api_key_ciphertext),
      apiSecret: decryptCredential(stored.api_secret_ciphertext),
      ...(stored.passphrase_ciphertext
        ? { passphrase: decryptCredential(stored.passphrase_ciphertext) }
        : {}),
    };
  } catch {
    throw new Error('Stored exchange credentials could not be decrypted. Check the existing BINANCE_CREDENTIALS_KEY and save these credentials again.');
  }
}

export async function getExchangeCredentialStatus(
  userId: number,
  exchange: ExchangeId,
  environment: ExchangeEnvironment,
) {
  await assertExchangeFoundationReady();
  if (!isExchangeEnvironment(exchange, environment)) throw new Error(`${exchange} does not support ${environment}.`);
  const result = await query<{
    api_key_suffix: string | null;
    last_verified_at: string | null;
    updated_at: string;
    environment_confirmed: boolean;
  }>(
    `SELECT api_key_suffix, last_verified_at, updated_at, environment_confirmed
       FROM public.exchange_api_credentials
      WHERE user_id = $1 AND exchange = $2 AND environment = $3`,
    [userId, exchange, environment],
  );
  let row = result.rows[0];
  if (!row && exchange === 'BINANCE') {
    const legacy = await query<{ environment_confirmed: boolean; updated_at: string }>(
      `SELECT environment_confirmed, updated_at
         FROM public.binance_api_credentials
        WHERE user_id = $1 AND environment = $2`,
      [userId, environment],
    );
    if (legacy.rows[0]) {
      row = {
        api_key_suffix: null,
        last_verified_at: null,
        updated_at: legacy.rows[0].updated_at,
        environment_confirmed: legacy.rows[0].environment_confirmed,
      };
    }
  }
  return {
    exchange,
    environment,
    configured: row?.environment_confirmed === true,
    environmentConfirmationRequired: Boolean(row && !row.environment_confirmed),
    maskedApiKey: row?.api_key_suffix ? `••••${row.api_key_suffix}` : null,
    lastVerifiedAt: row?.last_verified_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function markExchangeCredentialsVerified(
  userId: number,
  exchange: ExchangeId,
  environment: ExchangeEnvironment,
) {
  await assertExchangeFoundationReady();
  const result = await query(
    `UPDATE public.exchange_api_credentials
        SET last_verified_at = NOW(), updated_at = NOW()
      WHERE user_id = $1 AND exchange = $2 AND environment = $3`,
    [userId, exchange, environment],
  );
  if (!result.rowCount) throw new Error('Exchange credentials were removed before the connection test completed.');
}
