/**
 * Require a valid session cookie. Secrets come from resolved AppConfig.
 */

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { getDb } from '~/db/client';
import type { AppBindings } from '~/env';
import { isAdminUserId } from '~/lib/admin';
import { readSessionCookie, signSession, verifySession, writeSessionCookie } from '~/lib/session';

declare module 'hono' {
  interface ContextVariableMap {
    userId: number;
  }
}

export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  const config = c.get('config');
  if (!config) throw new HTTPException(503, { message: 'setup_required' });

  const token = readSessionCookie(c);
  if (!token) throw new HTTPException(401, { message: 'unauthorized' });

  const payload = await verifySession(config.sessionSecret, token);
  if (!payload) throw new HTTPException(401, { message: 'unauthorized' });

  c.set('userId', payload.uid);

  const ageDays = (Math.floor(Date.now() / 1000) - payload.iat) / 86400;
  if (ageDays > 1) {
    const fresh = await signSession(config.sessionSecret, payload.uid);
    writeSessionCookie(c, fresh);
  }

  await next();
});

export const requireAdmin = createMiddleware<AppBindings>(async (c, next) => {
  const config = c.get('config');
  if (!config) throw new HTTPException(503, { message: 'setup_required' });

  const token = readSessionCookie(c);
  if (!token) throw new HTTPException(401, { message: 'unauthorized' });
  const payload = await verifySession(config.sessionSecret, token);
  if (!payload) throw new HTTPException(401, { message: 'unauthorized' });
  c.set('userId', payload.uid);

  const db = getDb(c.env);
  if (!(await isAdminUserId(db, payload.uid))) {
    throw new HTTPException(403, { message: 'forbidden' });
  }

  await next();
});
