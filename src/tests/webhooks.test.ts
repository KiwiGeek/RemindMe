import { SELF, env, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const MAILGUN_BASE = 'https://api.mailgun.net';

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
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await SELF.fetch(`https://example.com${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, body };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function mintMailgunSig(token: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.MAILGUN_SIGNING_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}${token}`)),
  );
  return bytesToHex(mac);
}

interface WebhookEnvelope {
  signature: { timestamp: string; token: string; signature: string };
  'event-data': {
    event: string;
    severity?: 'permanent' | 'temporary';
    recipient: string;
    reason?: string;
  };
}

async function mintEvent(
  recipient: string,
  event: string,
  opts: { severity?: 'permanent' | 'temporary'; reason?: string; token?: string } = {},
): Promise<WebhookEnvelope> {
  const ts = Math.floor(Date.now() / 1000);
  const token = opts.token ?? `tok-${ts}-${Math.random().toString(36).slice(2)}`;
  const sig = await mintMailgunSig(token, ts);
  return {
    signature: { timestamp: String(ts), token, signature: sig },
    'event-data': {
      event,
      ...(opts.severity ? { severity: opts.severity } : {}),
      recipient,
      ...(opts.reason ? { reason: opts.reason } : {}),
    },
  };
}

async function postWebhook(payload: unknown): Promise<{ status: number; body: unknown }> {
  const res = await SELF.fetch('https://example.com/webhooks/mailgun', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM passkeys').run();
  await env.DB.prepare('DELETE FROM audit_log').run();
  await env.DB.prepare('DELETE FROM reminder_fires').run();
  await env.DB.prepare('DELETE FROM reminders').run();
  await env.DB.prepare('DELETE FROM suppressions').run();
  await env.DB.prepare('DELETE FROM users').run();
  const otps = await env.KV.list({ prefix: 'otp:' });
  await Promise.all(otps.keys.map((k) => env.KV.delete(k.name)));
  const dedupes = await env.KV.list({ prefix: 'mw:' });
  await Promise.all(dedupes.keys.map((k) => env.KV.delete(k.name)));
  const rls = await env.KV.list({ prefix: 'rl:' });
  await Promise.all(rls.keys.map((k) => env.KV.delete(k.name)));
});

describe('signature verification', () => {
  it('rejects a payload with no signature', async () => {
    const res = await postWebhook({ 'event-data': { event: 'failed' } });
    expect(res.status).toBe(401);
  });

  it('rejects a forged signature', async () => {
    const evt = await mintEvent('a@example.com', 'failed', { severity: 'permanent' });
    evt.signature.signature = 'deadbeef'.repeat(8);
    const res = await postWebhook(evt);
    expect(res.status).toBe(401);
  });

  it('rejects a stale timestamp', async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 60 * 60; // 1h ago
    const token = 'old-tok';
    const sig = await mintMailgunSig(token, oldTs);
    const res = await postWebhook({
      signature: { timestamp: String(oldTs), token, signature: sig },
      'event-data': { event: 'failed', severity: 'permanent', recipient: 'a@example.com' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a valid signature', async () => {
    const evt = await mintEvent('a@example.com', 'failed', { severity: 'permanent' });
    const res = await postWebhook(evt);
    expect(res.status).toBe(200);
  });
});

describe('event routing', () => {
  it('permanent_fail suspends an existing user + their reminders + writes audit', async () => {
    const { cookie } = await signIn('bouncer@example.com');
    // Create a reminder for the user.
    const created = await authed<{ reminder: { id: number } }>(cookie, '/api/reminders', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Test',
        bodyMd: '',
        rrule: 'FREQ=DAILY',
        dtstart: '2026-06-01T08:00:00',
        timezone: 'America/Los_Angeles',
        ends: { kind: 'never' },
      }),
    });
    const rid = created.body.reminder.id;

    const evt = await mintEvent('bouncer@example.com', 'failed', {
      severity: 'permanent',
      reason: 'mailbox-not-found',
    });
    const res = await postWebhook(evt);
    expect(res.status).toBe(200);

    const user = await env.DB.prepare(
      "SELECT status FROM users WHERE email = 'bouncer@example.com'",
    ).first<{ status: string }>();
    expect(user?.status).toBe('suspended');

    const r = await env.DB.prepare('SELECT status FROM reminders WHERE id = ?')
      .bind(rid)
      .first<{ status: string }>();
    expect(r?.status).toBe('suspended');

    const supp = await env.DB.prepare(
      "SELECT reason, cleared_at FROM suppressions WHERE email = 'bouncer@example.com'",
    ).first<{ reason: string; cleared_at: string | null }>();
    expect(supp?.reason).toBe('bounce');
    expect(supp?.cleared_at).toBeNull();

    const audit = await env.DB.prepare(
      "SELECT event FROM audit_log WHERE event = 'suppression_bounce' ORDER BY id DESC LIMIT 1",
    ).first<{ event: string }>();
    expect(audit?.event).toBe('suppression_bounce');
  });

  it('complained suspends with reason=complaint', async () => {
    await signIn('spammer@example.com');
    const evt = await mintEvent('spammer@example.com', 'complained');
    await postWebhook(evt);

    const supp = await env.DB.prepare(
      "SELECT reason FROM suppressions WHERE email = 'spammer@example.com'",
    ).first<{ reason: string }>();
    expect(supp?.reason).toBe('complaint');
  });

  it('unsubscribed suspends with reason=unsubscribe', async () => {
    await signIn('quitter@example.com');
    const evt = await mintEvent('quitter@example.com', 'unsubscribed');
    await postWebhook(evt);

    const supp = await env.DB.prepare(
      "SELECT reason FROM suppressions WHERE email = 'quitter@example.com'",
    ).first<{ reason: string }>();
    expect(supp?.reason).toBe('unsubscribe');
  });

  it('temporary_fail does NOT suspend, only audits', async () => {
    await signIn('soft@example.com');
    const evt = await mintEvent('soft@example.com', 'failed', {
      severity: 'temporary',
      reason: 'try again later',
    });
    const res = await postWebhook(evt);
    expect(res.status).toBe(200);

    const user = await env.DB.prepare(
      "SELECT status FROM users WHERE email = 'soft@example.com'",
    ).first<{ status: string }>();
    expect(user?.status).toBe('active');

    const supp = await env.DB.prepare(
      "SELECT email FROM suppressions WHERE email = 'soft@example.com'",
    ).first();
    expect(supp).toBeNull();

    const audit = await env.DB.prepare(
      "SELECT event FROM audit_log WHERE event = 'soft_bounce' ORDER BY id DESC LIMIT 1",
    ).first<{ event: string }>();
    expect(audit?.event).toBe('soft_bounce');
  });

  it('still records a suppression for an address we have never seen', async () => {
    const evt = await mintEvent('unknown@example.com', 'failed', { severity: 'permanent' });
    const res = await postWebhook(evt);
    expect(res.status).toBe(200);
    const supp = await env.DB.prepare(
      "SELECT reason FROM suppressions WHERE email = 'unknown@example.com'",
    ).first<{ reason: string }>();
    expect(supp?.reason).toBe('bounce');
  });
});

