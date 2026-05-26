import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('GET /api/healthz', () => {
  it('returns ok with the configured app name', async () => {
    const res = await SELF.fetch('https://example.com/api/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; app: string; time: string };
    expect(body.status).toBe('ok');
    expect(body.app).toBe(env.APP_NAME);
    expect(typeof body.time).toBe('string');
  });
});
