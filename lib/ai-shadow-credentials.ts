import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AiShadowProvider } from './ai-shadow-config';

type CredentialContext = { provider: AiShadowProvider; scope: string };
const providers = new Set<AiShadowProvider>(['GEMINI', 'CLAUDE', 'OPENAI']);
const envelope = /^v1\.([a-f0-9]{24})\.([a-f0-9]{32})\.([a-f0-9]{2,2048})$/;
const credentialError = () => new Error('Invalid AI provider credential envelope or configuration.');

function parameters(context: CredentialContext, encryptionKey: string) {
  if (!providers.has(context.provider) || !/^[A-Za-z0-9:_-]{1,80}$/.test(context.scope) ||
      !/^[a-f0-9]{64}$/i.test(encryptionKey)) throw credentialError();
  return { key: Buffer.from(encryptionKey, 'hex'), aad: Buffer.from(`SMARTEXIT_AI_SHADOW:v1:${context.provider}:${context.scope}`) };
}

/** Server-side primitive. No storage, configuration endpoint or provider call is wired. */
export function sealAiShadowCredential(secret: string, context: CredentialContext, encryptionKey: string): string {
  const { key, aad } = parameters(context, encryptionKey);
  if (!secret || secret.length > 1024 || !/^[\x21-\x7e]+$/.test(secret)) throw credentialError();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1.${nonce.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${ciphertext.toString('hex')}`;
}

export function unsealAiShadowCredential(value: string, context: CredentialContext, encryptionKey: string): string {
  const { key, aad } = parameters(context, encryptionKey);
  const match = envelope.exec(value);
  if (!match || match[3]!.length % 2 !== 0) throw credentialError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(match[1]!, 'hex'), { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(match[2]!, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(match[3]!, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    throw credentialError();
  }
}
