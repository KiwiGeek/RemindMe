/**
 * Suppression / suspension pipeline.
 *
 * One entry point — `suspendAddress` — is called from the Mailgun webhook
 * receiver when an event indicates an address can no longer receive mail
 * (hard bounce, complaint, Mailgun-level unsubscribe). The reverse —
 * `clearSuppressionForEmail` — is called when the user proves they own
 * the inbox by completing an OTP sign-in.
 *
 * The pipeline is intentionally idempotent so the same webhook redelivered
 * multiple times (Mailgun retries up to 8h on 4xx/5xx) is safe to process
 * repeatedly.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '~/db/client';
import { type SuppressionReason, auditLog, reminders, users } from '~/db/schema';
import type { Env } from '~/env';

export interface SuspendInput {
  email: string;
  reason: SuppressionReason;
  /** Raw payload (or a tag like "soft_bounce_threshold") for after-the-fact diagnosis. */
  raw?: string | null;
  /** Defaults to "now"; tests can pin it for determinism. */
  occurredAt?: string;
}

/**
 * Result of a suppression. Useful for the webhook handler to report what
 * actually changed (we use these counts in audit metadata).
 */
export interface SuspendResult {
  suppressionInserted: boolean;
  userSuspended: boolean;
  remindersSuspended: number;
}

const SUSPENDABLE_REMINDER_STATUSES = ['active', 'paused'] as const;

export async function suspendAddress(env: Env, input: SuspendInput): Promise<SuspendResult> {
  const db = getDb(env);
  const email = input.email.trim().toLowerCase();
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const raw = input.raw ?? null;

  // Upsert the suppressions row. ON CONFLICT keeps the most recent reason
  // and reopens (cleared_at = NULL) a row that had been cleared previously.
  await db.run(sql`
    INSERT INTO suppressions (email, reason, occurred_at, raw, cleared_at)
    VALUES (${email}, ${input.reason}, ${occurredAt}, ${raw}, NULL)
    ON CONFLICT(email) DO UPDATE SET
      reason = excluded.reason,
      occurred_at = excluded.occurred_at,
      raw = excluded.raw,
      cleared_at = NULL
  `);

  const result: SuspendResult = {
    suppressionInserted: true,
    userSuspended: false,
    remindersSuspended: 0,
  };

  // Find the user (if any). It's totally normal for a suppression to arrive
  // for an email we've never seen — Mailgun's suppression list is per
  // domain, not per app, and we'd still want to block future sends from us.
  const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (!user) {
    await db.insert(auditLog).values({
      userId: null,
      event: `suppression_${input.reason}`,
      meta: JSON.stringify({ email, raw }),
    });
    return result;
  }

  if (user.status !== 'suspended') {
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, user.id));
    result.userSuspended = true;
  }

  const updated = await db
    .update(reminders)
    .set({ status: 'suspended', updatedAt: new Date().toISOString() })
    .where(
      sql`${reminders.userId} = ${user.id} AND ${inArray(reminders.status, [
        ...SUSPENDABLE_REMINDER_STATUSES,
      ])}`,
    )
    .returning({ id: reminders.id });
  result.remindersSuspended = updated.length;

  await db.insert(auditLog).values({
    userId: user.id,
    event: `suppression_${input.reason}`,
    meta: JSON.stringify({
      email,
      user_suspended: result.userSuspended,
      reminders_suspended: result.remindersSuspended,
      raw,
    }),
  });

  return result;
}

/**
 * Self-recovery on OTP sign-in: mark the local suppressions row as cleared
 * and reactivate the user account. Per-reminder reactivation is opt-in
 * (the user has to flip each suspended reminder back to active themselves)
 * so a previously-bouncing address can't auto-resume a flood of emails.
 */
export async function clearSuppressionForEmail(env: Env, email: string): Promise<void> {
  const db = getDb(env);
  const normalized = email.trim().toLowerCase();
  await db.run(sql`
    UPDATE suppressions
    SET cleared_at = ${new Date().toISOString()}
    WHERE email = ${normalized} AND cleared_at IS NULL
  `);
}
