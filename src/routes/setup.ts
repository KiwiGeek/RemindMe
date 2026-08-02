import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '~/db/client';
import { users } from '~/db/schema';
import type { AppBindings } from '~/env';
import {
  isSetupComplete,
  loadConfig,
  newCryptoSecrets,
  smtpAllowed,
  writeSettings,
} from '~/lib/config';
import { timingSafeEqual } from '~/lib/crypto';
import { validateMailSettings } from '~/lib/mail/validate';
import { rateLimit } from '~/lib/ratelimit';
import { importInstanceBundle } from '~/lib/transfer';
import { isValidTimeZone } from '~/routes/me';

const setupBody = z
  .object({
    setupToken: z.string().min(1),
    adminEmail: z.string().trim().toLowerCase().email(),
    timezone: z.string().min(1).max(64).default('UTC'),
    appName: z.string().trim().min(1).max(100).default('Remind Me'),
    siteOrigin: z.string().url(),
    mailProvider: z.enum(['mailgun', 'smtp']).default('mailgun'),
    mailgunRegion: z.enum(['us', 'eu']).default('us'),
    mailgunDomain: z.string().trim().default(''),
    mailgunFrom: z.string().trim().min(1),
    mailgunReplyTo: z.string().trim().min(1),
    mailgunApiKey: z.string().default(''),
    mailgunSigningKey: z.string().default(''),
    smtpHost: z.string().trim().default(''),
    smtpPort: z.number().int().min(1).max(65535).default(587),
    smtpSecure: z.boolean().default(false),
    smtpUser: z.string().default(''),
    smtpPass: z.string().default(''),
    registrationMode: z.enum(['open', 'closed']).default('open'),
  })
  .superRefine((val, ctx) => {
    if (val.mailProvider === 'mailgun') {
      if (!val.mailgunDomain) {
        ctx.addIssue({
          code: 'custom',
          message: 'mailgun_domain_required',
          path: ['mailgunDomain'],
        });
      }
      if (!val.mailgunApiKey) {
        ctx.addIssue({
          code: 'custom',
          message: 'mailgun_api_key_required',
          path: ['mailgunApiKey'],
        });
      }
      if (!val.mailgunSigningKey) {
        ctx.addIssue({
          code: 'custom',
          message: 'mailgun_signing_key_required',
          path: ['mailgunSigningKey'],
        });
      }
    } else if (!val.smtpHost) {
      ctx.addIssue({ code: 'custom', message: 'smtp_host_required', path: ['smtpHost'] });
    }
  });

const importBody = z.object({
  setupToken: z.string().min(1),
  passphrase: z.string().optional(),
  bundle: z.unknown(),
});

function assertSetupToken(envToken: string | undefined, presented: string): boolean {
  if (!envToken || envToken.length === 0) return false;
  if (envToken.length !== presented.length) {
    // Still compare to keep timing flatter when lengths match often enough.
    timingSafeEqual(envToken, envToken);
    return false;
  }
  return timingSafeEqual(envToken, presented);
}

export const setup = new Hono<AppBindings>()
  .get('/status', async (c) => {
    const db = getDb(c.env);
    const completed = await isSetupComplete(db);
    return c.json({ completed, smtpAllowed: smtpAllowed(c.env) });
  })
  .post('/', zValidator('json', setupBody), async (c) => {
    const db = getDb(c.env);
    if (await isSetupComplete(db)) {
      return c.json({ error: 'setup_already_completed' }, 410);
    }

    const kv = c.get('kv');
    const limited = await rateLimit(kv, 'setup:complete', 10, 3600);
    if (!limited.allowed) {
      return c.json({ error: 'rate_limited' }, 429);
    }

    const body = c.req.valid('json');
    if (!assertSetupToken(c.env.SETUP_TOKEN, body.setupToken)) {
      return c.json({ error: 'invalid_setup_token' }, 403);
    }
    if (!isValidTimeZone(body.timezone)) {
      return c.json({ error: 'invalid_timezone' }, 400);
    }

    const mailErr = validateMailSettings(c.env, {
      mailProvider: body.mailProvider,
      mailgunRegion: body.mailgunRegion,
      mailgunDomain: body.mailgunDomain,
      mailgunFrom: body.mailgunFrom,
      mailgunReplyTo: body.mailgunReplyTo,
      mailgunApiKey: body.mailgunApiKey,
      mailgunSigningKey: body.mailgunSigningKey,
      smtpHost: body.smtpHost,
      smtpPort: body.smtpPort,
      smtpSecure: body.smtpSecure,
      smtpUser: body.smtpUser,
      smtpPass: body.smtpPass,
    });
    if (mailErr) return c.json({ error: mailErr }, 400);

    const cryptoSecrets = newCryptoSecrets();
    const now = new Date().toISOString();
    await writeSettings(db, c.env.INSTANCE_SECRET, {
      appName: body.appName,
      siteOrigin: body.siteOrigin.replace(/\/$/, ''),
      mailProvider: body.mailProvider,
      mailgunRegion: body.mailgunRegion,
      mailgunDomain: body.mailgunDomain,
      mailgunFrom: body.mailgunFrom,
      mailgunReplyTo: body.mailgunReplyTo,
      mailgunApiKey: body.mailgunApiKey,
      mailgunSigningKey: body.mailgunSigningKey,
      smtpHost: body.smtpHost,
      smtpPort: body.smtpPort,
      smtpSecure: body.smtpSecure,
      smtpUser: body.smtpUser,
      smtpPass: body.smtpPass,
      sessionSecret: cryptoSecrets.sessionSecret,
      otpPepper: cryptoSecrets.otpPepper,
      actionTokenSecret: cryptoSecrets.actionTokenSecret,
      registrationMode: body.registrationMode,
      setupCompletedAt: now,
    });

    const existing = await db.select().from(users).where(eq(users.email, body.adminEmail)).limit(1);
    if (existing[0]) {
      await db
        .update(users)
        .set({ isAdmin: 1, timezone: body.timezone, tzConfirmed: 1 })
        .where(eq(users.id, existing[0].id));
    } else {
      await db.insert(users).values({
        email: body.adminEmail,
        timezone: body.timezone,
        tzConfirmed: 1,
        isAdmin: 1,
      });
    }

    const config = await loadConfig(db, c.env.INSTANCE_SECRET);
    c.set('config', config);
    return c.json({ ok: true });
  })
  .post('/import', zValidator('json', importBody), async (c) => {
    const db = getDb(c.env);
    if (await isSetupComplete(db)) {
      return c.json({ error: 'setup_already_completed' }, 410);
    }

    const kv = c.get('kv');
    const limited = await rateLimit(kv, 'setup:import', 5, 3600);
    if (!limited.allowed) {
      return c.json({ error: 'rate_limited' }, 429);
    }

    const body = c.req.valid('json');
    if (!assertSetupToken(c.env.SETUP_TOKEN, body.setupToken)) {
      return c.json({ error: 'invalid_setup_token' }, 403);
    }

    try {
      await importInstanceBundle(db, c.env.INSTANCE_SECRET, body.bundle, body.passphrase, {
        smtpAllowed: smtpAllowed(c.env),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'passphrase_required') {
        return c.json({ error: 'passphrase_required' }, 400);
      }
      if (msg === 'smtp_not_supported') {
        return c.json({ error: 'smtp_not_supported' }, 400);
      }
      console.error('setup import failed', err);
      return c.json({ error: 'import_failed' }, 400);
    }

    const config = await loadConfig(db, c.env.INSTANCE_SECRET);
    c.set('config', config);
    return c.json({ ok: true });
  });
