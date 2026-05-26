import { SELF, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/client';
import { reminderFires, reminders, users } from '~/db/schema';
import { signFireAction, signMagicLink } from '~/lib/actionToken';

interface SeedOpts {
  email?: string;
  rrule?: string;
  dtstart?: string;
  timezone?: string;
  nextFireAt?: string;
  remainingCount?: number | null;
  reminderStatus?: 'active' | 'paused' | 'completed' | 'suspended' | 'deleted';
  userStatus?: 'active' | 'suspended';
}

async function seedFiringReminder(opts: SeedOpts = {}) {
  const db = getDb(env);
  const email = opts.email ?? `r-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      timezone: opts.timezone ?? 'UTC',
      tzConfirmed: 1,
      status: opts.userStatus ?? 'active',
    })
    .returning();
  if (!user) throw new Error('seed user failed');

  const [reminder] = await db
    .insert(reminders)
    .values({
      userId: user.id,
      title: 'Take vitamins',
      bodyMd: 'go',
      rrule: opts.rrule ?? 'FREQ=DAILY',
      dtstart: opts.dtstart ?? '2026-05-25T08:00:00',
      timezone: opts.timezone ?? 'UTC',
      nextFireAt: opts.nextFireAt ?? '2026-05-26T08:00:00Z',
      remainingCount: opts.remainingCount ?? null,
      status: opts.reminderStatus ?? 'active',
    })
    .returning();
  if (!reminder) throw new Error('seed reminder failed');

  const [fire] = await db
    .insert(reminderFires)
    .values({
      reminderId: reminder.id,
      fireAt: '2026-05-25T08:00:00Z',
      status: 'sent',
      sentAt: '2026-05-25T08:00:00Z',
      mailgunMessageId: '<seed@example.com>',
    })
    .returning();
  if (!fire) throw new Error('seed fire failed');

  return { user, reminder, fire };
}

async function fetchAction(token: string, method: 'GET' | 'POST' = 'GET') {
  return SELF.fetch(`https://example.com/r/${token}`, { method, redirect: 'manual' });
}

async function loadReminder(id: number) {
  const db = getDb(env);
  return (await db.select().from(reminders).where(eq(reminders.id, id)).limit(1))[0];
}

async function loadFire(id: number) {
  const db = getDb(env);
  return (await db.select().from(reminderFires).where(eq(reminderFires.id, id)).limit(1))[0];
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM reminder_fires').run();
  await env.DB.prepare('DELETE FROM reminders').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare('DELETE FROM suppressions').run();
});

describe('GET /r/:token — invalid tokens', () => {
  it('returns 410 for a totally invalid token', async () => {
    const res = await fetchAction('garbage');
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('no longer valid');
  });
});

