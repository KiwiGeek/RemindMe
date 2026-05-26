import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '~/db/client';
import { users } from '~/db/schema';
import type { AppBindings } from '~/env';
import { hashOtp, randomNumericCode } from '~/lib/crypto';
import { renderOtpEmail } from '~/lib/emails/otp';
import { MailgunClient } from '~/lib/mailgun';
import { rateLimit } from '~/lib/ratelimit';
import { clearSessionCookie, signSession, writeSessionCookie } from '~/lib/session';

const OTP_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;

/** Sliding-ish window: 5 codes per email per hour, 20 per IP per hour. */
const REQUEST_RATE_PER_EMAIL = { max: 5, windowSeconds: 3600 };
const REQUEST_RATE_PER_IP = { max: 20, windowSeconds: 3600 };

const emailSchema = z.string().trim().toLowerCase().min(3).max(254).email();

const requestBody = z.object({ email: emailSchema });
const verifyBody = z.object({
  email: emailSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'expected 6 digits'),
});

interface StoredOtp {
  hash: string;
  attempts: number;
  createdAt: number;
}

function otpKey(email: string): string {
  return `otp:${email}`;
}

function clientIp(c: { req: { header: (h: string) => string | undefined } }): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? '0.0.0.0';
}

export const auth = new Hono<AppBindings>()
  .post('/request', zValidator('json', requestBody), async (c) => {
    const { email } = c.req.valid('json');
    const ip = clientIp(c);

    const [ipLimit, emailLimit] = await Promise.all([
      rateLimit(
        c.env.KV,
        `auth:req:ip:${ip}`,
        REQUEST_RATE_PER_IP.max,
        REQUEST_RATE_PER_IP.windowSeconds,
      ),
      rateLimit(
        c.env.KV,
        `auth:req:email:${email}`,
        REQUEST_RATE_PER_EMAIL.max,
        REQUEST_RATE_PER_EMAIL.windowSeconds,
      ),
    ]);

    // Always 204 — never reveal whether the email exists or whether the
    // limit was hit, to thwart enumeration / harassment.
    if (!ipLimit.allowed || !emailLimit.allowed) {
      console.warn('auth.request rate limited', { ip, email });
      return c.body(null, 204);
    }

    const code = randomNumericCode(6);
    const hash = await hashOtp(c.env.OTP_PEPPER, code);
    const stored: StoredOtp = { hash, attempts: 0, createdAt: Math.floor(Date.now() / 1000) };
    await c.env.KV.put(otpKey(email), JSON.stringify(stored), {
      expirationTtl: OTP_TTL_SECONDS,
    });

    const mg = new MailgunClient(c.env);
    try {
      // User-initiated send: pre-clear any prior Mailgun suppression so a
      // previously-bounced address can recover. See PLAN.md §14.
      await mg.clearSuppressions(email);
      const { subject, text, html } = renderOtpEmail({
        appName: c.env.APP_NAME,
        code,
        expiresInMinutes: Math.floor(OTP_TTL_SECONDS / 60),
      });
      await mg.send({
        to: email,
        subject,
        text,
        html,
        tags: ['otp'],
      });
    } catch (err) {
      console.error('auth.request mailgun send failed', err);
      // Still respond 204 — same shape as success — to keep enumeration shut.
    }

    return c.body(null, 204);
  })
  .post('/verify', zValidator('json', verifyBody), async (c) => {
    const { email, code } = c.req.valid('json');

    const raw = await c.env.KV.get(otpKey(email));
    if (!raw) {
      return c.json({ error: 'invalid_or_expired' }, 400);
    }
    const stored = JSON.parse(raw) as StoredOtp;

    if (stored.attempts >= OTP_MAX_ATTEMPTS) {
      await c.env.KV.delete(otpKey(email));
      return c.json({ error: 'too_many_attempts' }, 400);
    }

    const presentedHash = await hashOtp(c.env.OTP_PEPPER, code);
    const ok = presentedHash === stored.hash;

    if (!ok) {
      stored.attempts += 1;
      // Keep the remaining TTL roughly intact — refresh based on age.
      const ttlLeft = Math.max(
        30,
        OTP_TTL_SECONDS - (Math.floor(Date.now() / 1000) - stored.createdAt),
      );
      await c.env.KV.put(otpKey(email), JSON.stringify(stored), {
        expirationTtl: ttlLeft,
      });
      return c.json({ error: 'invalid_or_expired' }, 400);
    }

    await c.env.KV.delete(otpKey(email));

    const db = getDb(c.env);
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    let user = existing[0];
    if (!user) {
      const inserted = await db.insert(users).values({ email }).returning();
      user = inserted[0];
    } else if (user.status === 'suspended') {
      // Bounce-recovery path: user came back, we cleared Mailgun suppression
      // when sending the OTP, the send obviously worked. Reactivate the
      // account but leave their reminders in `suspended` until they opt in
      // per-reminder from the dashboard (handled in M5).
      await db.update(users).set({ status: 'active' }).where(eq(users.id, user.id));
      user = { ...user, status: 'active' };
    }

    if (!user) {
      return c.json({ error: 'internal' }, 500);
    }

    const token = await signSession(c.env.SESSION_SECRET, user.id);
    writeSessionCookie(c, token);

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
  .post('/logout', (c) => {
    clearSessionCookie(c);
    return c.body(null, 204);
  });
