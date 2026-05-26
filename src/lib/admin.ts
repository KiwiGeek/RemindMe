/**
 * Admin authorization plumbing.
 *
 * Source of truth for who's an admin is `env.ADMIN_EMAILS` — a
 * comma-separated, case-insensitive list defined in `wrangler.toml`'s
 * `[vars]` block. Storing this in the worker config (not the DB) means
 * escalating to admin requires shipping a new Worker version, which in turn
 * requires already controlling the deploy pipeline. A DB-stored flag would
 * grant the same capability to anyone with D1 write access.
 *
 * Every mutating admin route writes to `audit_log`. We never impersonate:
 * the admin's session stays the admin's session; the *target* user_id
 * comes from the URL, never from the session, so a stale browser tab can't
 * accidentally cross-edit.
 */

import { eq } from 'drizzle-orm';
import type { getDb } from '~/db/client';
import { auditLog, users } from '~/db/schema';
import type { Env } from '~/env';

export function parseAdminEmails(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.includes('@'));
}

export function isAdminEmail(env: Env, email: string): boolean {
  const list = parseAdminEmails(env.ADMIN_EMAILS);
  return list.includes(email.trim().toLowerCase());
}

/** Look up `userId` and decide admin-ness from the persisted email. */
export async function isAdminUserId(
  env: Env,
  db: ReturnType<typeof getDb>,
  userId: number,
): Promise<boolean> {
  const row = (
    await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1)
  )[0];
  if (!row) return false;
  return isAdminEmail(env, row.email);
}

export type AdminEvent =
  | 'admin_user_create'
  | 'admin_user_timezone_change'
  | 'admin_reminder_create'
  | 'admin_reminder_update'
  | 'admin_reminder_delete';

export interface AdminAuditMeta {
  /** Always populated with the admin's user_id. */
  admin_user_id: number;
  /** Always populated with the target user_id. */
  target_user_id: number;
  /** Optional reminder_id for reminder events. */
  reminder_id?: number;
  /** Free-form payload describing the change. */
  change?: Record<string, unknown>;
}

export async function writeAudit(
  db: ReturnType<typeof getDb>,
  event: AdminEvent,
  meta: AdminAuditMeta,
): Promise<void> {
  await db.insert(auditLog).values({
    userId: meta.admin_user_id,
    event,
    meta: JSON.stringify(meta),
  });
}
