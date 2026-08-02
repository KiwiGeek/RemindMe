import { createApp } from '~/app';
import { getDb } from '~/db/client';
import type { Env } from '~/env';
import { checkEnv } from '~/lib/envCheck';
import { pruneOldRows } from '~/lib/retention';
import { runScheduledTick } from '~/lib/scheduler';
import { SqliteKv } from '~/platform/sqliteKv';

const app = createApp();

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    checkEnv(env);
    ctx.waitUntil(
      (async () => {
        try {
          const stats = await runScheduledTick(env, new Date(event.scheduledTime));
          console.log('scheduler tick', stats);
        } catch (err) {
          console.error('scheduler tick failed', err);
        }
        try {
          const db = getDb(env);
          const pruned = await pruneOldRows(db, new Date(event.scheduledTime));
          if (pruned.firesDeleted > 0 || pruned.auditDeleted > 0) {
            console.log('retention prune', pruned);
          }
          if (env.__kv instanceof SqliteKv) {
            await env.__kv.pruneExpired(new Date(event.scheduledTime));
          }
        } catch (err) {
          console.error('retention prune failed', err);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
