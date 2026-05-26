import { SELF, env, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const MAILGUN_BASE = 'https://api.mailgun.net';

/**
 * Install Mailgun interceptors: 3 DELETE suppressions (returning 404 = nothing
 * to clear) + 1 POST /messages that captures the raw multipart body so the
 * test can extract the OTP code from the rendered email text.
 *
 * The reply callback must be synchronous (undici constraint), so we coerce
 * the body to a string and let callers regex it out.
 */
function mockMailgunSendOnce(): { capturedBody: { value: string | null } } {
  const captured: { value: string | null } = { value: null };
  const pool = fetchMock.get(MAILGUN_BASE);
  for (let i = 0; i < 3; i++) {
    pool
      .intercept({
        path: /^\/v3\/penman\.dev\/(bounces|unsubscribes|complaints)\//,
        method: 'DELETE',
      })
      .reply(404, '{}');
  }
  pool.intercept({ path: '/v3/example.com/messages', method: 'POST' }).reply(
    200,
    (opts) => {
      captured.value = bodyToString(opts.body);
      return JSON.stringify({ id: '<mock-id@example.com>', message: 'Queued. Thank you.' });
    },
    { headers: { 'content-type': 'application/json' } },
  );
  return { capturedBody: captured };
}

function bodyToString(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return String(body ?? '');
}

function extractCode(body: string | null): string {
  const m = body?.match(/\b(\d{6})\b/);
  if (!m) throw new Error(`no 6-digit code in body: ${body?.slice(0, 200)}`);
  return m[1] as string;
}

async function postJson(path: string, body: unknown) {
  return SELF.fetch(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM users').run();
  const otps = await env.KV.list({ prefix: 'otp:' });
  await Promise.all(otps.keys.map((k) => env.KV.delete(k.name)));
  const rls = await env.KV.list({ prefix: 'rl:' });
  await Promise.all(rls.keys.map((k) => env.KV.delete(k.name)));
});

describe('POST /api/auth/request', () => {
  it('responds 204 with no body and triggers a Mailgun send', async () => {
    const { capturedBody } = mockMailgunSendOnce();
    const res = await postJson('/api/auth/request', { email: 'alice@example.com' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(capturedBody.value).toMatch(/alice@example\.com/);
    expect(capturedBody.value).toMatch(/sign-in code/i);
    expect(extractCode(capturedBody.value)).toMatch(/^\d{6}$/);
  });

  it('stores a hashed code in KV', async () => {
    mockMailgunSendOnce();
    await postJson('/api/auth/request', { email: 'bob@example.com' });
    const raw = await env.KV.get('otp:bob@example.com');
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw as string) as { hash: string; attempts: number };
    expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.attempts).toBe(0);
  });

  it('rejects malformed emails with 400', async () => {
    const res = await postJson('/api/auth/request', { email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('rate-limits a single email after 5 requests in the window', async () => {
    for (let i = 0; i < 5; i++) mockMailgunSendOnce();
    const email = `rl-${crypto.randomUUID()}@example.com`;
    for (let i = 0; i < 5; i++) {
      const res = await postJson('/api/auth/request', { email });
      expect(res.status).toBe(204);
    }
    // No 6th interceptor queued; if the handler tried to send,
    // fetchMock would surface an unmatched-intercept error.
    const blocked = await postJson('/api/auth/request', { email });
    expect(blocked.status).toBe(204);
  });
});

describe('POST /api/auth/verify', () => {
  async function requestAndGetCode(email: string): Promise<string> {
    const { capturedBody } = mockMailgunSendOnce();
    const res = await postJson('/api/auth/request', { email });
    expect(res.status).toBe(204);
    return extractCode(capturedBody.value);
  }

  it('issues a session cookie on a correct code', async () => {
    const email = 'carol@example.com';
    const code = await requestAndGetCode(email);
    const res = await postJson('/api/auth/verify', { email, code });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/rmd_sid=/);
    const body = (await res.json()) as { user: { email: string; tzConfirmed: boolean } };
    expect(body.user.email).toBe(email);
    expect(body.user.tzConfirmed).toBe(false);
  });

  it('rejects an incorrect code', async () => {
    const email = 'dave@example.com';
    await requestAndGetCode(email);
    const res = await postJson('/api/auth/verify', { email, code: '000000' });
    expect(res.status).toBe(400);
  });

  it('locks out after 5 wrong attempts', async () => {
    const email = 'eve@example.com';
    await requestAndGetCode(email);
    for (let i = 0; i < 5; i++) {
      await postJson('/api/auth/verify', { email, code: '999999' });
    }
    const res = await postJson('/api/auth/verify', { email, code: '999999' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('too_many_attempts');
  });

  it('returns 400 when no code was requested', async () => {
    const res = await postJson('/api/auth/verify', {
      email: 'unknown@example.com',
      code: '123456',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie', async () => {
    const res = await SELF.fetch('https://example.com/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(204);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/rmd_sid=/);
    expect(cookie.toLowerCase()).toContain('max-age=0');
  });
});
