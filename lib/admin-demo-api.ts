import { AuthError } from './auth';
import { AdminDemoSchemaNotReadyError } from './admin-demo-authorization';

export function adminDemoApiError(error: unknown) {
  if (error instanceof AuthError) {
    return { status: error.status, error: error.message };
  }
  if (error instanceof AdminDemoSchemaNotReadyError) {
    return { status: 503, error: 'SCHEMA_NOT_READY: approved Admin Demo schema and server configuration are required.' };
  }
  return { status: 409, error: 'Admin Demo action is blocked or could not be verified. No success is recorded.' };
}

export function noStoreJson(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
