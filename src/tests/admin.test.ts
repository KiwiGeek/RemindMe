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
  await env.DB.prepare('DELETE FROM audit_log').run();
  await env.DB.prepare('DELETE FROM reminder_fires').run();
  await env.DB.prepare('DELETE FROM reminders').run();
  await env.DB.prepare('DELETE FROM users').run();
  const otps = await env.KV.list({ prefix: 'otp:' });
  await Promise.all(otps.keys.map((k) => env.KV.delete(k.name)));
  const rls = await env.KV.list({ prefix: 'rl:' });
  await Promise.all(rls.keys.map((k) => env.KV.delete(k.name)));
});

describe('requireAdmin', () => {
  it('401s when not signed in', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('403s when signed in as a non-admin', async () => {
    const cookie = await signIn('alice@example.com');
    const res = await SELF.fetch('https://example.com/api/admin/users', {
      headers: { cookie },
    });
    expect(res.status).toBe(403);
  });

  it('lets ADMIN_EMAILS entries in', async () => {
    const cookie = await signIn('admin@example.com');
    const res = await SELF.fetch('https://example.com/api/admin/users', {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });

  it('treats admin emails case-insensitively', async () => {
    // Sign in with mixed case; the schema normalizes to lowercase, so this
    // tests that `parseAdminEmails` agrees on the comparison.
    const cookie = await signIn('Admin@Example.com');
    const res = await SELF.fetch('https://example.com/api/admin/users', {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });
});

describe('/api/me exposes isAdmin', () => {
  it('true for an admin email, false for everyone else', async () => {
    const adminCookie = await signIn('admin@example.com');
    const adminMe = await authed<{ user: { isAdmin: boolean; email: string } }>(
      adminCookie,
      '/api/me',
    );
    expect(adminMe.body.user.email).toBe('admin@example.com');
    expect(adminMe.body.user.isAdmin).toBe(true);

    const userCookie = await signIn('alice@example.com');
    const userMe = await authed<{ user: { isAdmin: boolean } }>(userCookie, '/api/me');
    expect(userMe.body.user.isAdmin).toBe(false);
  });
});

describe('admin users CRUD', () => {
  it('creates a user with default UTC and writes an audit row', async () => {
    const admin = await signIn('admin@example.com');
    const res = await authed<{ user: { id: number; email: string; timezone: string } }>(
      admin,
      '/api/admin/users',
      { method: 'POST', body: JSON.stringify({ email: 'newbie@example.com' }) },
    );
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('newbie@example.com');
    expect(res.body.user.timezone).toBe('UTC');

    const audit = await env.DB.prepare(
      "SELECT event, meta FROM audit_log WHERE event = 'admin_user_create' ORDER BY id DESC LIMIT 1",
    ).first<{ event: string; meta: string }>();
    expect(audit?.event).toBe('admin_user_create');
    const meta = JSON.parse(audit?.meta ?? '{}');
    expect(meta.target_user_id).toBe(res.body.user.id);
  });

  it('returns 409 on duplicate email instead of silently merging', async () => {
    const admin = await signIn('admin@example.com');
    await authed(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'dupe@example.com' }),
    });
    const dup = await authed<{ error: string; user: { id: number } }>(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'dupe@example.com' }),
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('user_exists');
    expect(typeof dup.body.user.id).toBe('number');
  });

  it('rejects an invalid timezone', async () => {
    const admin = await signIn('admin@example.com');
    const res = await authed<{ error: string }>(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'tz@example.com', timezone: 'Mars/Phobos' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_timezone');
  });

  it('lists users and supports the q filter', async () => {
    const admin = await signIn('admin@example.com');
    await authed(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'alpha@example.com' }),
    });
    await authed(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'beta@other.com' }),
    });
    const all = await authed<{ users: { email: string }[] }>(admin, '/api/admin/users');
    // Admin's own row is auto-created on sign-in, so we should have at least 3.
    expect(all.body.users.length).toBeGreaterThanOrEqual(3);

    const filtered = await authed<{ users: { email: string }[] }>(
      admin,
      '/api/admin/users?q=other',
    );
    expect(filtered.body.users.map((u) => u.email)).toEqual(['beta@other.com']);
  });

  it('lets an admin update a target timezone and audits the change', async () => {
    const admin = await signIn('admin@example.com');
    const created = await authed<{ user: { id: number; timezone: string } }>(
      admin,
      '/api/admin/users',
      { method: 'POST', body: JSON.stringify({ email: 'tzu@example.com' }) },
    );
    const id = created.body.user.id;

    const patched = await authed<{ user: { timezone: string } }>(admin, `/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ timezone: 'America/Chicago' }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.user.timezone).toBe('America/Chicago');

    const audit = await env.DB.prepare(
      "SELECT meta FROM audit_log WHERE event = 'admin_user_timezone_change' ORDER BY id DESC LIMIT 1",
    ).first<{ meta: string }>();
    const meta = JSON.parse(audit?.meta ?? '{}');
    expect(meta.target_user_id).toBe(id);
    expect(meta.change).toEqual({ from: 'UTC', to: 'America/Chicago' });
  });

  it('returns 404 patching a user that does not exist', async () => {
    const admin = await signIn('admin@example.com');
    const res = await authed(admin, '/api/admin/users/99999', {
      method: 'PATCH',
      body: JSON.stringify({ timezone: 'America/New_York' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('admin reminders for a target user', () => {
  it('creates a reminder for a never-signed-in user and audits it', async () => {
    const admin = await signIn('admin@example.com');
    const target = await authed<{ user: { id: number } }>(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'ghost@example.com', timezone: 'America/Los_Angeles' }),
    });
    const tid = target.body.user.id;

    const created = await authed<{
      reminder: { id: number; title: string; timezone: string; nextFireAt: string | null };
    }>(admin, `/api/admin/users/${tid}/reminders`, {
      method: 'POST',
      body: JSON.stringify(validReminderInput),
    });
    expect(created.status).toBe(201);
    expect(created.body.reminder.title).toBe('Take vitamins');
    expect(created.body.reminder.timezone).toBe('America/Los_Angeles');
    expect(created.body.reminder.nextFireAt).toBe('2026-05-25T15:00:00Z');

    // The reminder is owned by the target user, not the admin.
    const ownerRow = await env.DB.prepare('SELECT user_id FROM reminders WHERE id = ?')
      .bind(created.body.reminder.id)
      .first<{ user_id: number }>();
    expect(ownerRow?.user_id).toBe(tid);

    const audit = await env.DB.prepare(
      "SELECT meta FROM audit_log WHERE event = 'admin_reminder_create' ORDER BY id DESC LIMIT 1",
    ).first<{ meta: string }>();
    const meta = JSON.parse(audit?.meta ?? '{}');
    expect(meta.target_user_id).toBe(tid);
    expect(meta.reminder_id).toBe(created.body.reminder.id);
  });

  it('lists, updates, and soft-deletes a target user reminder', async () => {
    const admin = await signIn('admin@example.com');
    const target = await authed<{ user: { id: number } }>(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'managed@example.com' }),
    });
    const tid = target.body.user.id;

    const created = await authed<{ reminder: { id: number } }>(
      admin,
      `/api/admin/users/${tid}/reminders`,
      { method: 'POST', body: JSON.stringify(validReminderInput) },
    );
    const rid = created.body.reminder.id;

    const list = await authed<{ reminders: { id: number }[] }>(
      admin,
      `/api/admin/users/${tid}/reminders`,
    );
    expect(list.body.reminders).toHaveLength(1);

    const patched = await authed<{ reminder: { title: string; status: string } }>(
      admin,
      `/api/admin/users/${tid}/reminders/${rid}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Updated by admin', status: 'paused' }),
      },
    );
    expect(patched.body.reminder.title).toBe('Updated by admin');
    expect(patched.body.reminder.status).toBe('paused');

    const upd = await env.DB.prepare(
      "SELECT meta FROM audit_log WHERE event = 'admin_reminder_update' ORDER BY id DESC LIMIT 1",
    ).first<{ meta: string }>();
    expect(JSON.parse(upd?.meta ?? '{}').reminder_id).toBe(rid);

    const del = await SELF.fetch(`https://example.com/api/admin/users/${tid}/reminders/${rid}`, {
      method: 'DELETE',
      headers: { cookie: admin },
    });
    expect(del.status).toBe(204);

    const delAudit = await env.DB.prepare(
      "SELECT meta FROM audit_log WHERE event = 'admin_reminder_delete' ORDER BY id DESC LIMIT 1",
    ).first<{ meta: string }>();
    expect(JSON.parse(delAudit?.meta ?? '{}').reminder_id).toBe(rid);

    const after = await authed<{ reminders: unknown[] }>(
      admin,
      `/api/admin/users/${tid}/reminders`,
    );
    expect(after.body.reminders).toHaveLength(0);
  });

  it('rejects bad RRULE on admin create', async () => {
    const admin = await signIn('admin@example.com');
    const target = await authed<{ user: { id: number } }>(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'invalid@example.com' }),
    });
    const tid = target.body.user.id;

    const res = await authed<{ error: string }>(admin, `/api/admin/users/${tid}/reminders`, {
      method: 'POST',
      body: JSON.stringify({ ...validReminderInput, rrule: 'INTERVAL=2' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_rrule');
  });

  it('returns 404 creating a reminder for an unknown user id', async () => {
    const admin = await signIn('admin@example.com');
    const res = await authed<{ error: string }>(admin, '/api/admin/users/99999/reminders', {
      method: 'POST',
      body: JSON.stringify(validReminderInput),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('user_not_found');
  });

  it('previews using the target user’s email, not the admin’s', async () => {
    const admin = await signIn('admin@example.com');
    const target = await authed<{ user: { id: number } }>(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'previewtgt@example.com' }),
    });
    const tid = target.body.user.id;

    const res = await authed<{
      sample: { textBody: string; htmlBody: string } | null;
    }>(admin, `/api/admin/users/${tid}/reminders/preview`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Hi {{user_email}}',
        bodyMd: 'Hello, {{user_email}}.',
        rrule: 'FREQ=DAILY',
        dtstart: '2026-05-25T08:00:00',
        timezone: 'America/Los_Angeles',
        count: 1,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.sample?.htmlBody).toContain('previewtgt@example.com');
    expect(res.body.sample?.htmlBody).not.toContain('admin@example.com');
  });
});

