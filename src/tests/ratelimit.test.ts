import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { rateLimit } from '~/lib/ratelimit';

describe('rateLimit', () => {
  it('allows up to N then blocks', async () => {
    const key = `unit-test-${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      const r = await rateLimit(env.KV, key, 3, 60);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(2 - i);
    }
    const overflow = await rateLimit(env.KV, key, 3, 60);
    expect(overflow.allowed).toBe(false);
    expect(overflow.remaining).toBe(0);
  });

  it('uses independent counters per key', async () => {
    const a = `unit-test-${crypto.randomUUID()}`;
    const b = `unit-test-${crypto.randomUUID()}`;
    await rateLimit(env.KV, a, 1, 60);
    expect((await rateLimit(env.KV, a, 1, 60)).allowed).toBe(false);
    expect((await rateLimit(env.KV, b, 1, 60)).allowed).toBe(true);
  });
});
