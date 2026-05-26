/**
 * Admin endpoints. Every route here:
 *  - requires an authenticated session whose email is in `ADMIN_EMAILS`,
 *  - resolves the *target* user exclusively from `:id` in the URL (never
 *    from the session), so a stale tab can never cross-edit,
 *  - writes an `audit_log` row for any mutating action.
 *
 * Admins can create reminders for users who have never signed in. The flow is
 * `POST /api/admin/users` to provision the row with `tz_confirmed = 0`, then
 * `POST /api/admin/users/:id/reminders` as usual. When that user later runs
 * the regular OTP flow, `/api/auth/verify` finds the existing row by email
 * and signs them in; their pre-loaded reminders are already there.
 */

import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, like, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getDb } from '~/db/client';
import { type User, reminders, users } from '~/db/schema';
import type { AppBindings } from '~/env';
import { writeAudit } from '~/lib/admin';
import { requireAdmin } from '~/lib/auth';
import { RecurrenceValidationError, nextFires, summarize, validateInputs } from '~/lib/recurrence';
import { renderReminder } from '~/lib/render';
import { isValidTimeZone, presentUser } from '~/routes/me';
import {
  computeInitialFire,
  computeNextFireAfter,
  createReminderBody,
  patchReminderBody,
  presentReminder,
  previewReminderBody,
  validationErrorResponse,
} from '~/routes/reminders';

const emailSchema = z.string().trim().toLowerCase().min(3).max(254).email();

const createUserBody = z.object({
  email: emailSchema,
  /** Optional default timezone. Falls back to UTC. */
  timezone: z.string().min(1).max(64).optional(),
});

const patchUserBody = z
  .object({
    /** Only timezone is mutable from the admin UI for now. */
    timezone: z.string().min(1).max(64).optional(),
  })
  .refine((v) => v.timezone !== undefined, { message: 'no_changes' });

