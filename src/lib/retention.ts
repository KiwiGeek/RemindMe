/**
 * Retention pruning via Drizzle (works on D1 and better-sqlite3).
 */

import { and, inArray, lt, sql } from 'drizzle-orm';
import type { AppDb } from '~/db/client';
import { auditLog, reminderFires } from '~/db/schema';

export const RETENTION_DAYS = 30;

export interface PruneStats {
  firesDeleted: number;
  auditDeleted: number;
}

export async function pruneOldRows(
  db: AppDb,
  now: Date = new Date(),
  retentionDays: number = RETENTION_DAYS,
): Promise<PruneStats> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const fires = await db
    .delete(reminderFires)
    .where(
      and(lt(reminderFires.fireAt, cutoff), inArray(reminderFires.status, ['sent', 'skipped'])),
    );
  const audit = await db.delete(auditLog).where(lt(auditLog.occurredAt, cutoff));

  // D1 exposes rowsWritten / changes via different shapes; best-effort counts.
  const firesDeleted = extractChanges(fires);
  const auditDeleted = extractChanges(audit);
  void sql;

  return { firesDeleted, auditDeleted };
}

function extractChanges(result: unknown): number {
  if (result && typeof result === 'object') {
    const r = result as { rowsAffected?: number; changes?: number; meta?: { changes?: number } };
    if (typeof r.rowsAffected === 'number') return r.rowsAffected;
    if (typeof r.changes === 'number') return r.changes;
    if (typeof r.meta?.changes === 'number') return r.meta.changes;
  }
  return 0;
}
