import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getDb } from '~/db/client';
import { type Reminder, reminders, users } from '~/db/schema';
import type { AppBindings } from '~/env';
import { requireAuth } from '~/lib/auth';
import { RecurrenceValidationError, nextFires, summarize, validateInputs } from '~/lib/recurrence';
import { TEMPLATE_VARIABLES, renderReminder } from '~/lib/render';

const PREVIEW_FIRES = 5;
const MAX_TITLE_LEN = 200;
const MAX_BODY_LEN = 8000;

const wallIsoSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'expected ISO local datetime');

const timezoneSchema = z.string().min(1).max(64);

const endsSchema = z
  .object({
    kind: z.enum(['never', 'after_count']).default('never'),
    afterCount: z.number().int().positive().max(10_000).optional(),
  })
  .default({ kind: 'never' });

export const createReminderBody = z.object({
  title: z.string().min(1).max(MAX_TITLE_LEN),
  bodyMd: z.string().max(MAX_BODY_LEN).default(''),
  rrule: z.string().min(3).max(1000),
  dtstart: wallIsoSchema,
  timezone: timezoneSchema.optional(),
  ends: endsSchema,
});

export const patchReminderBody = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LEN).optional(),
    bodyMd: z.string().max(MAX_BODY_LEN).optional(),
    rrule: z.string().min(3).max(1000).optional(),
    dtstart: wallIsoSchema.optional(),
    timezone: timezoneSchema.optional(),
    ends: endsSchema.optional(),
    status: z.enum(['active', 'paused', 'completed']).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.bodyMd !== undefined ||
      v.rrule !== undefined ||
      v.dtstart !== undefined ||
      v.timezone !== undefined ||
      v.ends !== undefined ||
      v.status !== undefined,
    { message: 'no_changes' },
  );

export const previewReminderBody = z.object({
  title: z.string().max(MAX_TITLE_LEN).default(''),
  bodyMd: z.string().max(MAX_BODY_LEN).default(''),
  rrule: z.string().min(3).max(1000),
  dtstart: wallIsoSchema,
  timezone: timezoneSchema,
  count: z.number().int().positive().max(20).default(PREVIEW_FIRES),
});

export function computeInitialFire(rrule: string, dtstart: string, tz: string): string | null {
  try {
    const fires = nextFires({ rrule, dtstart, timezone: tz }, 1);
    return fires[0] ?? null;
  } catch {
    return null;
  }
}

export function presentReminder(r: Reminder) {
  return {
    id: r.id,
    title: r.title,
    bodyMd: r.bodyMd,
    rrule: r.rrule,
    summary: summarize(r.rrule),
    dtstart: r.dtstart,
    timezone: r.timezone,
    nextFireAt: r.nextFireAt,
    remainingCount: r.remainingCount,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function validationErrorResponse(e: unknown) {
  if (e instanceof RecurrenceValidationError) {
    return { error: e.code, message: e.message };
  }
  return { error: 'invalid', message: e instanceof Error ? e.message : 'invalid' };
}

export const remindersRoute = new Hono<AppBindings>()
  .use('*', requireAuth)

  .get('/', async (c) => {
    const db = getDb(c.env);
    const userId = c.get('userId');
    const rows = await db
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), ne(reminders.status, 'deleted')))
      .orderBy(desc(reminders.createdAt));
    return c.json({ reminders: rows.map(presentReminder) });
  })

  .get('/template-variables', (c) => c.json({ variables: TEMPLATE_VARIABLES }))

  .post('/preview', zValidator('json', previewReminderBody), async (c) => {
    const input = c.req.valid('json');
    try {
      validateInputs({
        rrule: input.rrule,
        dtstart: input.dtstart,
        timezone: input.timezone,
      });
    } catch (e) {
      return c.json(validationErrorResponse(e), 400);
    }
    const fires = nextFires(
      { rrule: input.rrule, dtstart: input.dtstart, timezone: input.timezone },
      input.count,
    );

    const db = getDb(c.env);
    const userRow = (
      await db
        .select()
        .from(users)
        .where(eq(users.id, c.get('userId')))
        .limit(1)
    )[0];
    if (!userRow) throw new HTTPException(401, { message: 'unauthorized' });

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
          userEmail: userRow.email,
        })
      : null;

    return c.json({
      fires,
      summary: summarize(input.rrule),
      sample,
    });
  })

  .post('/', zValidator('json', createReminderBody), async (c) => {
    const input = c.req.valid('json');
    const db = getDb(c.env);
    const userId = c.get('userId');
    const userRow = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!userRow) throw new HTTPException(401, { message: 'unauthorized' });

    const tz = input.timezone ?? userRow.timezone;
    try {
      validateInputs({ rrule: input.rrule, dtstart: input.dtstart, timezone: tz });
    } catch (e) {
      return c.json(validationErrorResponse(e), 400);
    }

    const remaining = input.ends.kind === 'after_count' ? (input.ends.afterCount ?? null) : null;
    const nextFire = computeInitialFire(input.rrule, input.dtstart, tz);

    const inserted = await db
      .insert(reminders)
      .values({
        userId,
        title: input.title,
        bodyMd: input.bodyMd,
        rrule: input.rrule,
        dtstart: input.dtstart,
        timezone: tz,
        nextFireAt: nextFire,
        remainingCount: remaining,
        status: 'active',
      })
      .returning();

    const created = inserted[0];
    if (!created) throw new HTTPException(500, { message: 'insert_failed' });
    return c.json({ reminder: presentReminder(created) }, 201);
  })

  .get('/:id{[0-9]+}', async (c) => {
    const id = Number(c.req.param('id'));
    const db = getDb(c.env);
    const userId = c.get('userId');
    const row = (
      await db
        .select()
        .from(reminders)
        .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
        .limit(1)
    )[0];
    if (!row || row.status === 'deleted') {
      throw new HTTPException(404, { message: 'not_found' });
    }
    return c.json({ reminder: presentReminder(row) });
  })

  .patch('/:id{[0-9]+}', zValidator('json', patchReminderBody), async (c) => {
    const id = Number(c.req.param('id'));
    const input = c.req.valid('json');
    const db = getDb(c.env);
    const userId = c.get('userId');

    const existing = (
      await db
        .select()
        .from(reminders)
        .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
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
        return c.json(validationErrorResponse(e), 400);
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
    }

    const updated = await db
      .update(reminders)
      .set(patch)
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
      .returning();
    const next = updated[0];
    if (!next) throw new HTTPException(500, { message: 'update_failed' });
    return c.json({ reminder: presentReminder(next) });
  })

  .delete('/:id{[0-9]+}', async (c) => {
    const id = Number(c.req.param('id'));
    const db = getDb(c.env);
    const userId = c.get('userId');
    const updated = await db
      .update(reminders)
      .set({ status: 'deleted', updatedAt: new Date().toISOString() })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
      .returning();
    if (updated.length === 0) {
      throw new HTTPException(404, { message: 'not_found' });
    }
    return c.body(null, 204);
  });
