import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import type { AppBindings, Env } from '~/env';
import { auth } from '~/routes/auth';
import { healthz } from '~/routes/healthz';
import { me } from '~/routes/me';

const app = new Hono<AppBindings>();

app.use('*', logger());

app.route('/api/healthz', healthz);
app.route('/api/auth', auth);
app.route('/api/me', me);

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

  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Cron tick. Reminder dispatch lands in M3.
  },
} satisfies ExportedHandler<Env>;
