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

/**
 * Require a valid session cookie. On success, attaches `userId` to the
 * context and re-issues the cookie with a fresh expiry (rolling session).
 */
export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  const token = readSessionCookie(c);
  if (!token) throw new HTTPException(401, { message: 'unauthorized' });

  const payload = await verifySession(c.env.SESSION_SECRET, token);
  if (!payload) throw new HTTPException(401, { message: 'unauthorized' });

  c.set('userId', payload.uid);

  // Refresh cookie if more than 1 day has elapsed since issuance — keeps
  // `Set-Cookie` traffic low while still rolling the expiry.
  const ageDays = (Math.floor(Date.now() / 1000) - payload.iat) / 86400;
  if (ageDays > 1) {
    const fresh = await signSession(c.env.SESSION_SECRET, payload.uid);
    writeSessionCookie(c, fresh);
  }

  await next();
});

/**
 * Require both a valid session AND that the signed-in user's email is on the
 * `ADMIN_EMAILS` allow-list. Returns 403 (not 404) so admins debugging
 * production know the route exists and they just don't have the role.
 */
export const requireAdmin = createMiddleware<AppBindings>(async (c, next) => {
  const token = readSessionCookie(c);
  if (!token) throw new HTTPException(401, { message: 'unauthorized' });
  const payload = await verifySession(c.env.SESSION_SECRET, token);
  if (!payload) throw new HTTPException(401, { message: 'unauthorized' });
  c.set('userId', payload.uid);

  const db = getDb(c.env);
  if (!(await isAdminUserId(c.env, db, payload.uid))) {
    throw new HTTPException(403, { message: 'forbidden' });
  }

  await next();
});