describe('ownership separation', () => {
  it('the admin route only mutates the user named in the URL', async () => {
    const admin = await signIn('admin@example.com');

    // Create two distinct targets.
    const a = await authed<{ user: { id: number } }>(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'tgt-a@example.com' }),
    });
    const b = await authed<{ user: { id: number } }>(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'tgt-b@example.com' }),
    });

    // Reminder for A.
    const created = await authed<{ reminder: { id: number } }>(
      admin,
      `/api/admin/users/${a.body.user.id}/reminders`,
      { method: 'POST', body: JSON.stringify(validReminderInput) },
    );
    const rid = created.body.reminder.id;

    // Asking via B's URL must 404 — the reminder belongs to A.
    const getViaB = await authed(admin, `/api/admin/users/${b.body.user.id}/reminders/${rid}`);
    expect(getViaB.status).toBe(404);

    const patchViaB = await authed(admin, `/api/admin/users/${b.body.user.id}/reminders/${rid}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'cross-write' }),
    });
    expect(patchViaB.status).toBe(404);
  });

  it('a created-by-admin user can later claim the account via OTP and see their reminders', async () => {
    const admin = await signIn('admin@example.com');
    const target = await authed<{ user: { id: number } }>(admin, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'claim@example.com', timezone: 'America/New_York' }),
    });
    const tid = target.body.user.id;
    await authed(admin, `/api/admin/users/${tid}/reminders`, {
      method: 'POST',
      body: JSON.stringify(validReminderInput),
    });

    // Now `claim@example.com` signs in for the first time via the standard
    // OTP flow. It must find their pre-created row, not create a duplicate.
    const claimCookie = await signIn('claim@example.com');
    const me = await authed<{ user: { id: number; email: string } }>(claimCookie, '/api/me');
    expect(me.body.user.id).toBe(tid);
    expect(me.body.user.email).toBe('claim@example.com');

    const mine = await authed<{ reminders: { title: string }[] }>(claimCookie, '/api/reminders');
    expect(mine.body.reminders).toHaveLength(1);
    expect(mine.body.reminders[0]?.title).toBe('Take vitamins');
  });
});
