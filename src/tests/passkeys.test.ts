import { SELF, env, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const MAILGUN_BASE = 'https://api.mailgun.net';
/**
 * @simplewebauthn validates the request Origin against `expectedOrigin`.
 * Tests run against arbitrary SELF URLs, so we route everything through a
 * fixed, https-flavored origin and let `getRpInfo` derive `localhost` as RP
 * ID (and "https://localhost" as expected origin).
 *
 * Browser-side WebAuthn ceremonies can't actually run here — we can't
 * synthesize a valid signed attestation/assertion without a real
 * authenticator — so the tests cover route plumbing, challenge KV, auth
 * gating, and CRUD scoping. The happy-path crypto verification is covered
 * by @simplewebauthn's own test suite.
 */
const ORIGIN = 'https://localhost';

function bodyToString(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return String(body ?? '');
}

async function signIn(email: string): Promise<{ cookie: string; userId: number }> {
  const pool = fetchMock.get(MAILGUN_BASE);
  for (let i = 0; i < 3; i++) {
    pool
      .intercept({
        path: /^\/v3\/example\.com\/(bounces|unsubscribes|complaints)\//,
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

  const reqRes = await SELF.fetch(`${ORIGIN}/api/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email }),
  });
  expect(reqRes.status).toBe(204);
  const code = capturedText.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error('no code captured');

  const verifyRes = await SELF.fetch(`${ORIGIN}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, code }),
  });
  expect(verifyRes.status).toBe(200);
  const json = (await verifyRes.json()) as { user: { id: number } };
  const cookie = verifyRes.headers.get('set-cookie') ?? '';
  const match = cookie.match(/rmd_sid=([^;]+)/);
  if (!match) throw new Error('no session cookie set');
  return { cookie: `rmd_sid=${match[1]}`, userId: json.user.id };
}

async function authed<T>(
  cookie: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const headers = {
    cookie,
    'content-type': 'application/json',
    origin: ORIGIN,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await SELF.fetch(`${ORIGIN}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, body };
}

async function pub<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const headers = {
    'content-type': 'application/json',
    origin: ORIGIN,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await SELF.fetch(`${ORIGIN}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, body };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM passkeys').run();
  await env.DB.prepare('DELETE FROM audit_log').run();
  await env.DB.prepare('DELETE FROM reminder_fires').run();
  await env.DB.prepare('DELETE FROM reminders').run();
  await env.DB.prepare('DELETE FROM users').run();
  const otps = await env.KV.list({ prefix: 'otp:' });
  await Promise.all(otps.keys.map((k) => env.KV.delete(k.name)));
  const pks = await env.KV.list({ prefix: 'pk:' });
  await Promise.all(pks.keys.map((k) => env.KV.delete(k.name)));
  const rls = await env.KV.list({ prefix: 'rl:' });
  await Promise.all(rls.keys.map((k) => env.KV.delete(k.name)));
});

describe('auth gating', () => {
  it('register/options requires auth', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/passkeys/register/options`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
  it('register/verify requires auth', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/passkeys/register/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ response: {} }),
    });
    expect(res.status).toBe(401);
  });
  it('GET / requires auth', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/passkeys`, { headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
  });
  it('DELETE /:id requires auth', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/passkeys/1`, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });
});

describe('origin handling', () => {
  it('rejects requests without an Origin header', async () => {
    const { cookie } = await signIn('a@example.com');
    // Hono strips no headers, but we need to drop `origin` explicitly to test.
    const res = await SELF.fetch(`${ORIGIN}/api/passkeys/register/options`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an http origin that is not localhost', async () => {
    const { cookie } = await signIn('a@example.com');
    const res = await SELF.fetch(`${ORIGIN}/api/passkeys/register/options`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        origin: 'http://evil.example.com',
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('accepts http://localhost (WebAuthn-blessed dev exception)', async () => {
    const { cookie } = await signIn('a@example.com');
    const res = await SELF.fetch(`${ORIGIN}/api/passkeys/register/options`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });
});

describe('register/options', () => {
  it('returns options with a challenge and stores it in KV', async () => {
    const { cookie, userId } = await signIn('alice@example.com');
    const res = await authed<{ options: { challenge: string; rp: { id: string; name: string } } }>(
      cookie,
      '/api/passkeys/register/options',
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(200);
    expect(typeof res.body.options.challenge).toBe('string');
    expect(res.body.options.challenge.length).toBeGreaterThan(0);
    expect(res.body.options.rp.id).toBe('localhost');
    expect(res.body.options.rp.name).toBe('Remind Me');

    const stored = await env.KV.get(`pk:reg:${userId}`);
    expect(stored).toBe(res.body.options.challenge);
  });

  it('respects the per-user limit', async () => {
    const { cookie, userId } = await signIn('many@example.com');
    // 10 = MAX_PASSKEYS_PER_USER
    for (let i = 0; i < 10; i++) {
      await env.DB.prepare(
        'INSERT INTO passkeys (user_id, credential_id, public_key, counter) VALUES (?, ?, ?, 0)',
      )
        .bind(userId, `cred-${i}`, 'pk-bytes')
        .run();
    }
    const res = await authed<{ error: string }>(cookie, '/api/passkeys/register/options', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('limit_reached');
  });
});

describe('register/verify', () => {
  it('400s when no challenge has been issued', async () => {
    const { cookie } = await signIn('no-challenge@example.com');
    const res = await authed<{ error: string }>(cookie, '/api/passkeys/register/verify', {
      method: 'POST',
      body: JSON.stringify({ response: { id: 'x' } }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('challenge_expired');
  });

  it('400s with verification_failed when the response is bogus', async () => {
    const { cookie, userId } = await signIn('bogus@example.com');
    await env.KV.put(`pk:reg:${userId}`, 'fake-challenge', { expirationTtl: 60 });
    const res = await authed<{ error: string }>(cookie, '/api/passkeys/register/verify', {
      method: 'POST',
      body: JSON.stringify({ response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('verification_failed');
    // The challenge must be consumed (and therefore deleted) even on failure
    // so the same client can immediately retry with a fresh ceremony.
    expect(await env.KV.get(`pk:reg:${userId}`)).toBeNull();
  });
});

describe('list / patch / delete', () => {
  it('lists only the signed-in user’s passkeys', async () => {
    const alice = await signIn('alice@example.com');
    const bob = await signIn('bob@example.com');
    await env.DB.prepare(
      'INSERT INTO passkeys (user_id, credential_id, public_key, nickname) VALUES (?, ?, ?, ?)',
    )
      .bind(alice.userId, 'cred-a', 'pk-a', 'Alice MacBook')
      .run();
    await env.DB.prepare(
      'INSERT INTO passkeys (user_id, credential_id, public_key, nickname) VALUES (?, ?, ?, ?)',
    )
      .bind(bob.userId, 'cred-b', 'pk-b', 'Bob Phone')
      .run();

    const aliceList = await authed<{ passkeys: { id: number; nickname: string | null }[] }>(
      alice.cookie,
      '/api/passkeys',
    );
    expect(aliceList.body.passkeys).toHaveLength(1);
    expect(aliceList.body.passkeys[0]?.nickname).toBe('Alice MacBook');

    const bobList = await authed<{ passkeys: { id: number; nickname: string | null }[] }>(
      bob.cookie,
      '/api/passkeys',
    );
    expect(bobList.body.passkeys).toHaveLength(1);
    expect(bobList.body.passkeys[0]?.nickname).toBe('Bob Phone');
  });

  it('cannot rename or delete another user’s passkey', async () => {
    const alice = await signIn('alice@example.com');
    const bob = await signIn('bob@example.com');
    const inserted = await env.DB.prepare(
      'INSERT INTO passkeys (user_id, credential_id, public_key) VALUES (?, ?, ?) RETURNING id',
    )
      .bind(alice.userId, 'cred-a', 'pk-a')
      .first<{ id: number }>();
    const aliceKeyId = inserted?.id ?? -1;

    const patch = await authed(bob.cookie, `/api/passkeys/${aliceKeyId}`, {
      method: 'PATCH',
      body: JSON.stringify({ nickname: 'pwned' }),
    });
    expect(patch.status).toBe(404);

    const del = await SELF.fetch(`${ORIGIN}/api/passkeys/${aliceKeyId}`, {
      method: 'DELETE',
      headers: { cookie: bob.cookie, origin: ORIGIN },
    });
    expect(del.status).toBe(404);

    // Alice's key must still be present after Bob's failed attempts.
    const still = await env.DB.prepare('SELECT nickname FROM passkeys WHERE id = ?')
      .bind(aliceKeyId)
      .first<{ nickname: string | null }>();
    expect(still).toBeTruthy();
    expect(still?.nickname).toBeNull();
  });

  it('renames and deletes own passkeys', async () => {
    const { cookie, userId } = await signIn('self@example.com');
    const inserted = await env.DB.prepare(
      'INSERT INTO passkeys (user_id, credential_id, public_key) VALUES (?, ?, ?) RETURNING id',
    )
      .bind(userId, 'cred', 'pk')
      .first<{ id: number }>();
    const id = inserted?.id ?? -1;

    const renamed = await authed<{ passkey: { nickname: string } }>(cookie, `/api/passkeys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ nickname: 'Work laptop' }),
    });
    expect(renamed.body.passkey.nickname).toBe('Work laptop');

    const del = await SELF.fetch(`${ORIGIN}/api/passkeys/${id}`, {
      method: 'DELETE',
      headers: { cookie, origin: ORIGIN },
    });
    expect(del.status).toBe(204);

    const remaining = await authed<{ passkeys: unknown[] }>(cookie, '/api/passkeys');
    expect(remaining.body.passkeys).toHaveLength(0);
  });
});

