export function resolveBackendBaseUrl(): string | null {
  const raw = process.env.SMARTEXIT_BACKEND_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function shouldForwardToBackend(): boolean {
  const backend = resolveBackendBaseUrl();
  if (!backend) return false;
  // Never create a proxy loop on the dedicated backend container itself
  if (process.env.SCANNER_CIRCUIT_BREAKER_SCOPE?.trim().toLowerCase() === 'northflank') {
    return false;
  }
  return (
    process.env.VERCEL === '1' ||
    process.env.RENDER === 'true' ||
    process.env.SMARTEXIT_FORCE_BACKEND_PROXY === 'true'
  );
}
