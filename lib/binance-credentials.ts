import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key() {
  const value = process.env.BINANCE_CREDENTIALS_KEY ?? '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('BINANCE_CREDENTIALS_KEY must be 32 random bytes encoded as 64 hex characters.');
  return Buffer.from(value, 'hex');
}

export function encryptCredential(value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${nonce.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${ciphertext.toString('hex')}`;
}

export function decryptCredential(value: string) {
  if (!value.includes('.')) {
    const legacy = Buffer.from(value, 'base64');
    if (legacy.toString('base64') !== value || legacy.length < 29) throw new Error('Stored exchange credentials have an invalid format.');
    const decipher = createDecipheriv('aes-256-gcm', key(), legacy.subarray(0, 12));
    decipher.setAuthTag(legacy.subarray(12, 28));
    return Buffer.concat([decipher.update(legacy.subarray(28)), decipher.final()]).toString('utf8');
  }
  const [nonceHex, tagHex, ciphertextHex] = value.split('.');
  if (!nonceHex || !tagHex || !ciphertextHex || !/^[a-f0-9]{24}$/i.test(nonceHex) || !/^[a-f0-9]{32}$/i.test(tagHex)) {
    throw new Error('Stored exchange credentials have an invalid format.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(nonceHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
}