describe('auth/options', () => {
  it('returns options and stores the challenge in KV', async () => {
    const res = await pub<{ options: { challenge: string; rpId: string } }>(
      '/api/passkeys/auth/options',
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(200);
    expect(typeof res.body.options.challenge).toBe('string');
    expect(res.body.options.rpId).toBe('localhost');

    const stored = await env.KV.get(`pk:auth:${res.body.options.challenge}`);
    expect(stored).not.toBeNull();
  });
});

describe('auth/verify', () => {
  it('400s on a totally bogus response', async () => {
    const res = await pub<{ error: string }>('/api/passkeys/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ response: { id: 'x' } }), // missing response.clientDataJSON
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_response');
  });

  it('400s when the challenge was never issued by us', async () => {
    // Synthesize a clientDataJSON with a challenge we never stored.
    const clientData = JSON.stringify({
      type: 'webauthn.get',
      challenge: 'never-issued',
      origin: ORIGIN,
    });
    const clientDataB64 = btoa(clientData)
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    const res = await pub<{ error: string }>('/api/passkeys/auth/verify', {
      method: 'POST',
      body: JSON.stringify({
        response: { id: 'unknown-cred', response: { clientDataJSON: clientDataB64 } },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('challenge_expired');
  });

  it('400s with unknown_credential when the credential isn’t in the DB', async () => {
    // Issue a real auth challenge, then submit a response referencing a cred we never stored.
    const opts = await pub<{ options: { challenge: string } }>('/api/passkeys/auth/options', {
      method: 'POST',
      body: '{}',
    });
    const clientData = JSON.stringify({
      type: 'webauthn.get',
      challenge: opts.body.options.challenge,
      origin: ORIGIN,
    });
    const clientDataB64 = btoa(clientData)
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    const res = await pub<{ error: string }>('/api/passkeys/auth/verify', {
      method: 'POST',
      body: JSON.stringify({
        response: { id: 'unknown-cred', response: { clientDataJSON: clientDataB64 } },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_credential');
  });
});
