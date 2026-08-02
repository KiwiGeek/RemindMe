import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { getDb } from '~/db/client';
import type { AppBindings } from '~/env';
import { isSetupComplete } from '~/lib/config';

export const healthz = new Hono<AppBindings>().get('/', async (c) => {
  const config = c.get('config');
  let dbStatus: 'ok' | 'error' = 'ok';
  let setupCompleted = Boolean(config);
  try {
    const db = getDb(c.env);
    setupCompleted = await isSetupComplete(db);
    await db.run(sql`SELECT 1`);
  } catch {
    dbStatus = 'error';
  }

  const appName = config?.appName ?? c.env.APP_NAME ?? 'Remind Me';
  const ok = dbStatus === 'ok';
  return c.json(
    {
      status: ok ? 'ok' : 'error',
      ok,
      app: appName,
      setupCompleted,
      db: dbStatus,
      time: new Date().toISOString(),
    },
    ok ? 200 : 503,
  );
});
