import { z } from 'zod';
import type { NextRequest } from 'next/server';
import {
  AdminDemoRequestValidationError,
  AdminDemoRouteContext,
  getProviderService,
  readOptionalJson,
  resolveProvider,
  withAdmin,
  withMutation,
} from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const credentialSchema = z.object({
  apiKey: z.string().trim().min(8).max(256),
  apiSecret: z.string().trim().min(8).max(512),
  passphrase: z.string().trim().min(1).max(256).optional(),
  ownerConfirmed: z.literal(true),
  environment: z.enum(['DEMO', 'TESTNET']).optional(),
}).strict();

export async function GET(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withAdmin(async (admin) => {
    const { provider } = await params;
    const scope = await resolveProvider(request, provider);
    const service = await getProviderService();
    return service.getCredentialStatus(admin, scope.provider);
  });
}

export async function POST(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withMutation(request, async (admin) => {
    const { provider } = await params;
    const parsed = credentialSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AdminDemoRequestValidationError('Invalid Admin Demo credential request.');
    const scope = await resolveProvider(request, provider, parsed.data.environment);
    const service = await getProviderService();
    return service.saveCredential(admin, scope.provider, {
      apiKey: parsed.data.apiKey,
      apiSecret: parsed.data.apiSecret,
      ...(parsed.data.passphrase ? { passphrase: parsed.data.passphrase } : {}),
      ownerConfirmed: true,
    });
  }, 201);
}

export async function DELETE(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withMutation(request, async (admin) => {
    const { provider } = await params;
    const body = await readOptionalJson(request);
    const schema = z.object({ environment: z.enum(['DEMO', 'TESTNET']).optional() }).strict();
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new AdminDemoRequestValidationError('Invalid Admin Demo credential request.');
    const scope = await resolveProvider(request, provider, parsed.data.environment);
    const service = await getProviderService();
    return { revoked: await service.revokeCredential(admin, scope.provider) };
  });
}
