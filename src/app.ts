import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { getDb } from '~/db/client';
import type { AppBindings } from '~/env';
import { loadConfig, maybeBridgeFromEnv, syncLegacyAdmins } from '~/lib/config';
import { checkEnv } from '~/lib/envCheck';
import { getKv } from '~/platform/getKv';
import { admin } from '~/routes/admin';
import { auth } from '~/routes/auth';
import { healthz } from '~/routes/healthz';
import { me } from '~/routes/me';
import { passkeysRoute } from '~/routes/passkeys';
import { r } from '~/routes/r';
import { remindersRoute } from '~/routes/reminders';
import { setup } from '~/routes/setup';
import { webhooks } from '~/routes/webhooks';

const SETUP_EXEMPT = new Set([
  '/api/healthz',
  '/api/setup/status',
  '/api/setup',
  '/api/setup/import',
]);

export function createApp() {
  const app = new Hono<AppBindings>();

  app.use('*', logger());
  app.use('*', async (c, next) => {
    checkEnv(c.env);
    const db = getDb(c.env);
    const kv = getKv(c.env);
    c.set('kv', kv);

    let config = await maybeBridgeFromEnv(c.env, db);
    if (!config) {
      config = await loadConfig(db, c.env.INSTANCE_SECRET);
    }
    if (config) {
      await syncLegacyAdmins(c.env, db);
    }
    c.set('config', config);
    await next();
  });

  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    // SPA / static assets must load before setup so the wizard can render.
    const gated =
      path.startsWith('/api/') || path.startsWith('/webhooks/') || path.startsWith('/r/');
    if (!gated || SETUP_EXEMPT.has(path) || path.startsWith('/api/setup')) {
      return next();
    }
    if (!c.get('config')) {
      return c.json({ error: 'setup_required' }, 503);
    }
    return next();
  });

  app.route('/api/healthz', healthz);
  app.route('/api/setup', setup);
  app.route('/api/auth', auth);
  app.route('/api/me', me);
  app.route('/api/reminders', remindersRoute);
  app.route('/api/passkeys', passkeysRoute);
  app.route('/api/admin', admin);
  app.route('/webhooks', webhooks);
  app.route('/r', r);

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    console.error('unhandled error', err);
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
