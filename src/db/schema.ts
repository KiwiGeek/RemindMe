/**
 * Drizzle schema for D1. Kept intentionally light at M0 — the full reminder
 * model lands in M2 alongside the CRUD routes. Storing this file now so the
 * Drizzle config + migration tooling have something to point at.
 */

import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
