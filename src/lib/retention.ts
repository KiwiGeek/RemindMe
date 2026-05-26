/**
 * Retention pruning. Runs from the cron handler once per tick; cheap
 * enough at our scale to skip a dedicated daily cron. Two tables grow
 * unboundedly without intervention:
 *
 * - `reminder_fires`: every send + every skip + every claim is one row.
 *   A daily reminder writes ~365 rows/year.
 * - `audit_log`: admin and suppression events. Lower volume but still
 *   unbounded.
 *
 * 30 days is the documented retention window in PLAN.md §14. Long enough
 * to investigate "why did I get / not get this email last week?"
 * questions, short enough that D1's row limits never come into play.
 *
 * Safety: deletes are scoped by `fire_at` (reminder_fires) and
 * `occurred_at` (audit_log). Both are populated by the Worker itself,
 * not by user input, so there's no spoofing risk in the prune itself.
 *
 * `reminder_fires` rows are only deleted when their status is terminal
 * (`sent`, `skipped`) — never `queued` or `failed`, which the scheduler
 * relies on for retry semantics.
 */

import type { Env } from '~/env';

export const RETENTION_DAYS = 30;

export interface PruneStats {
  firesDeleted: number;
  auditDeleted: number;
}

export async function pruneOldRows(
  env: Env,
  now: Date = new Date(),
  retentionDays: number = RETENTION_DAYS,
): Promise<PruneStats> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Use the raw D1 binding so we have direct access to `.meta.changes`.
  // Drizzle wraps these to varying shapes across versions, and a raw
  // prepared statement is unambiguous.
  const firesResult = await env.DB.prepare(
    "DELETE FROM reminder_fires WHERE fire_at < ? AND status IN ('sent','skipped')",
  )
    .bind(cutoff)
    .run();
  const auditResult = await env.DB.prepare('DELETE FROM audit_log WHERE occurred_at < ?')
    .bind(cutoff)
    .run();

  return {
    firesDeleted: firesResult.meta?.changes ?? 0,
    auditDeleted: auditResult.meta?.changes ?? 0,
  };
}
