import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { safeEqual } from '@/lib/auth';
import { sendEmailDirectly, EmailDeliveryError } from '@/lib/email';
import { query } from '@/lib/db';
import { createHash } from 'node:crypto';

const relaySchema = z.object({
  to: z.string().trim().email().max(255),
  subject: z.string().trim().min(1).max(200),
  text: z.string().max(10_000),
  html: z.string().max(20_000),
  timestamp: z.number().int().refine((ts) => Math.abs(Date.now() - ts) <= 120_000, {
    message: 'Relay request expired or invalid timestamp',
  }),
});

async function checkRelayRateLimit(clientIp: string): Promise<boolean> {
  const secret = process.env.AUTH_SECRET || 'internal-relay-secret';
  const bucket = `relay:${clientIp}:${Math.floor(Date.now() / 60_000)}`;
  const rateKey = createHash('sha256').update(`${secret}:${bucket}`).digest('hex');
  try {
    const result = await query<{ allowed: boolean }>(
      `INSERT INTO public.auth_rate_limits (rate_key, request_count, window_ends_at)
       VALUES ($1, 1, NOW() + INTERVAL '5 minutes')
       ON CONFLICT (rate_key) DO UPDATE SET
         request_count = auth_rate_limits.request_count + 1
       RETURNING request_count <= 40 AS allowed`,
      [rateKey],
    );
    return result.rows[0]?.allowed !== false;
  } catch (err) {
    console.warn('Relay rate limit check bypassed due to DB error:', err instanceof Error ? err.message : 'Unknown');
    return true;
  }
}

export async function POST(request: NextRequest) {
  try {
    const providedSecret = request.headers.get('x-relay-secret')?.trim();
    const authSecret = process.env.AUTH_SECRET?.trim();
    const cronSecret = process.env.CRON_SECRET?.trim();

    const isAuthorized = Boolean(
      providedSecret &&
      ((authSecret && safeEqual(providedSecret, authSecret)) ||
       (cronSecret && safeEqual(providedSecret, cronSecret)))
    );

    if (!isAuthorized) {
      console.warn('Unauthorized attempt to access /api/internal/email-relay');
      return NextResponse.json({ error: 'Unauthorized relay access' }, { status: 401 });
    }

    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'internal';
    const allowed = await checkRelayRateLimit(clientIp);
    if (!allowed) {
      return NextResponse.json({ error: 'Relay rate limit exceeded' }, { status: 429 });
    }

    const raw = await request.json();
    const payload = relaySchema.parse(raw);

    await sendEmailDirectly(payload.to, payload.subject, payload.text, payload.html);

    return NextResponse.json({ ok: true, delivered: true });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid relay payload format' }, { status: 422 });
    }
    if (error instanceof EmailDeliveryError) {
      console.error('Relay email delivery failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error('Unexpected email relay error:', error instanceof Error ? error.message : 'Unknown');
    return NextResponse.json({ error: 'Internal relay error' }, { status: 500 });
  }
}
