import { env, fetchMock } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/client';
import { reminderFires, reminders, suppressions, users } from '~/db/schema';
import { LOOKAHEAD_MS, runScheduledTick } from '~/lib/scheduler';

const MAILGUN_BASE = 'https://api.mailgun.net';
const SEND_PATH = '/v3/example.com/messages';

interface SeedReminderOptions {
  email?: string;
  title?: string;
  bodyMd?: string;
  rrule?: string;
  /** ISO 8601 wall-clock, no offset. */
  dtstart?: string;
  timezone?: string;
  /** ISO UTC; nullable. */
  nextFireAt?: string | null;
  remainingCount?: number | null;
  reminderStatus?: 'active' | 'paused' | 'completed' | 'suspended' | 'deleted';
  userStatus?: 'active' | 'suspended';
}

async function seed(opts: SeedReminderOptions = {}) {
  const db = getDb(env);
  const email = opts.email ?? `user-${crypto.randomUUID()}@example.com`;

  const [user] = await db
    .insert(users)
    .values({
      email,
      timezone: opts.timezone ?? 'UTC',
      tzConfirmed: 1,
      status: opts.userStatus ?? 'active',
    })
    .returning();
  if (!user) throw new Error('failed to seed user');

  const [reminder] = await db
    .insert(reminders)
    .values({
      userId: user.id,
      title: opts.title ?? 'Take vitamins',
      bodyMd: opts.bodyMd ?? 'Day {{day}}',
      rrule: opts.rrule ?? 'FREQ=DAILY',
      dtstart: opts.dtstart ?? '2026-05-25T08:00:00',
      timezone: opts.timezone ?? 'UTC',
      nextFireAt: opts.nextFireAt === undefined ? '2026-05-25T08:00:00Z' : opts.nextFireAt,
      remainingCount: opts.remainingCount ?? null,
      status: opts.reminderStatus ?? 'active',
    })
    .returning();
  if (!reminder) throw new Error('failed to seed reminder');

  return { user, reminder };
}

function mockSendOk(messageId = '<mg-test-id@example.com>') {
  fetchMock
    .get(MAILGUN_BASE)
    .intercept({ path: SEND_PATH, method: 'POST' })
    .reply(200, JSON.stringify({ id: messageId, message: 'Queued' }), {
      headers: { 'content-type': 'application/json' },
    });
}

function mockSendFail(status = 503, body = 'Service Unavailable') {
  fetchMock.get(MAILGUN_BASE).intercept({ path: SEND_PATH, method: 'POST' }).reply(status, body);
}

async function loadFires(reminderId: number) {
  const db = getDb(env);
  return db.select().from(reminderFires).where(eq(reminderFires.reminderId, reminderId));
}

async function loadReminder(id: number) {
  const db = getDb(env);
  const rows = await db.select().from(reminders).where(eq(reminders.id, id));
  return rows[0];
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM reminder_fires').run();
  await env.DB.prepare('DELETE FROM reminders').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare('DELETE FROM suppressions').run();
});

