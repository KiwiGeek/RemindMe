/**
 * Tiny fixed-window rate limiter on KV.
 *
 * - Buckets by `Math.floor(now / windowSeconds)` so the key naturally
 *   rotates without us having to delete anything.
 * - KV `put` has a 60-second eventual-consistency window; for "5 per hour"
 *   limits that's fine.
 * - Read-modify-write race: an attacker hammering in parallel could squeeze
 *   a couple of extra requests through. Acceptable at our scale; if it ever
 *   matters, swap to the Workers Rate Limiting API.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // unix seconds
}

export async function rateLimit(
  kv: KVNamespace,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / windowSeconds);
  const resetAt = (bucket + 1) * windowSeconds;
  const fullKey = `rl:${key}:${bucket}`;

  const current = Number((await kv.get(fullKey)) ?? '0');
  const next = current + 1;

  if (next > max) {
    return { allowed: false, remaining: 0, resetAt };
  }

  await kv.put(fullKey, String(next), {
    expirationTtl: Math.max(60, resetAt - now + 60),
  });

  return { allowed: true, remaining: max - next, resetAt };
}
