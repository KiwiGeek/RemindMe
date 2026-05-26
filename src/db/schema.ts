import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  timezone: text('timezone').notNull().default('UTC'),
  tzConfirmed: integer('tz_confirmed').notNull().default(0),
  status: text('status', { enum: ['active', 'suspended'] })
    .notNull()
    .default('active'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const reminderStatusValues = [
  'active',
  'paused',
  'completed',
  'suspended',
  'deleted',
] as const;
export type ReminderStatus = (typeof reminderStatusValues)[number];

export const reminders = sqliteTable(
  'reminders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull().default(''),
    rrule: text('rrule').notNull(),
    /** Wall-clock ISO-8601 (no offset), interpreted in `timezone`. */
    dtstart: text('dtstart').notNull(),
    timezone: text('timezone').notNull(),
    /** Cached UTC ISO-8601 of the next firing; null when exhausted. */
    nextFireAt: text('next_fire_at'),
    /** Null = indefinite; positive integer = how many fires remain. */
    remainingCount: integer('remaining_count'),
    status: text('status', { enum: reminderStatusValues }).notNull().default('active'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    dueIdx: index('idx_reminders_due').on(t.status, t.nextFireAt),
    userIdx: index('idx_reminders_user').on(t.userId),
  }),
);

export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;

export const reminderFireStatusValues = ['queued', 'sent', 'failed', 'skipped'] as const;
export type ReminderFireStatus = (typeof reminderFireStatusValues)[number];

export const reminderFires = sqliteTable(
  'reminder_fires',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reminderId: integer('reminder_id')
      .notNull()
      .references(() => reminders.id),
    fireAt: text('fire_at').notNull(),
    sentAt: text('sent_at'),
    mailgunMessageId: text('mailgun_message_id'),
    status: text('status', { enum: reminderFireStatusValues }).notNull(),
    error: text('error'),
    actionConsumedAt: text('action_consumed_at'),
  },
  (t) => ({
    reminderIdx: index('idx_reminder_fires_reminder').on(t.reminderId),
    uniqueFire: uniqueIndex('reminder_fires_unique_fire').on(t.reminderId, t.fireAt),
  }),
);

export type ReminderFire = typeof reminderFires.$inferSelect;

export const suppressionReasonValues = ['bounce', 'complaint', 'unsubscribe'] as const;
export type SuppressionReason = (typeof suppressionReasonValues)[number];

export const suppressions = sqliteTable('suppressions', {
  email: text('email').primaryKey(),
  reason: text('reason', { enum: suppressionReasonValues }).notNull(),
  occurredAt: text('occurred_at').notNull(),
  raw: text('raw'),
  clearedAt: text('cleared_at'),
});

export const passkeys = sqliteTable(
  'passkeys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    /** base64url-encoded credentialId from the authenticator. */
    credentialId: text('credential_id').notNull().unique(),
    /** base64url-encoded COSE public key bytes (Uint8Array → base64url). */
    publicKey: text('public_key').notNull(),
    /** WebAuthn signature counter; we reject responses that don't advance it. */
    counter: integer('counter').notNull().default(0),
    /** JSON-encoded `AuthenticatorTransport[]`, e.g. `["internal","hybrid"]`. */
    transports: text('transports'),
    /** User-visible label so they can tell their keys apart in the management UI. */
    nickname: text('nickname'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    lastUsedAt: text('last_used_at'),
  },
  (t) => ({
    userIdx: index('idx_passkeys_user').on(t.userId),
  }),
);

export type Passkey = typeof passkeys.$inferSelect;

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id'),
    event: text('event').notNull(),
    meta: text('meta'),
    occurredAt: text('occurred_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    userIdx: index('idx_audit_user').on(t.userId, t.occurredAt),
  }),
);