describe('runScheduledTick', () => {
  it('fires a reminder whose next_fire_at is within the look-ahead window', async () => {
    const now = new Date('2026-05-25T08:00:00Z');
    const { reminder, user } = await seed({
      nextFireAt: '2026-05-25T08:03:00Z', // 3 min ahead, well inside lookahead
      timezone: 'UTC',
      dtstart: '2026-05-25T08:00:00',
    });
    mockSendOk('<mg-1@example.com>');

    const stats = await runScheduledTick(env, now);
    expect(stats).toEqual({ scanned: 1, sent: 1, skipped: 0, failed: 0 });

    const fires = await loadFires(reminder.id);
    expect(fires).toHaveLength(1);
    expect(fires[0]?.status).toBe('sent');
    expect(fires[0]?.mailgunMessageId).toBe('<mg-1@example.com>');
    expect(fires[0]?.fireAt).toBe('2026-05-25T08:03:00Z');

    const updated = await loadReminder(reminder.id);
    expect(updated?.nextFireAt).toBe('2026-05-26T08:00:00Z');
    expect(updated?.status).toBe('active');
    void user;
  });

  it('does not fire a reminder beyond the look-ahead window', async () => {
    const now = new Date('2026-05-25T08:00:00Z');
    const beyond = new Date(now.getTime() + LOOKAHEAD_MS + 60_000).toISOString();
    const { reminder } = await seed({ nextFireAt: beyond });

    const stats = await runScheduledTick(env, now);
    expect(stats).toEqual({ scanned: 0, sent: 0, skipped: 0, failed: 0 });

    const fires = await loadFires(reminder.id);
    expect(fires).toHaveLength(0);
  });

  it('is idempotent across overlapping ticks', async () => {
    const now = new Date('2026-05-25T08:00:00Z');
    const { reminder } = await seed({ nextFireAt: '2026-05-25T08:00:00Z' });
    mockSendOk('<mg-2@example.com>');

    const first = await runScheduledTick(env, now);
    expect(first.sent).toBe(1);

    // Second tick at the same moment: the reminder's next_fire_at has been
    // advanced to the next day, so no scan hit. But to truly test the
    // claim-lock we re-arm next_fire_at to the original fire and re-run; the
    // unique fire row should block a double-send.
    await env.DB.prepare(`UPDATE reminders SET next_fire_at = '2026-05-25T08:00:00Z' WHERE id = ?`)
      .bind(reminder.id)
      .run();

    const second = await runScheduledTick(env, now);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);

    const fires = await loadFires(reminder.id);
    expect(fires).toHaveLength(1);
  });

  it('skips reminders whose owner is suspended', async () => {
    const now = new Date('2026-05-25T08:00:00Z');
    const { reminder } = await seed({
      nextFireAt: '2026-05-25T08:00:00Z',
      userStatus: 'suspended',
    });
    const stats = await runScheduledTick(env, now);
    expect(stats).toEqual({ scanned: 0, sent: 0, skipped: 0, failed: 0 });
    expect(await loadFires(reminder.id)).toHaveLength(0);
  });

  it('skips and advances when the recipient is in the suppression list', async () => {
    const now = new Date('2026-05-25T08:00:00Z');
    const { reminder, user } = await seed({ nextFireAt: '2026-05-25T08:00:00Z' });
    const db = getDb(env);
    await db.insert(suppressions).values({
      email: user.email,
      reason: 'bounce',
      occurredAt: now.toISOString(),
    });

    const stats = await runScheduledTick(env, now);
    expect(stats).toEqual({ scanned: 1, sent: 0, skipped: 1, failed: 0 });

    const fires = await loadFires(reminder.id);
    expect(fires).toHaveLength(1);
    expect(fires[0]?.status).toBe('skipped');
    expect(fires[0]?.error).toBe('suppressed');

    const updated = await loadReminder(reminder.id);
    expect(updated?.nextFireAt).toBe('2026-05-26T08:00:00Z');
  });

  it('decrements remaining_count and completes when it hits zero', async () => {
    const now = new Date('2026-05-25T08:00:00Z');
    const { reminder } = await seed({
      nextFireAt: '2026-05-25T08:00:00Z',
      remainingCount: 1,
    });
    mockSendOk('<mg-3@example.com>');

    const stats = await runScheduledTick(env, now);
    expect(stats.sent).toBe(1);

    const updated = await loadReminder(reminder.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.remainingCount).toBe(0);
    expect(updated?.nextFireAt).toBeNull();
  });

  it('marks failed when Mailgun rejects, leaves next_fire_at alone, retries on next tick', async () => {
    const now = new Date('2026-05-25T08:00:00Z');
    const { reminder } = await seed({ nextFireAt: '2026-05-25T08:00:00Z' });

    mockSendFail(503, 'temporary');
    const firstStats = await runScheduledTick(env, now);
    expect(firstStats).toEqual({ scanned: 1, sent: 0, skipped: 0, failed: 1 });

    let row = await loadReminder(reminder.id);
    expect(row?.nextFireAt).toBe('2026-05-25T08:00:00Z'); // unchanged
    let fires = await loadFires(reminder.id);
    expect(fires[0]?.status).toBe('failed');
    expect(fires[0]?.error ?? '').toContain('temporary');

    // Retry succeeds; the existing row gets reclaimed and updated to 'sent'.
    mockSendOk('<mg-retry@example.com>');
    const second = await runScheduledTick(env, now);
    expect(second.sent).toBe(1);

    fires = await loadFires(reminder.id);
    expect(fires).toHaveLength(1);
    expect(fires[0]?.status).toBe('sent');
    expect(fires[0]?.mailgunMessageId).toBe('<mg-retry@example.com>');

    row = await loadReminder(reminder.id);
    expect(row?.nextFireAt).toBe('2026-05-26T08:00:00Z');
  });

  it('ignores paused, completed, and deleted reminders', async () => {
    const now = new Date('2026-05-25T08:00:00Z');
    const a = await seed({ nextFireAt: '2026-05-25T08:00:00Z', reminderStatus: 'paused' });
    const b = await seed({ nextFireAt: '2026-05-25T08:00:00Z', reminderStatus: 'completed' });
    const c = await seed({ nextFireAt: '2026-05-25T08:00:00Z', reminderStatus: 'deleted' });

    const stats = await runScheduledTick(env, now);
    expect(stats.scanned).toBe(0);
    expect(await loadFires(a.reminder.id)).toHaveLength(0);
    expect(await loadFires(b.reminder.id)).toHaveLength(0);
    expect(await loadFires(c.reminder.id)).toHaveLength(0);
  });

  it('renders template variables and includes a manage-reminders footer', async () => {
    const now = new Date('2026-05-25T15:00:00Z');
    await seed({
      title: 'Trash day ({{day_of_week}})',
      bodyMd: 'Bins out **{{date}}**',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      dtstart: '2026-05-25T08:00:00',
      timezone: 'America/Los_Angeles',
      nextFireAt: '2026-05-25T15:00:00Z', // 8 AM PDT
    });

    let capturedBody = '';
    fetchMock
      .get(MAILGUN_BASE)
      .intercept({ path: SEND_PATH, method: 'POST' })
      .reply(
        200,
        (opts) => {
          capturedBody = bodyToString(opts.body);
          return JSON.stringify({ id: '<mg-render@example.com>', message: 'Queued' });
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const stats = await runScheduledTick(env, now);
    expect(stats.sent).toBe(1);

    // multipart body — values appear literal.
    expect(capturedBody).toContain('Trash day (Monday)');
    expect(capturedBody).toContain('Bins out');
    expect(capturedBody).toContain('25 May 2026');
    expect(capturedBody).toContain('Manage all your reminders');
    // Each email gets snooze/skip/done/unsub + magic-link URLs.
    expect(capturedBody).toMatch(/\/r\/fa\.[A-Za-z0-9_-]+\./);
    expect(capturedBody).toMatch(/\/r\/ml\.[A-Za-z0-9_-]+\./);
    expect(capturedBody).toMatch(/List-Unsubscribe/);
    expect(capturedBody).toMatch(/Message-Id[\s\S]*reminder-\d+-/);
  });
});

function bodyToString(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return String(body ?? '');
}
