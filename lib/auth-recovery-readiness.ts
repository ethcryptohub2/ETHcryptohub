export class PasswordRecoveryUnavailableError extends Error {
  constructor() {
    super('Password recovery is temporarily unavailable.');
    this.name = 'PasswordRecoveryUnavailableError';
  }
}

export async function assertPasswordRecoveryReady(
  query: (sql: string) => Promise<{ rows: Array<{ ready: boolean }> }>,
) {
  const result = await query("SELECT to_regclass('public.auth_password_reset_codes') IS NOT NULL AS ready");
  if (result.rows[0]?.ready !== true) throw new PasswordRecoveryUnavailableError();
}
