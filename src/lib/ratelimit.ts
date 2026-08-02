/**
 * Tiny fixed-window rate limiter on KvStore.
 */

import type { KvStore } from '~/platform/kv';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export async function rateLimit(
  kv: KvStore,
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
