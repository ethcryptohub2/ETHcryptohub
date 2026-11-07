import { createHmac } from 'node:crypto';
import type { User } from './auth';

function base64Url(value: string) {
  return Buffer.from(value).toString('base64url');
}

export function createSupabaseRealtimeToken(user: Pick<User, 'id' | 'email'>, now = Date.now()) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SUPABASE_JWT_SECRET must contain at least 32 characters to enable authenticated realtime.');
  }
  const issuedAt = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    aud: 'authenticated',
    role: 'authenticated',
    sub: String(user.id),
    app_user_id: String(user.id),
    email: user.email,
    email_verified: true,
    iat: issuedAt,
    exp: issuedAt + 600,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return { token: `${signingInput}.${signature}`, expiresAt: issuedAt + 600 };
}
