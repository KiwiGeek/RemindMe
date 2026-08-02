import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '~/db/client';
import { users } from '~/db/schema';
import type { AppBindings } from '~/env';
import { otpLoginLinkKvKey, signOtpLoginLink } from '~/lib/actionToken';
import { hashOtp, randomHex, randomNumericCode, timingSafeEqual } from '~/lib/crypto';
import { renderOtpEmail } from '~/lib/emails/otp';
import { createMailTransport } from '~/lib/mail/createTransport';
import { rateLimit } from '~/lib/ratelimit';
import { clearSessionCookie } from '~/lib/session';
import { signInAfterEmailProof } from '~/lib/signIn';
import { getKv } from '~/platform/getKv';
import { presentUser } from '~/routes/me';

const OTP_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;

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

function clientIp(c: {
  req: { header: (h: string) => string | undefined };
  env: AppBindings['Bindings'];
}): string {
  const trust = c.env.TRUST_PROXY === '1' || c.env.TRUST_PROXY === 'true';
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf;
  if (trust) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0]?.trim() || '0.0.0.0';
  }
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
}

export const auth = new Hono<AppBindings>()
  .post('/request', zValidator('json', requestBody), async (c) => {
    const config = c.get('config');
    if (!config) return c.json({ error: 'setup_required' }, 503);

    const { email } = c.req.valid('json');
    const ip = clientIp(c);
    const kv = getKv(c.env);
    const db = getDb(c.env);

    const [ipLimit, emailLimit] = await Promise.all([
      rateLimit(
        kv,
        `auth:req:ip:${ip}`,
        REQUEST_RATE_PER_IP.max,
        REQUEST_RATE_PER_IP.windowSeconds,
      ),
      rateLimit(
        kv,
        `auth:req:email:${email}`,
        REQUEST_RATE_PER_EMAIL.max,
        REQUEST_RATE_PER_EMAIL.windowSeconds,
      ),
    ]);

    if (!ipLimit.allowed || !emailLimit.allowed) {
      console.warn('auth.request rate limited', { ip, email });
      return c.body(null, 204);
    }

    // Closed registration: only existing users may request OTP.
    if (config.registrationMode === 'closed') {
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (!existing[0]) {
        return c.body(null, 204);
      }
    }

    const code = randomNumericCode(6);
    const hash = await hashOtp(config.otpPepper, code);
    const stored: StoredOtp = { hash, attempts: 0, createdAt: Math.floor(Date.now() / 1000) };
    await kv.put(otpKey(email), JSON.stringify(stored), {
      expirationTtl: OTP_TTL_SECONDS,
    });

    const mail = await createMailTransport(config, c.env);

    try {
      await mail.clearSuppressions(email);
    } catch (err) {
      console.warn('auth.request: clearSuppressions failed; proceeding to send', err);
    }

    try {
      const jti = randomHex(16);
      const loginToken = await signOtpLoginLink(config.actionTokenSecret, email, jti, {
        ttlSec: OTP_TTL_SECONDS,
      });
      await kv.put(otpLoginLinkKvKey(jti), email, {
        expirationTtl: OTP_TTL_SECONDS,
      });

      const signInUrl = new URL(`/r/${loginToken}`, config.siteOrigin).href;
      const { subject, text, html } = renderOtpEmail({
        appName: config.appName,
        code,
        expiresInMinutes: Math.floor(OTP_TTL_SECONDS / 60),
        signInUrl,
      });
      await mail.send({
        to: email,
        subject,
        text,
        html,
        tags: ['otp'],
      });
    } catch (err) {
      console.error('auth.request: mail send failed', err);
    }

    return c.body(null, 204);
  })
  .post('/verify', zValidator('json', verifyBody), async (c) => {
    const config = c.get('config');
    if (!config) return c.json({ error: 'setup_required' }, 503);

    const { email, code } = c.req.valid('json');
    const kv = getKv(c.env);

    const raw = await kv.get(otpKey(email));
    if (!raw) {
      return c.json({ error: 'invalid_or_expired' }, 400);
    }
    const stored = JSON.parse(raw) as StoredOtp;

    if (stored.attempts >= OTP_MAX_ATTEMPTS) {
      await kv.delete(otpKey(email));
      return c.json({ error: 'too_many_attempts' }, 400);
    }

    const presentedHash = await hashOtp(config.otpPepper, code);
    const ok = timingSafeEqual(presentedHash, stored.hash);

    if (!ok) {
      stored.attempts += 1;
      const ttlLeft = Math.max(
        30,
        OTP_TTL_SECONDS - (Math.floor(Date.now() / 1000) - stored.createdAt),
      );
      await kv.put(otpKey(email), JSON.stringify(stored), {
        expirationTtl: ttlLeft,
      });
      return c.json({ error: 'invalid_or_expired' }, 400);
    }

    await kv.delete(otpKey(email));

    const user = await signInAfterEmailProof(c.env, c, email, {
      sessionSecret: config.sessionSecret,
      registrationMode: config.registrationMode,
    });
    if (user === 'registration_closed') {
      return c.json({ error: 'registration_closed' }, 403);
    }
    if (!user) {
      return c.json({ error: 'internal' }, 500);
    }

    return c.json({ user: presentUser(user) });
  })
  .post('/logout', (c) => {
    clearSessionCookie(c);
    return c.body(null, 204);
  });