describe('snooze', () => {
  it('GET applies the delta to next_fire_at and consumes the fire', async () => {
    const { reminder, fire } = await seedFiringReminder({
      nextFireAt: '2026-05-26T08:00:00Z',
    });
    const before = Date.now();
    const token = await signFireAction(env.ACTION_TOKEN_SECRET, {
      rid: reminder.id,
      fid: fire.id,
      op: 'snooze:1h',
    });
    const res = await fetchAction(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Snoozed');

    const updated = await loadReminder(reminder.id);
    expect(updated?.nextFireAt).not.toBeNull();
    const nextFireMs = new Date(updated?.nextFireAt as string).getTime();
    // should be ~1h from "now"; allow a generous fudge.
    expect(nextFireMs - before).toBeGreaterThanOrEqual(59 * 60 * 1000);
    expect(nextFireMs - before).toBeLessThanOrEqual(61 * 60 * 1000);

    const fireRow = await loadFire(fire.id);
    expect(fireRow?.actionConsumedAt).not.toBeNull();
  });
});

describe('skip', () => {
  it('advances next_fire_at to the next natural RRULE occurrence', async () => {
    const { reminder, fire } = await seedFiringReminder({
      nextFireAt: '2026-05-26T08:00:00Z',
    });
    const token = await signFireAction(env.ACTION_TOKEN_SECRET, {
      rid: reminder.id,
      fid: fire.id,
      op: 'skip',
    });
    const res = await fetchAction(token);
    expect(res.status).toBe(200);

    const updated = await loadReminder(reminder.id);
    expect(updated?.nextFireAt).toBe('2026-05-27T08:00:00Z');
  });

  it('decrements remaining_count and completes when zero', async () => {
    const { reminder, fire } = await seedFiringReminder({
      nextFireAt: '2026-05-26T08:00:00Z',
      remainingCount: 1,
    });
    const token = await signFireAction(env.ACTION_TOKEN_SECRET, {
      rid: reminder.id,
      fid: fire.id,
      op: 'skip',
    });
    const res = await fetchAction(token);
    expect(res.status).toBe(200);

    const updated = await loadReminder(reminder.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.remainingCount).toBe(0);
    expect(updated?.nextFireAt).toBeNull();
  });
});

describe('done', () => {
  it('GET shows a confirm page; POST applies', async () => {
    const { reminder, fire } = await seedFiringReminder();
    const token = await signFireAction(env.ACTION_TOKEN_SECRET, {
      rid: reminder.id,
      fid: fire.id,
      op: 'done',
    });
    const confirm = await fetchAction(token, 'GET');
    expect(confirm.status).toBe(200);
    const confirmHtml = await confirm.text();
    expect(confirmHtml).toContain('Yes, mark done');
    // Confirm page must not have already mutated state.
    expect((await loadReminder(reminder.id))?.status).toBe('active');

    const apply = await fetchAction(token, 'POST');
    expect(apply.status).toBe(200);
    expect(await apply.text()).toContain('Series done');

    const updated = await loadReminder(reminder.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.nextFireAt).toBeNull();
    expect((await loadFire(fire.id))?.actionConsumedAt).not.toBeNull();
  });
});

describe('unsub (one-click List-Unsubscribe)', () => {
  it('POST completes the series without a confirm step', async () => {
    const { reminder, fire } = await seedFiringReminder();
    const token = await signFireAction(env.ACTION_TOKEN_SECRET, {
      rid: reminder.id,
      fid: fire.id,
      op: 'unsub',
    });
    const res = await fetchAction(token, 'POST');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Unsubscribed');
    const updated = await loadReminder(reminder.id);
    expect(updated?.status).toBe('completed');
  });
});

describe('idempotency', () => {
  it("a second use of the same fire's token reports already-actioned", async () => {
    const { reminder, fire } = await seedFiringReminder();
    const skipToken = await signFireAction(env.ACTION_TOKEN_SECRET, {
      rid: reminder.id,
      fid: fire.id,
      op: 'skip',
    });
    const first = await fetchAction(skipToken);
    expect(first.status).toBe(200);

    // Different op token, same fire — should also be locked out.
    const snoozeToken = await signFireAction(env.ACTION_TOKEN_SECRET, {
      rid: reminder.id,
      fid: fire.id,
      op: 'snooze:1d',
    });
    const second = await fetchAction(snoozeToken);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('Already actioned');
  });
});

describe('magic link', () => {
  it('signs the user in and redirects to /', async () => {
    const { user } = await seedFiringReminder();
    const token = await signMagicLink(env.ACTION_TOKEN_SECRET, user.id);
    const res = await fetchAction(token);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie') ?? '').toMatch(/rmd_sid=/);

    // The session cookie should now work for an authenticated endpoint.
    const cookie = res.headers.get('set-cookie') ?? '';
    const sid = cookie.match(/rmd_sid=([^;]+)/)?.[1];
    expect(sid).toBeTruthy();
    const me = await SELF.fetch('https://example.com/api/me', {
      headers: { cookie: `rmd_sid=${sid}` },
    });
    expect(me.status).toBe(200);
  });

  it('refuses a magic link for a suspended user', async () => {
    const { user } = await seedFiringReminder({ userStatus: 'suspended' });
    const token = await signMagicLink(env.ACTION_TOKEN_SECRET, user.id);
    const res = await fetchAction(token);
    expect(res.status).toBe(410);
  });
});
