/**
 * Node/Docker entrypoint: SQLite + in-process cron + static SPA.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import cron from 'node-cron';
import { createApp } from '~/app';
import type { AppDb } from '~/db/client';
import * as schema from '~/db/schema';
import type { Env } from '~/env';
import { pruneOldRows } from '~/lib/retention';
import { runScheduledTick } from '~/lib/scheduler';
import { SqliteKv } from '~/platform/sqliteKv';

const __dirname = dirname(fileURLToPath(import.meta.url));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[remindme] missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

function applyMigrations(sqlite: Database.Database, migrationsDir: string) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _remindme_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    (sqlite.prepare('SELECT id FROM _remindme_migrations').all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = readFileSync(join(migrationsDir, file), 'utf8');
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(sqlText);
      sqlite.prepare('INSERT INTO _remindme_migrations (id) VALUES (?)').run(file);
      sqlite.exec('COMMIT');
      console.log('[remindme] applied migration', file);
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  }
}

async function main() {
  const instanceSecret = requireEnv('INSTANCE_SECRET');
  const databasePath = process.env.DATABASE_PATH ?? '/data/remindme.sqlite';
  const port = Number(process.env.PORT ?? '8080');
  const trustProxy = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

  mkdirSync(dirname(resolve(databasePath)), { recursive: true });

  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const migrationsDir = join(__dirname, '..', 'migrations');
  applyMigrations(sqlite, migrationsDir);

  const db = drizzle(sqlite, { schema }) as unknown as AppDb;
  const kv = new SqliteKv(db);

  const env: Env = {
    INSTANCE_SECRET: instanceSecret,
    __db: db,
    __kv: kv,
    MAILGUN_REGION: process.env.MAILGUN_REGION === 'eu' ? 'eu' : 'us',
  };
  if (process.env.SETUP_TOKEN) env.SETUP_TOKEN = process.env.SETUP_TOKEN;
  if (trustProxy) env.TRUST_PROXY = '1';
  if (process.env.APP_NAME) env.APP_NAME = process.env.APP_NAME;
  if (process.env.SITE_ORIGIN) env.SITE_ORIGIN = process.env.SITE_ORIGIN;
  if (process.env.MAILGUN_DOMAIN) env.MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN;
  if (process.env.MAILGUN_FROM) env.MAILGUN_FROM = process.env.MAILGUN_FROM;
  if (process.env.MAILGUN_REPLY_TO) env.MAILGUN_REPLY_TO = process.env.MAILGUN_REPLY_TO;
  if (process.env.ADMIN_EMAILS) env.ADMIN_EMAILS = process.env.ADMIN_EMAILS;
  if (process.env.MAILGUN_API_KEY) env.MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
  if (process.env.MAILGUN_SIGNING_KEY) env.MAILGUN_SIGNING_KEY = process.env.MAILGUN_SIGNING_KEY;
  if (process.env.SESSION_SECRET) env.SESSION_SECRET = process.env.SESSION_SECRET;
  if (process.env.OTP_PEPPER) env.OTP_PEPPER = process.env.OTP_PEPPER;
  if (process.env.ACTION_TOKEN_SECRET) env.ACTION_TOKEN_SECRET = process.env.ACTION_TOKEN_SECRET;

  const app = createApp();

  const webDist = join(__dirname, '..', 'web', 'dist');
  if (existsSync(webDist)) {
    app.use('/*', serveStatic({ root: webDist }));
    app.get('*', serveStatic({ root: webDist, path: 'index.html' }));
  }

  cron.schedule('*/5 * * * *', () => {
    const now = new Date();
    void (async () => {
      try {
        const stats = await runScheduledTick(env, now);
        console.log('scheduler tick', stats);
      } catch (err) {
        console.error('scheduler tick failed', err);
      }
      try {
        const pruned = await pruneOldRows(db, now);
        if (pruned.firesDeleted > 0 || pruned.auditDeleted > 0) {
          console.log('retention prune', pruned);
        }
        await kv.pruneExpired(now);
      } catch (err) {
        console.error('retention prune failed', err);
      }
    })();
  });

  const tlsCert = process.env.TLS_CERT_PATH;
  const tlsKey = process.env.TLS_KEY_PATH;
  const fetchHandler = (req: Request) => app.fetch(req, env);

  const createServerFn =
    tlsCert && tlsKey
      ? () =>
          createHttpsServer({
            cert: readFileSync(tlsCert),
            key: readFileSync(tlsKey),
          })
      : createServer;

  serve(
    {
      fetch: fetchHandler,
      port,
      hostname: '0.0.0.0',
      createServer: createServerFn,
    },
    (info) => {
      const scheme = tlsCert && tlsKey ? 'https' : 'http';
      console.log(`[remindme] ${scheme} listening on ${info.address}:${info.port}`);
    },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
