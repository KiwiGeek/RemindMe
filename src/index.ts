import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import type { AppBindings, Env } from '~/env';
import { checkEnv } from '~/lib/envCheck';
import { runScheduledTick } from '~/lib/scheduler';
import { admin } from '~/routes/admin';
import { auth } from '~/routes/auth';
import { healthz } from '~/routes/healthz';
import { me } from '~/routes/me';
import { r } from '~/routes/r';
import { remindersRoute } from '~/routes/reminders';

const app = new Hono<AppBindings>();

app.use('*', logger());
app.use('*', async (c, next) => {
  checkEnv(c.env);
  await next();
});

app.route('/api/healthz', healthz);
app.route('/api/auth', auth);
app.route('/api/me', me);
app.route('/api/reminders', remindersRoute);
app.route('/api/admin', admin);
app.route('/r', r);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error('unhandled error', err);
  return c.json({ error: 'internal' }, 500);
});

// Anything not handled by /api/* falls through to the static SPA shell.
// `assets.not_found_handling = "single-page-application"` in wrangler.toml
// ensures unknown paths serve index.html for client-side routing.

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
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
