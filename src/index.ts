import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type { AppBindings, Env } from '~/env';
import { healthz } from '~/routes/healthz';

const app = new Hono<AppBindings>();

app.use('*', logger());

app.route('/api/healthz', healthz);

// Anything not handled by /api/* falls through to the static SPA shell.
// `assets.not_found_handling = "single-page-application"` in wrangler.toml
// ensures unknown paths serve index.html for client-side routing.

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Cron tick. Reminder dispatch lands in M3.
    // Intentionally a no-op for M0 so the schedule wires up cleanly without
    // touching D1 (which doesn't exist yet on a fresh clone).
  },
} satisfies ExportedHandler<Env>;
