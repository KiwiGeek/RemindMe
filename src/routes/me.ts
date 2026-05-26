import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getDb } from '~/db/client';
import { users } from '~/db/schema';
import type { AppBindings } from '~/env';
import { requireAuth } from '~/lib/auth';

/**
 * IANA timezone validation: lean on the runtime's tz database via
 * `Intl.supportedValuesOf('timeZone')` when available, otherwise probe
 * with `Intl.DateTimeFormat`. Workers' V8 supports both.
 */
function isValidTimeZone(tz: string): boolean {
  if (typeof Intl.supportedValuesOf === 'function') {
    return Intl.supportedValuesOf('timeZone').includes(tz);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const patchBody = z.object({
  timezone: z.string().min(1).max(64).optional(),
  tzConfirmed: z.boolean().optional(),
});

export const me = new Hono<AppBindings>()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const db = getDb(c.env);
    const userId = c.get('userId');
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user) throw new HTTPException(401, { message: 'unauthorized' });
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        timezone: user.timezone,
        tzConfirmed: user.tzConfirmed === 1,
        status: user.status,
      },
    });
  })
  .patch('/', zValidator('json', patchBody), async (c) => {
    const { timezone, tzConfirmed } = c.req.valid('json');
    if (timezone === undefined && tzConfirmed === undefined) {
      return c.json({ error: 'no_changes' }, 400);
    }
    if (timezone !== undefined && !isValidTimeZone(timezone)) {
      return c.json({ error: 'invalid_timezone' }, 400);
    }

    const db = getDb(c.env);
    const userId = c.get('userId');
    const patch: Partial<typeof users.$inferInsert> = {};
    if (timezone !== undefined) patch.timezone = timezone;
    if (tzConfirmed !== undefined) patch.tzConfirmed = tzConfirmed ? 1 : 0;

    const updated = await db.update(users).set(patch).where(eq(users.id, userId)).returning();
    const user = updated[0];
    if (!user) throw new HTTPException(404, { message: 'not_found' });
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        timezone: user.timezone,
        tzConfirmed: user.tzConfirmed === 1,
        status: user.status,
      },
    });
  });
