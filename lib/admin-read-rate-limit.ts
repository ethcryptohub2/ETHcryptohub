/** Bounds authenticated diagnostics reads on each warm instance without database writes. */
export function createAdminReadLimiter(maximum = 120) {
  const buckets = new Map<number, { used: number; endsAt: number }>();
  return (actorId: number) => {
    const now = performance.now();
    const bucket = buckets.get(actorId);
    if (bucket && bucket.endsAt > now) {
      if (bucket.used >= maximum) return false;
      bucket.used++;
      return true;
    }
    if (buckets.size >= 1024) {
      for (const [id, entry] of buckets) {
        if (entry.endsAt <= now) buckets.delete(id);
      }
      if (buckets.size >= 1024) return false;
    }
    buckets.set(actorId, { used: 1, endsAt: now + 60_000 });
    return true;
  };
}
