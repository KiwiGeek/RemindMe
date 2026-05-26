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

async function authed<T>(
  cookie: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const headers = {
    cookie,
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await SELF.fetch(`https://example.com${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, body };
}

const validReminderInput = {
  title: 'Take vitamins',
  bodyMd: 'Day {{day}} — go!',
  rrule: 'FREQ=DAILY',
  dtstart: '2026-05-25T08:00:00',
  timezone: 'America/Los_Angeles',
  ends: { kind: 'never' as const },
};

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM reminder_fires').run();
  await env.DB.prepare('DELETE FROM reminders').run();
  await env.DB.prepare('DELETE FROM users').run();
  const otps = await env.KV.list({ prefix: 'otp:' });
  await Promise.all(otps.keys.map((k) => env.KV.delete(k.name)));
  const rls = await env.KV.list({ prefix: 'rl:' });
  await Promise.all(rls.keys.map((k) => env.KV.delete(k.name)));
});

describe('auth gating', () => {
  it('GET /api/reminders requires a session', async () => {
    const res = await SELF.fetch('https://example.com/api/reminders');
    expect(res.status).toBe(401);
  });
  it('POST /api/reminders requires a session', async () => {
    const res = await SELF.fetch('https://example.com/api/reminders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validReminderInput),
    });
    expect(res.status).toBe(401);
  });
});

describe('CRUD', () => {
  it('creates, lists, gets, patches, and deletes', async () => {
    const cookie = await signIn('alice@example.com');

    const created = await authed<{
      reminder: { id: number; status: string; nextFireAt: string | null };
    }>(cookie, '/api/reminders', { method: 'POST', body: JSON.stringify(validReminderInput) });
    expect(created.status).toBe(201);
    expect(created.body.reminder.status).toBe('active');
    expect(created.body.reminder.nextFireAt).toBe('2026-05-25T15:00:00Z');
    const id = created.body.reminder.id;

    const list = await authed<{ reminders: { id: number }[] }>(cookie, '/api/reminders');
    expect(list.status).toBe(200);
    expect(list.body.reminders).toHaveLength(1);
    expect(list.body.reminders[0]?.id).toBe(id);

    const got = await authed<{ reminder: { id: number; title: string } }>(
      cookie,
      `/api/reminders/${id}`,
    );
    expect(got.body.reminder.title).toBe('Take vitamins');

    const patched = await authed<{ reminder: { title: string; status: string } }>(
      cookie,
      `/api/reminders/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Take supplements', status: 'paused' }),
      },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.reminder.title).toBe('Take supplements');
    expect(patched.body.reminder.status).toBe('paused');

    const deleted = await SELF.fetch(`https://example.com/api/reminders/${id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(deleted.status).toBe(204);

    const after = await authed<{ reminders: unknown[] }>(cookie, '/api/reminders');
    expect(after.body.reminders).toHaveLength(0);

    const missing = await authed(cookie, `/api/reminders/${id}`);
    expect(missing.status).toBe(404);
  });

  it('recomputes next_fire_at on schedule patches', async () => {
    const cookie = await signIn('bob@example.com');
    const created = await authed<{ reminder: { id: number; nextFireAt: string | null } }>(
      cookie,
      '/api/reminders',
      { method: 'POST', body: JSON.stringify(validReminderInput) },
    );
    const id = created.body.reminder.id;
    expect(created.body.reminder.nextFireAt).toBe('2026-05-25T15:00:00Z');

    const patched = await authed<{ reminder: { nextFireAt: string | null } }>(
      cookie,
      `/api/reminders/${id}`,
      { method: 'PATCH', body: JSON.stringify({ dtstart: '2027-01-01T12:00:00' }) },
    );
    expect(patched.body.reminder.nextFireAt).toBe('2027-01-01T20:00:00Z'); // 12 PM PST = 20:00 UTC
  });

  it('stores after_count as remainingCount', async () => {
    const cookie = await signIn('carol@example.com');
    const created = await authed<{ reminder: { remainingCount: number | null } }>(
      cookie,
      '/api/reminders',
      {
        method: 'POST',
        body: JSON.stringify({
          ...validReminderInput,
          ends: { kind: 'after_count', afterCount: 7 },
        }),
      },
    );
    expect(created.body.reminder.remainingCount).toBe(7);
  });
});

describe('ownership scoping', () => {
  it("a user can't see or touch another user's reminders", async () => {
    const aliceCookie = await signIn('alice@example.com');
    const created = await authed<{ reminder: { id: number } }>(aliceCookie, '/api/reminders', {
      method: 'POST',
      body: JSON.stringify(validReminderInput),
    });
    const id = created.body.reminder.id;

    const malloryCookie = await signIn('mallory@example.com');

    const list = await authed<{ reminders: unknown[] }>(malloryCookie, '/api/reminders');
    expect(list.body.reminders).toHaveLength(0);

    const get = await authed(malloryCookie, `/api/reminders/${id}`);
    expect(get.status).toBe(404);

    const patch = await authed(malloryCookie, `/api/reminders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'hijacked' }),
    });
    expect(patch.status).toBe(404);

    const del = await SELF.fetch(`https://example.com/api/reminders/${id}`, {
      method: 'DELETE',
      headers: { cookie: malloryCookie },
    });
    expect(del.status).toBe(404);
  });
});

describe('preview', () => {
  it('returns the next N fires and a rendered sample', async () => {
    const cookie = await signIn('preview@example.com');
    const res = await authed<{
      fires: string[];
      summary: string;
      sample: { subject: string; htmlBody: string } | null;
    }>(cookie, '/api/reminders/preview', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Trash day ({{day_of_week}})',
        bodyMd: 'Put bins out on **{{date}}**',
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        dtstart: '2026-05-26T20:00:00',
        timezone: 'America/Los_Angeles',
        count: 3,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.fires).toHaveLength(3);
    expect(res.body.summary).toMatch(/every week on tuesday/i);
    expect(res.body.sample?.subject).toBe('Trash day (Tuesday)');
    expect(res.body.sample?.htmlBody).toContain('<strong>');
  });

  it('rejects an invalid timezone', async () => {
    const cookie = await signIn('badtz@example.com');
    const res = await authed<{ error: string }>(cookie, '/api/reminders/preview', {
      method: 'POST',
      body: JSON.stringify({
        rrule: 'FREQ=DAILY',
        dtstart: '2026-05-25T08:00:00',
        timezone: 'Mars/Phobos',
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_timezone');
  });
});

describe('validation', () => {
  it('rejects bad RRULE on create', async () => {
    const cookie = await signIn('vc@example.com');
    const res = await authed<{ error: string }>(cookie, '/api/reminders', {
      method: 'POST',
      body: JSON.stringify({ ...validReminderInput, rrule: 'INTERVAL=2' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_rrule');
  });

  it('rejects empty title on create', async () => {
    const cookie = await signIn('vt@example.com');
    const res = await SELF.fetch('https://example.com/api/reminders', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...validReminderInput, title: '' }),
    });
    expect(res.status).toBe(400);
  });
});
