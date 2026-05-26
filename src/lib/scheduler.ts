/**
 * Reminder dispatcher invoked from the Worker's `scheduled` handler. The
 * Cloudflare Workers free tier guarantees roughly 5-minute cron granularity,
 * so we query a `LOOKAHEAD_MS` window and fire any reminder due before the
 * next expected tick. Net behaviour: emails arrive on or before the scheduled
 * minute, never noticeably late.
 *
 * Per-fire idempotency uses `reminder_fires(reminder_id, fire_at)` as a
 * unique lock. We INSERT-ON-CONFLICT to claim a fire; if another concurrent
 * tick already marked it `sent`, our upsert is a no-op and we move on. A
 * stable Mailgun `Message-Id` (`<reminder-{id}-{fire_at}@example.com>`) gives
 * recipients something to dedupe on if the row-lock ever loses a race.
 *
 * Failed sends keep the row at `status='failed'`; the next tick re-attempts
 * because the cron query joins out completed fires only.
 */

import { and, eq, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { getDb } from '~/db/client';
import {
  type Reminder,
  type User,
  reminderFires,
  reminders,
  suppressions,
  users,
} from '~/db/schema';
import type { Env } from '~/env';
import { FIRE_ACTIONS, type FireAction, signFireAction, signMagicLink } from '~/lib/actionToken';
import { type ReminderEmailLinks, buildReminderEmail } from '~/lib/emails/reminder';
import { MailgunClient, MailgunError } from '~/lib/mailgun';
import { nextFires } from '~/lib/recurrence';
import { renderReminder } from '~/lib/render';

/** 6 minutes — cron interval (5) + 1 minute of jitter slack. */
export const LOOKAHEAD_MS = 6 * 60 * 1000;
const MAX_FIRES_PER_TICK = 50;

export interface TickStats {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function runScheduledTick(env: Env, now: Date = new Date()): Promise<TickStats> {
  const db = getDb(env);
  const mailgun = new MailgunClient(env);
  const horizon = new Date(now.getTime() + LOOKAHEAD_MS).toISOString();
  const stats: TickStats = { scanned: 0, sent: 0, skipped: 0, failed: 0 };

  // Pull due reminders + their owner in one round-trip. We deliberately
  // LIMIT so a backlog can't blow the per-tick CPU budget; remaining due
  // reminders ride the next tick (still on-time given the look-ahead).
  const due = await db
    .select({ reminder: reminders, user: users })
    .from(reminders)
    .innerJoin(users, eq(users.id, reminders.userId))
    .where(
      and(
        eq(reminders.status, 'active'),
        eq(users.status, 'active'),
        isNotNull(reminders.nextFireAt),
        lte(reminders.nextFireAt, horizon),
      ),
    )
    .limit(MAX_FIRES_PER_TICK);

  stats.scanned = due.length;

  for (const row of due) {
    try {
      const result = await dispatchOne(env, db, mailgun, row.reminder, row.user, now);
      stats[result] += 1;
    } catch (err) {
      // dispatchOne already records per-fire errors. Catching here means a
      // single misbehaving reminder can't take down the whole tick.
      stats.failed += 1;
      console.error('scheduler: unhandled dispatch error', {
        reminderId: row.reminder.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return stats;
}

type DispatchOutcome = 'sent' | 'skipped' | 'failed';

async function dispatchOne(
  env: Env,
  db: ReturnType<typeof getDb>,
  mailgun: MailgunClient,
  reminder: Reminder,
  user: User,
  now: Date,
): Promise<DispatchOutcome> {
  const fireAt = reminder.nextFireAt;
  if (!fireAt) return 'skipped';

  // What's the *next* fire after this one? Used both for the email's
  // `{{next_date}}` template variable and for advancing the reminder.
  const nextAfter =
    nextFires(
      { rrule: reminder.rrule, dtstart: reminder.dtstart, timezone: reminder.timezone },
      1,
      { afterUtc: fireAt },
    )[0] ?? null;

  // Defence in depth: skip if the recipient is currently suppressed.
  // M5 populates this table from Mailgun webhooks.
  const suppressed = await db
    .select({ email: suppressions.email })
    .from(suppressions)
    .where(and(eq(suppressions.email, user.email), sql`${suppressions.clearedAt} IS NULL`))
    .limit(1);
  if (suppressed.length > 0) {
    await claimFire(db, reminder.id, fireAt, 'skipped', 'suppressed');
    await advanceReminder(db, reminder, nextAfter);
    return 'skipped';
  }

  const claim = await claimFire(db, reminder.id, fireAt, 'queued', null);
  if (claim.status === 'already_sent') return 'skipped';

  const occurrenceNumber = (await countSentFires(db, reminder.id)) + 1;
  const willHaveMore =
    reminder.remainingCount === null ? nextAfter !== null : reminder.remainingCount > 1;
  const nextFireUtc = willHaveMore ? nextAfter : null;

  const rendered = renderReminder({
    title: reminder.title,
    bodyMd: reminder.bodyMd,
    timezone: reminder.timezone,
    fireAtUtc: fireAt,
    occurrenceNumber,
    remainingCount:
      reminder.remainingCount === null ? null : Math.max(0, reminder.remainingCount - 1),
    nextFireUtc,
    dtstartWall: reminder.dtstart,
    userEmail: user.email,
  });

  const links = await buildLinks(env, reminder.id, claim.fireId, user.id);
  const email = buildReminderEmail({ rendered, links });
  const messageId = `reminder-${reminder.id}-${encodeURIComponent(fireAt)}@${env.MAILGUN_DOMAIN}`;

  try {
    const result = await mailgun.send({
      to: user.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
      tags: ['reminder'],
      messageId,
      listUnsubscribe: email.listUnsubscribe,
    });
    await db
      .update(reminderFires)
      .set({
        status: 'sent',
        sentAt: now.toISOString(),
        mailgunMessageId: result.id,
        error: null,
      })
      .where(and(eq(reminderFires.reminderId, reminder.id), eq(reminderFires.fireAt, fireAt)));
    await advanceReminder(db, reminder, nextAfter);
    return 'sent';
  } catch (err) {
    const message =
      err instanceof MailgunError
        ? `${err.message}: ${err.body.slice(0, 500)}`
        : err instanceof Error
          ? err.message
          : String(err);
    await db
      .update(reminderFires)
      .set({ status: 'failed', error: message })
      .where(and(eq(reminderFires.reminderId, reminder.id), eq(reminderFires.fireAt, fireAt)));
    console.error('scheduler: send failed', { reminderId: reminder.id, fireAt, message });
    return 'failed';
  }
}

interface ClaimResult {
  status: 'claimed' | 'already_sent';
  fireId: number;
}

async function claimFire(
  db: ReturnType<typeof getDb>,
  reminderId: number,
  fireAt: string,
  status: 'queued' | 'skipped',
  error: string | null,
): Promise<ClaimResult> {
  // Raw SQL because the conditional UPDATE clause maps cleanly to SQLite's
  // ON CONFLICT DO UPDATE ... WHERE form and Drizzle's setWhere helper isn't
  // available on all installed versions.
  await db.run(sql`
    INSERT INTO reminder_fires (reminder_id, fire_at, status, error)
    VALUES (${reminderId}, ${fireAt}, ${status}, ${error})
    ON CONFLICT(reminder_id, fire_at) DO UPDATE
      SET status = excluded.status, error = excluded.error
      WHERE reminder_fires.status IN ('queued', 'failed')
  `);
  const after = await db
    .select({ id: reminderFires.id, status: reminderFires.status })
    .from(reminderFires)
    .where(and(eq(reminderFires.reminderId, reminderId), eq(reminderFires.fireAt, fireAt)))
    .limit(1);
  const row = after[0];
  if (!row) throw new Error('claim_fire_missing_row');
  return {
    status: row.status === 'sent' ? 'already_sent' : 'claimed',
    fireId: row.id,
  };
}

async function buildLinks(
  env: Env,
  reminderId: number,
  fireId: number,
  userId: number,
): Promise<ReminderEmailLinks> {
  const origin = env.SITE_ORIGIN;
  const fireActions = {} as Record<FireAction, string>;
  await Promise.all(
    FIRE_ACTIONS.map(async (op) => {
      const token = await signFireAction(env.ACTION_TOKEN_SECRET, {
        rid: reminderId,
        fid: fireId,
        op,
      });
      fireActions[op] = `${origin}/r/${token}`;
    }),
  );
  const magicToken = await signMagicLink(env.ACTION_TOKEN_SECRET, userId);
  return {
    fireActions,
    manageUrl: `${origin}/r/${magicToken}`,
    listUnsubscribeUrl: fireActions.unsub,
  };
}

async function countSentFires(db: ReturnType<typeof getDb>, reminderId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(reminderFires)
    .where(and(eq(reminderFires.reminderId, reminderId), eq(reminderFires.status, 'sent')));
  return Number(rows[0]?.n ?? 0);
}

async function advanceReminder(
  db: ReturnType<typeof getDb>,
  reminder: Reminder,
  nextFireUtc: string | null,
): Promise<void> {
  let newRemaining: number | null = reminder.remainingCount;
  let newStatus: Reminder['status'] = reminder.status;
  let newNext: string | null = nextFireUtc;

  if (reminder.remainingCount !== null) {
    newRemaining = reminder.remainingCount - 1;
    if (newRemaining <= 0) {
      newStatus = 'completed';
      newNext = null;
    }
  } else if (!newNext) {
    newStatus = 'completed';
  }

  await db
    .update(reminders)
    .set({
      nextFireAt: newNext,
      remainingCount: newRemaining,
      status: newStatus,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(reminders.id, reminder.id), ne(reminders.status, 'deleted')));
}
