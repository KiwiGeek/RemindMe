import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/client';
import { RETENTION_DAYS, pruneOldRows } from '~/lib/retention';

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM audit_log').run();
  await env.DB.prepare('DELETE FROM reminder_fires').run();
  await env.DB.prepare('DELETE FROM reminders').run();
  await env.DB.prepare('DELETE FROM users').run();
});

async function insertUser(): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO users (email) VALUES ('a@a.com') RETURNING id",
  ).first<{ id: number }>();
  if (!row) throw new Error('user insert failed');
  return row.id;
}

async function insertReminder(userId: number): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO reminders (user_id, title, rrule, dtstart, timezone, next_fire_at) VALUES (?, 't', 'FREQ=DAILY', '2026-01-01T08:00:00', 'UTC', '2026-01-01T08:00:00Z') RETURNING id",
  )
    .bind(userId)
    .first<{ id: number }>();
  if (!row) throw new Error('reminder insert failed');
  return row.id;
}

async function insertFire(reminderId: number, fireAt: string, status: string): Promise<void> {
  await env.DB.prepare('INSERT INTO reminder_fires (reminder_id, fire_at, status) VALUES (?, ?, ?)')
    .bind(reminderId, fireAt, status)
    .run();
}

async function insertAudit(event: string, occurredAt: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log (user_id, event, meta, occurred_at) VALUES (NULL, ?, '{}', ?)",
  )
    .bind(event, occurredAt)
    .run();
}

describe('retention pruning', () => {
  it('deletes reminder_fires older than the retention window if they are terminal', async () => {
    const uid = await insertUser();
    const rid = await insertReminder(uid);
    const now = new Date('2026-06-01T00:00:00Z');
    const oldDate = new Date(now.getTime() - 60 * DAY_MS).toISOString();
    const recentDate = new Date(now.getTime() - 5 * DAY_MS).toISOString();

    await insertFire(rid, oldDate, 'sent');
    await insertFire(rid, recentDate, 'sent');

    const result = await pruneOldRows(getDb(env), now);
    expect(result.firesDeleted).toBe(1);

    const remaining = await env.DB.prepare(
      'SELECT fire_at FROM reminder_fires ORDER BY fire_at',
    ).all<{ fire_at: string }>();
    expect(remaining.results.map((r) => r.fire_at)).toEqual([recentDate]);
  });

  it('NEVER deletes queued or failed fires, even if they are older than retention', async () => {
    const uid = await insertUser();
    const rid = await insertReminder(uid);
    const now = new Date('2026-06-01T00:00:00Z');
    const old1 = new Date(now.getTime() - 90 * DAY_MS).toISOString();
    const old2 = new Date(now.getTime() - 91 * DAY_MS).toISOString();
    const old3 = new Date(now.getTime() - 92 * DAY_MS).toISOString();

    await insertFire(rid, old1, 'queued');
    await insertFire(rid, old2, 'failed');
    await insertFire(rid, old3, 'skipped');

    const result = await pruneOldRows(getDb(env), now);
    expect(result.firesDeleted).toBe(1);

    const remaining = await env.DB.prepare(
      'SELECT status FROM reminder_fires ORDER BY status',
    ).all<{ status: string }>();
    expect(remaining.results.map((r) => r.status).sort()).toEqual(['failed', 'queued']);
  });

  it('deletes audit_log rows older than the retention window', async () => {
    const now = new Date('2026-06-01T00:00:00Z');
    await insertAudit('old', new Date(now.getTime() - 60 * DAY_MS).toISOString());
    await insertAudit('recent', new Date(now.getTime() - 1 * DAY_MS).toISOString());

    const result = await pruneOldRows(getDb(env), now);
    expect(result.auditDeleted).toBe(1);

    const remaining = await env.DB.prepare('SELECT event FROM audit_log').all<{ event: string }>();
    expect(remaining.results.map((r) => r.event)).toEqual(['recent']);
  });

  it('is a no-op when nothing is older than retention', async () => {
    const now = new Date('2026-06-01T00:00:00Z');
    await insertAudit('fresh', now.toISOString());
    const uid = await insertUser();
    const rid = await insertReminder(uid);
    await insertFire(rid, now.toISOString(), 'sent');

    const result = await pruneOldRows(getDb(env), now);
    expect(result).toEqual({ firesDeleted: 0, auditDeleted: 0 });
  });

  it('honours an explicit retentionDays override', async () => {
    const now = new Date('2026-06-01T00:00:00Z');
    await insertAudit('a', new Date(now.getTime() - 10 * DAY_MS).toISOString());

    let result = await pruneOldRows(getDb(env), now);
    expect(result.auditDeleted).toBe(0);

    result = await pruneOldRows(getDb(env), now, 5);
    expect(result.auditDeleted).toBe(1);
  });

  it('exposes the public retention window', () => {
    expect(RETENTION_DAYS).toBe(30);
  });
});
