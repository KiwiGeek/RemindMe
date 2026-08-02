/**
 * Admin authorization. Source of truth is `users.is_admin` (set by setup
 * wizard or an existing admin). Legacy ADMIN_EMAILS is only used by the
 * env→settings bridge on upgrade.
 */

import { eq } from 'drizzle-orm';
import type { AppDb } from '~/db/client';
import { auditLog, users } from '~/db/schema';

export function parseAdminEmails(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.includes('@'));
}

export async function isAdminUserId(db: AppDb, userId: number): Promise<boolean> {
  const row = (
    await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId)).limit(1)
  )[0];
  return row?.isAdmin === 1;
}

export type AdminEvent =
  | 'admin_user_create'
  | 'admin_user_timezone_change'
  | 'admin_user_promote'
  | 'admin_reminder_create'
  | 'admin_reminder_update'
  | 'admin_reminder_delete'
  | 'admin_settings_update'
  | 'admin_test_email'
  | 'admin_export'
  | 'admin_import';

export interface AdminAuditMeta {
  admin_user_id: number;
  target_user_id?: number;
  reminder_id?: number;
  to?: string;
  change?: Record<string, unknown>;
}

export async function writeAudit(
  db: AppDb,
  event: AdminEvent,
  meta: AdminAuditMeta,
): Promise<void> {
  await db.insert(auditLog).values({
    userId: meta.admin_user_id,
    event,
    meta: JSON.stringify(meta),
  });
}
