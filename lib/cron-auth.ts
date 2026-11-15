import { timingSafeEqual } from 'node:crypto';

export function isAuthorizedCronRequest(authorization: string | null, secret: string | undefined) {
  if (!secret) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
  if (!match) return false;
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(match[1]!);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}