const listUsersQuery = z.object({
  q: z.string().trim().min(1).max(254).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

async function loadTargetUser(db: ReturnType<typeof getDb>, id: number): Promise<User> {
  const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
  if (!row) throw new HTTPException(404, { message: 'user_not_found' });
  return row;
}

export const admin = new Hono<AppBindings>()
  .use('*', requireAdmin)

  .get('/users', zValidator('query', listUsersQuery), async (c) => {
    const { q, limit, offset } = c.req.valid('query');
    const db = getDb(c.env);
    const where = q ? like(users.email, `%${q.toLowerCase()}%`) : undefined;
    const rows = await db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);
    return c.json({ users: rows.map((u) => presentUser(c.env, u)) });
  })

  .post('/users', zValidator('json', createUserBody), async (c) => {
    const { email, timezone } = c.req.valid('json');
    if (timezone !== undefined && !isValidTimeZone(timezone)) {
      return c.json({ error: 'invalid_timezone' }, 400);
    }
    const db = getDb(c.env);

    const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    if (existing) {
      // Don't silently merge — let the admin decide what to do.
      return c.json({ error: 'user_exists', user: presentUser(c.env, existing) }, 409);
    }

    const inserted = await db
      .insert(users)
      .values({
        email,
        timezone: timezone ?? 'UTC',
        // `tz_confirmed = 0` (default) → the user will see the timezone
        // confirmation banner on their first real sign-in.
      })
      .returning();
    const created = inserted[0];
    if (!created) throw new HTTPException(500, { message: 'insert_failed' });

    await writeAudit(db, 'admin_user_create', {
      admin_user_id: c.get('userId'),
      target_user_id: created.id,
      change: { email: created.email, timezone: created.timezone },
    });

    return c.json({ user: presentUser(c.env, created) }, 201);
  })

  .get('/users/:id{[0-9]+}', async (c) => {
    const db = getDb(c.env);
    const user = await loadTargetUser(db, Number(c.req.param('id')));
    return c.json({ user: presentUser(c.env, user) });
  })

  .patch('/users/:id{[0-9]+}', zValidator('json', patchUserBody), async (c) => {
    const id = Number(c.req.param('id'));
    const { timezone } = c.req.valid('json');
    if (timezone !== undefined && !isValidTimeZone(timezone)) {
      return c.json({ error: 'invalid_timezone' }, 400);
    }

    const db = getDb(c.env);
    const existing = await loadTargetUser(db, id);

    const patch: Partial<typeof users.$inferInsert> = {};
    if (timezone !== undefined && timezone !== existing.timezone) {
      patch.timezone = timezone;
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ user: presentUser(c.env, existing) });
    }

    const updated = (await db.update(users).set(patch).where(eq(users.id, id)).returning())[0];
    if (!updated) throw new HTTPException(500, { message: 'update_failed' });

    await writeAudit(db, 'admin_user_timezone_change', {
      admin_user_id: c.get('userId'),
      target_user_id: id,
      change: { from: existing.timezone, to: updated.timezone },
    });
    return c.json({ user: presentUser(c.env, updated) });
  })

  // ---- reminders for a specific user ----------------------------------------

  .get('/users/:id{[0-9]+}/reminders', async (c) => {
    const id = Number(c.req.param('id'));
    const db = getDb(c.env);
    await loadTargetUser(db, id); // 404 if user missing

    const rows = await db
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, id), ne(reminders.status, 'deleted')))
      .orderBy(desc(reminders.createdAt));
    return c.json({ reminders: rows.map(presentReminder) });
  })

  .post(
    '/users/:id{[0-9]+}/reminders/preview',
    zValidator('json', previewReminderBody),
    async (c) => {
      const id = Number(c.req.param('id'));
      const db = getDb(c.env);
      const target = await loadTargetUser(db, id);

      const input = c.req.valid('json');
      try {
        validateInputs({ rrule: input.rrule, dtstart: input.dtstart, timezone: input.timezone });
      } catch (e) {
        return c.json(validationErrorResponse(e), 400);
      }
      const fires = nextFires(
        { rrule: input.rrule, dtstart: input.dtstart, timezone: input.timezone },
        input.count,
      );
      const firstFire = fires[0];
      const sample = firstFire
        ? renderReminder({
            title: input.title || '(untitled reminder)',
            bodyMd: input.bodyMd,
            timezone: input.timezone,
            fireAtUtc: firstFire,
            occurrenceNumber: 1,
            remainingCount: null,
            nextFireUtc: fires[1] ?? null,
            dtstartWall: input.dtstart,
            userEmail: target.email,
          })
        : null;
      return c.json({ fires, summary: summarize(input.rrule), sample });
    },
  )

  .post('/users/:id{[0-9]+}/reminders', zValidator('json', createReminderBody), async (c) => {
    const id = Number(c.req.param('id'));
    const db = getDb(c.env);
    const target = await loadTargetUser(db, id);

    const input = c.req.valid('json');
    const tz = input.timezone ?? target.timezone;
    try {
      validateInputs({ rrule: input.rrule, dtstart: input.dtstart, timezone: tz });
    } catch (e) {
      return c.json(validationErrorResponse(e), 400);
    }
    const remaining = input.ends.kind === 'after_count' ? (input.ends.afterCount ?? null) : null;
    const nextFire = computeInitialFire(input.rrule, input.dtstart, tz);

    const inserted = (
      await db
        .insert(reminders)
        .values({
          userId: target.id,
          title: input.title,
          bodyMd: input.bodyMd,
          rrule: input.rrule,
          dtstart: input.dtstart,
          timezone: tz,
          nextFireAt: nextFire,
          remainingCount: remaining,
          status: 'active',
        })
        .returning()
    )[0];
    if (!inserted) throw new HTTPException(500, { message: 'insert_failed' });

    await writeAudit(db, 'admin_reminder_create', {
      admin_user_id: c.get('userId'),
      target_user_id: target.id,
      reminder_id: inserted.id,
      change: { title: inserted.title, rrule: inserted.rrule, timezone: inserted.timezone },
    });
    return c.json({ reminder: presentReminder(inserted) }, 201);
  })

  .get('/users/:id{[0-9]+}/reminders/:rid{[0-9]+}', async (c) => {
    const id = Number(c.req.param('id'));
    const rid = Number(c.req.param('rid'));
    const db = getDb(c.env);
    await loadTargetUser(db, id);

    const row = (
      await db
        .select()
        .from(reminders)
        .where(and(eq(reminders.id, rid), eq(reminders.userId, id)))
        .limit(1)
    )[0];
    if (!row || row.status === 'deleted') {
      throw new HTTPException(404, { message: 'not_found' });
    }
    return c.json({ reminder: presentReminder(row) });
  })

  .patch(
    '/users/:id{[0-9]+}/reminders/:rid{[0-9]+}',
    zValidator('json', patchReminderBody),
    async (c) => {
      const id = Number(c.req.param('id'));
      const rid = Number(c.req.param('rid'));
      const db = getDb(c.env);
      await loadTargetUser(db, id);

      const input = c.req.valid('json');
      const existing = (
        await db
          .select()
          .from(reminders)
          .where(and(eq(reminders.id, rid), eq(reminders.userId, id)))
          .limit(1)
      )[0];
      if (!existing || existing.status === 'deleted') {
        throw new HTTPException(404, { message: 'not_found' });
      }

      const newRrule = input.rrule ?? existing.rrule;
      const newDtstart = input.dtstart ?? existing.dtstart;
      const newTz = input.timezone ?? existing.timezone;
      const scheduleChanged =
        input.rrule !== undefined || input.dtstart !== undefined || input.timezone !== undefined;
      if (scheduleChanged) {
        try {
          validateInputs({ rrule: newRrule, dtstart: newDtstart, timezone: newTz });
        } catch (e) {
          if (e instanceof RecurrenceValidationError) {
            return c.json({ error: e.code, message: e.message }, 400);
          }
          throw e;
        }
      }

      const patch: Partial<typeof reminders.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };
      if (input.title !== undefined) patch.title = input.title;
      if (input.bodyMd !== undefined) patch.bodyMd = input.bodyMd;
      if (input.rrule !== undefined) patch.rrule = input.rrule;
      if (input.dtstart !== undefined) patch.dtstart = input.dtstart;
      if (input.timezone !== undefined) patch.timezone = input.timezone;
      if (input.ends !== undefined) {
        patch.remainingCount =
          input.ends.kind === 'after_count' ? (input.ends.afterCount ?? null) : null;
      }
      if (input.status !== undefined) patch.status = input.status;
      if (scheduleChanged) {
        patch.nextFireAt = computeInitialFire(newRrule, newDtstart, newTz);
      } else if (
        input.status === 'active' &&
        (existing.status === 'paused' || existing.status === 'suspended')
      ) {
        const future = computeNextFireAfter(newRrule, newDtstart, newTz, new Date().toISOString());
        patch.nextFireAt = future;
        if (future === null) patch.status = 'completed';
      }

      const updated = (
        await db
          .update(reminders)
          .set(patch)
          .where(and(eq(reminders.id, rid), eq(reminders.userId, id)))
          .returning()
      )[0];
      if (!updated) throw new HTTPException(500, { message: 'update_failed' });

      await writeAudit(db, 'admin_reminder_update', {
        admin_user_id: c.get('userId'),
        target_user_id: id,
        reminder_id: updated.id,
        change: input,
      });
      return c.json({ reminder: presentReminder(updated) });
    },
  )

  .delete('/users/:id{[0-9]+}/reminders/:rid{[0-9]+}', async (c) => {
    const id = Number(c.req.param('id'));
    const rid = Number(c.req.param('rid'));
    const db = getDb(c.env);
    await loadTargetUser(db, id);

    const updated = await db
      .update(reminders)
      .set({ status: 'deleted', updatedAt: new Date().toISOString() })
      .where(and(eq(reminders.id, rid), eq(reminders.userId, id)))
      .returning();
    if (updated.length === 0) {
      throw new HTTPException(404, { message: 'not_found' });
    }
    await writeAudit(db, 'admin_reminder_delete', {
      admin_user_id: c.get('userId'),
      target_user_id: id,
      reminder_id: rid,
    });
    return c.body(null, 204);
  });
