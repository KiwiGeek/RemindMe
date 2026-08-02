import { and, like, lt, sql } from 'drizzle-orm';
import type { AppDb } from '~/db/client';
import { kvEntries } from '~/db/schema';
import type { KvPutOptions, KvStore } from '~/platform/kv';

/**
 * SQLite-backed KV with TTL. Expired rows are skipped on read and pruned
 * opportunistically; the Node cron also calls `pruneExpired`.
 */
export class SqliteKv implements KvStore {
  constructor(private readonly db: AppDb) {}

  async get(key: string): Promise<string | null> {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.db
      .select()
      .from(kvEntries)
      .where(sql`${kvEntries.key} = ${key}`)
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt <= now) {
      await this.db.delete(kvEntries).where(sql`${kvEntries.key} = ${key}`);
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, options?: KvPutOptions): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt =
      options?.expirationTtl !== undefined ? now + Math.max(1, options.expirationTtl) : null;
    await this.db.insert(kvEntries).values({ key, value, expiresAt }).onConflictDoUpdate({
      target: kvEntries.key,
      set: { value, expiresAt },
    });
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(kvEntries).where(sql`${kvEntries.key} = ${key}`);
  }

  async list(options: { prefix: string }): Promise<{ keys: { name: string }[] }> {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.db
      .select({ key: kvEntries.key, expiresAt: kvEntries.expiresAt })
      .from(kvEntries)
      .where(like(kvEntries.key, `${options.prefix}%`));
    return {
      keys: rows
        .filter((r) => r.expiresAt === null || r.expiresAt > now)
        .map((r) => ({ name: r.key })),
    };
  }

  async pruneExpired(now: Date = new Date()): Promise<number> {
    const ts = Math.floor(now.getTime() / 1000);
    const result = await this.db
      .delete(kvEntries)
      .where(and(sql`${kvEntries.expiresAt} IS NOT NULL`, lt(kvEntries.expiresAt, ts)));
    // better-sqlite3 / d1 drizzle: changes available inconsistently; ignore count accuracy.
    void result;
    return 0;
  }
}