describe('dedupe', () => {
  it('the same token is processed only once', async () => {
    await signIn('dupe@example.com');
    const evt = await mintEvent('dupe@example.com', 'failed', { severity: 'permanent' });
    const first = await postWebhook(evt);
    expect(first.status).toBe(200);
    expect((first.body as { deduped?: boolean }).deduped).toBeUndefined();

    const second = await postWebhook(evt);
    expect(second.status).toBe(200);
    expect((second.body as { deduped?: boolean }).deduped).toBe(true);

    // After dedupe, audit log only has the first event.
    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'suppression_bounce'",
    ).first<{ n: number }>();
    expect(Number(auditCount?.n ?? 0)).toBe(1);
  });
});

describe('self-recovery on OTP sign-in', () => {
  it('verify clears the local suppression row and reactivates the user; reminders stay suspended', async () => {
    const sign = await signIn('claimback@example.com');
    await authed<{ reminder: { id: number } }>(sign.cookie, '/api/reminders', {
      method: 'POST',
      body: JSON.stringify({
        title: 'thing',
        bodyMd: '',
        rrule: 'FREQ=DAILY',
        dtstart: '2026-06-01T08:00:00',
        timezone: 'America/Los_Angeles',
        ends: { kind: 'never' },
      }),
    });

    // Simulate a hard bounce.
    const evt = await mintEvent('claimback@example.com', 'failed', { severity: 'permanent' });
    await postWebhook(evt);

    const before = await env.DB.prepare(
      "SELECT status FROM users WHERE email = 'claimback@example.com'",
    ).first<{ status: string }>();
    expect(before?.status).toBe('suspended');

    // User signs back in.
    await signIn('claimback@example.com');

    const user = await env.DB.prepare(
      "SELECT status FROM users WHERE email = 'claimback@example.com'",
    ).first<{ status: string }>();
    expect(user?.status).toBe('active');

    const supp = await env.DB.prepare(
      "SELECT cleared_at FROM suppressions WHERE email = 'claimback@example.com'",
    ).first<{ cleared_at: string | null }>();
    expect(supp?.cleared_at).not.toBeNull();

    // Reminders should still be suspended — user must opt in per-reminder.
    const rems = await env.DB.prepare(
      "SELECT status FROM reminders WHERE user_id IN (SELECT id FROM users WHERE email = 'claimback@example.com')",
    ).all<{ status: string }>();
    expect(rems.results.every((r) => r.status === 'suspended')).toBe(true);
  });

  it('reactivating a suspended reminder picks the next future fire (not a backlog)', async () => {
    const { cookie } = await signIn('resume@example.com');
    // Schedule started a year ago; if we replayed naively the scheduler
    // would fire 365 backlog emails.
    const created = await authed<{ reminder: { id: number; nextFireAt: string | null } }>(
      cookie,
      '/api/reminders',
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'Daily',
          bodyMd: '',
          rrule: 'FREQ=DAILY',
          dtstart: '2025-01-01T08:00:00',
          timezone: 'America/Los_Angeles',
          ends: { kind: 'never' },
        }),
      },
    );
    const rid = created.body.reminder.id;

    // Force the reminder into 'suspended'.
    await env.DB.prepare("UPDATE reminders SET status = 'suspended' WHERE id = ?").bind(rid).run();

    // Reactivate via PATCH.
    const resumed = await authed<{ reminder: { status: string; nextFireAt: string | null } }>(
      cookie,
      `/api/reminders/${rid}`,
      { method: 'PATCH', body: JSON.stringify({ status: 'active' }) },
    );
    expect(resumed.body.reminder.status).toBe('active');
    expect(resumed.body.reminder.nextFireAt).not.toBeNull();
    // The new next-fire must be in the future, not back in early 2025.
    const nextMs = Date.parse(resumed.body.reminder.nextFireAt ?? '');
    expect(nextMs).toBeGreaterThan(Date.now());
  });
});
