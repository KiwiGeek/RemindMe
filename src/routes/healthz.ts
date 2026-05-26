import { Hono } from 'hono';
import type { AppBindings } from '~/env';

export const healthz = new Hono<AppBindings>().get('/', (c) => {
  return c.json({
    status: 'ok',
    app: c.env.APP_NAME,
    time: new Date().toISOString(),
  });
});
