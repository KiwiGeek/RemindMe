import { type DrizzleD1Database, drizzle as drizzleD1 } from 'drizzle-orm/d1';
import * as schema from '~/db/schema';
import type { Env } from '~/env';

/**
 * Drizzle SQLite handle. Workers use D1; Node casts a better-sqlite3
 * client to this structural type (await works on sync results).
 */
export type AppDb = DrizzleD1Database<typeof schema>;
export type DB = AppDb;

/**
 * Resolve the Drizzle client for this process.
 * Cloudflare: `env.DB` (D1). Node: `env.__db` set by the Node entrypoint.
 */
export function getDb(env: Env): AppDb {
  if (env.__db) return env.__db;
  if (!env.DB) {
    throw new Error('DB binding missing — set env.DB (Workers) or env.__db (Node)');
  }
  return drizzleD1(env.DB, { schema });
}
