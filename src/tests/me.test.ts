import { SELF, env, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const MAILGUN_BASE = 'https://api.mailgun.net';

function bodyToString(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return String(body ?? '');
}

async function signIn(email: string): Promise<string> {
  const pool = fetchMock.get(MAILGUN_BASE);
  for (let i = 0; i < 3; i++) {
    pool
      .intercept({
        path: /^\/v3\/penman\.dev\/(bounces|unsubscribes|complaints)\//,
        method: 'DELETE',
      })
      .reply(404, '{}');
  }
  let capturedText = '';
  pool.intercept({ path: '/v3/example.com/messages', method: 'POST' }).reply(
    200,
    (opts) => {
      capturedText = bodyToString(opts.body);
      return '{"id":"<x>","message":"Queued"}';
    },
    { headers: { 'content-type': 'application/json' } },
  );

  const reqRes = await SELF.fetch('https://example.com/api/auth/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(reqRes.status).toBe(204);
  const code = capturedText.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error('no code captured');

  const verifyRes = await SELF.fetch('https://example.com/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  expect(verifyRes.status).toBe(200);
  const cookie = verifyRes.headers.get('set-cookie') ?? '';
  const match = cookie.match(/rmd_sid=([^;]+)/);
  if (!match) throw new Error('no session cookie set');
  return `rmd_sid=${match[1]}`;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM users').run();
  const otps = await env.KV.list({ prefix: 'otp:' });
  await Promise.all(otps.keys.map((k) => env.KV.delete(k.name)));
  const rls = await env.KV.list({ prefix: 'rl:' });
  await Promise.all(rls.keys.map((k) => env.KV.delete(k.name)));
});

describe('GET /api/me', () => {
  it('returns 401 without a session', async () => {
    const res = await SELF.fetch('https://example.com/api/me');
    expect(res.status).toBe(401);
  });

  it('returns the signed-in user', async () => {
    const cookie = await signIn('frank@example.com');
    const res = await SELF.fetch('https://example.com/api/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string; tzConfirmed: boolean } };
    expect(body.user.email).toBe('frank@example.com');
    expect(body.user.tzConfirmed).toBe(false);
  });
});

describe('PATCH /api/me', () => {
  it('updates timezone and confirmation', async () => {
    const cookie = await signIn('grace@example.com');
    const res = await SELF.fetch('https://example.com/api/me', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'America/Los_Angeles', tzConfirmed: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { timezone: string; tzConfirmed: boolean } };
    expect(body.user.timezone).toBe('America/Los_Angeles');
    expect(body.user.tzConfirmed).toBe(true);
  });

  it('rejects an unknown timezone', async () => {
    const cookie = await signIn('heidi@example.com');
    const res = await SELF.fetch('https://example.com/api/me', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'Mars/Olympus_Mons' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty patches', async () => {
    const cookie = await signIn('ivan@example.com');
    const res = await SELF.fetch('https://example.com/api/me', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});
