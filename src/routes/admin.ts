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

const patchSettingsBody = z.object({
  appName: z.string().trim().min(1).max(100).optional(),
  siteOrigin: z.string().url().optional(),
  mailProvider: z.enum(['mailgun', 'smtp']).optional(),
  mailgunRegion: z.enum(['us', 'eu']).optional(),
  mailgunDomain: z.string().trim().optional(),
  mailgunFrom: z.string().trim().min(1).optional(),
  mailgunReplyTo: z.string().trim().min(1).optional(),
  mailgunApiKey: z.string().optional(),
  mailgunSigningKey: z.string().optional(),
  smtpHost: z.string().trim().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  registrationMode: z.enum(['open', 'closed']).optional(),
});

const testEmailBody = z.object({
  to: z.string().email().optional(),
});

const promoteAdminBody = z.object({
  isAdmin: z.boolean(),
});

const exportBody = z.object({
  /** Empty / omitted → plain JSON export; otherwise passphrase-wrapped. */
  passphrase: z.string().optional(),
});

const importAdminBody = z.object({
  passphrase: z.string().optional(),
  bundle: z.unknown(),
  confirm: z.literal(true),
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
    return c.json({ users: rows.map((u) => presentUser(u)) });
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
      return c.json({ error: 'user_exists', user: presentUser(existing) }, 409);
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

    return c.json({ user: presentUser(created) }, 201);
  })

  .get('/users/:id{[0-9]+}', async (c) => {
    const db = getDb(c.env);
    const user = await loadTargetUser(db, Number(c.req.param('id')));
    return c.json({ user: presentUser(user) });
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
      return c.json({ user: presentUser(existing) });
    }

    const updated = (await db.update(users).set(patch).where(eq(users.id, id)).returning())[0];
    if (!updated) throw new HTTPException(500, { message: 'update_failed' });

    await writeAudit(db, 'admin_user_timezone_change', {
      admin_user_id: c.get('userId'),
      target_user_id: id,
      change: { from: existing.timezone, to: updated.timezone },
    });
    return c.json({ user: presentUser(updated) });
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
  })

  .get('/settings', async (c) => {
    const config = c.get('config');
    if (!config) return c.json({ error: 'setup_required' }, 503);
    const { toPublicConfig, smtpAllowed } = await import('~/lib/config');
    return c.json({ settings: toPublicConfig(config), smtpAllowed: smtpAllowed(c.env) }, 200, {
      'Cache-Control': 'no-store',
    });
  })

  .patch('/settings', zValidator('json', patchSettingsBody), async (c) => {
    const config = c.get('config');
    if (!config) return c.json({ error: 'setup_required' }, 503);
    const body = c.req.valid('json');
    const db = getDb(c.env);
    const { writeSettings, loadConfig, toPublicConfig, smtpAllowed, invalidateConfigCache } =
      await import('~/lib/config');
    const { validateMailSettings } = await import('~/lib/mail/validate');

    const nextMail = {
      mailProvider: body.mailProvider ?? config.mailProvider,
      mailgunRegion: body.mailgunRegion ?? config.mailgunRegion,
      mailgunDomain: body.mailgunDomain ?? config.mailgunDomain,
      mailgunFrom: body.mailgunFrom ?? config.mailgunFrom,
      mailgunReplyTo: body.mailgunReplyTo ?? config.mailgunReplyTo,
      mailgunApiKey: body.mailgunApiKey ?? config.mailgunApiKey,
      mailgunSigningKey: body.mailgunSigningKey ?? config.mailgunSigningKey,
      smtpHost: body.smtpHost ?? config.smtpHost,
      smtpPort: body.smtpPort ?? config.smtpPort,
      smtpSecure: body.smtpSecure ?? config.smtpSecure,
      smtpUser: body.smtpUser ?? config.smtpUser,
      smtpPass: body.smtpPass ?? config.smtpPass,
    };
    const mailErr = validateMailSettings(c.env, nextMail);
    if (mailErr) return c.json({ error: mailErr }, 400);

    await writeSettings(db, c.env.INSTANCE_SECRET, {
      appName: body.appName ?? config.appName,
      siteOrigin: (body.siteOrigin ?? config.siteOrigin).replace(/\/$/, ''),
      ...nextMail,
      sessionSecret: config.sessionSecret,
      otpPepper: config.otpPepper,
      actionTokenSecret: config.actionTokenSecret,
      registrationMode: body.registrationMode ?? config.registrationMode,
      setupCompletedAt: config.setupCompletedAt,
    });

    invalidateConfigCache();
    const next = await loadConfig(db, c.env.INSTANCE_SECRET);
    c.set('config', next);
    await writeAudit(db, 'admin_settings_update', {
      admin_user_id: c.get('userId'),
      change: { keys: Object.keys(body) },
    });
    if (!next) return c.json({ error: 'internal' }, 500);
    return c.json({ settings: toPublicConfig(next), smtpAllowed: smtpAllowed(c.env) }, 200, {
      'Cache-Control': 'no-store',
    });
  })

  .post('/settings/test-email', zValidator('json', testEmailBody), async (c) => {
    const config = c.get('config');
    if (!config) return c.json({ error: 'setup_required' }, 503);
    const { to } = c.req.valid('json');
    const db = getDb(c.env);
    const adminUser = (
      await db
        .select()
        .from(users)
        .where(eq(users.id, c.get('userId')))
        .limit(1)
    )[0];
    const dest = to ?? adminUser?.email;
    if (!dest) return c.json({ error: 'no_recipient' }, 400);

    const { createMailTransport } = await import('~/lib/mail/createTransport');
    const { MailTransportError } = await import('~/lib/mail/transport');
    const mail = await createMailTransport(config, c.env);
    try {
      await mail.send({
        to: dest,
        subject: `[${config.appName}] Test email`,
        text: `This is a test message from ${config.appName}. If you received it, mail is configured correctly.`,
        html: `<p>This is a test message from <strong>${config.appName}</strong>. If you received it, mail is configured correctly.</p>`,
        tags: ['test'],
      });
      await writeAudit(db, 'admin_test_email', {
        admin_user_id: c.get('userId'),
        to: dest,
      });
      return c.json({ ok: true, to: dest });
    } catch (err) {
      const message =
        err instanceof MailTransportError
          ? `${err.message}: ${err.body.slice(0, 300)}`
          : String(err);
      return c.json({ error: 'send_failed', detail: message }, 502);
    }
  })

  .patch('/users/:id{[0-9]+}/admin', zValidator('json', promoteAdminBody), async (c) => {
    const id = Number(c.req.param('id'));
    const { isAdmin } = c.req.valid('json');
    const db = getDb(c.env);
    const target = await loadTargetUser(db, id);
    if (target.id === c.get('userId') && !isAdmin) {
      return c.json({ error: 'cannot_demote_self' }, 400);
    }
    const updated = (
      await db
        .update(users)
        .set({ isAdmin: isAdmin ? 1 : 0 })
        .where(eq(users.id, id))
        .returning()
    )[0];
    if (!updated) throw new HTTPException(500, { message: 'update_failed' });
    await writeAudit(db, 'admin_user_promote', {
      admin_user_id: c.get('userId'),
      target_user_id: id,
      change: { isAdmin },
    });
    return c.json({ user: presentUser(updated) });
  })

  .post('/export', zValidator('json', exportBody), async (c) => {
    const config = c.get('config');
    if (!config) return c.json({ error: 'setup_required' }, 503);
    const { passphrase } = c.req.valid('json');
    const db = getDb(c.env);
    const { exportInstanceBundle } = await import('~/lib/transfer');
    const pass = passphrase?.trim() ?? '';
    if (pass.length > 0 && pass.length < 8) {
      return c.json({ error: 'passphrase_too_short' }, 400);
    }
    const bundle = await exportInstanceBundle(
      db,
      c.env.INSTANCE_SECRET,
      config,
      pass.length > 0 ? pass : null,
    );
    await writeAudit(db, 'admin_export', { admin_user_id: c.get('userId') });
    return c.json({ bundle }, 200, {
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="remindme-export.json"',
    });
  })

  .post('/import', zValidator('json', importAdminBody), async (c) => {
    const { passphrase, bundle, confirm } = c.req.valid('json');
    if (!confirm) return c.json({ error: 'confirm_required' }, 400);
    const db = getDb(c.env);
    const { importInstanceBundle } = await import('~/lib/transfer');
    try {
      await importInstanceBundle(db, c.env.INSTANCE_SECRET, bundle, passphrase, {
        smtpAllowed: (await import('~/lib/config')).smtpAllowed(c.env),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'passphrase_required') {
        return c.json({ error: 'passphrase_required' }, 400);
      }
      if (msg === 'smtp_not_supported') {
        return c.json({ error: 'smtp_not_supported' }, 400);
      }
      console.error('admin import failed', err);
      return c.json({ error: 'import_failed' }, 400);
    }
    const { loadConfig } = await import('~/lib/config');
    const next = await loadConfig(db, c.env.INSTANCE_SECRET);
    c.set('config', next);
    await writeAudit(db, 'admin_import', { admin_user_id: c.get('userId') });
    return c.json({ ok: true });
  });
