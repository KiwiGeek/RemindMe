import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '~/env';
import { otpLoginLinkKvKey, signOtpLoginLink } from '~/lib/actionToken';
import { hashOtp, randomHex, randomNumericCode } from '~/lib/crypto';
import { renderOtpEmail } from '~/lib/emails/otp';
import { MailgunClient } from '~/lib/mailgun';
import { rateLimit } from '~/lib/ratelimit';
import { clearSessionCookie } from '~/lib/session';
import { signInAfterEmailProof } from '~/lib/signIn';
import { presentUser } from '~/routes/me';

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

    // User-initiated send: pre-clear any prior Mailgun suppression so a
    // previously-bounced address can recover. This is a *best-effort* step —
    // if it fails (wrong API scope, transient network, etc.) we still want
    // to attempt the actual OTP send below for the 99% case where the
    // address isn't suppressed.
    try {
      await mg.clearSuppressions(email);
    } catch (err) {
      console.warn('auth.request: clearSuppressions failed; proceeding to send', err);
    }

    try {
      const jti = randomHex(16);
      const loginToken = await signOtpLoginLink(c.env.ACTION_TOKEN_SECRET, email, jti, {
        ttlSec: OTP_TTL_SECONDS,
      });
      await c.env.KV.put(otpLoginLinkKvKey(jti), email, {
        expirationTtl: OTP_TTL_SECONDS,
      });

      const signInUrl = new URL(`/r/${loginToken}`, c.env.SITE_ORIGIN).href;
      const { subject, text, html } = renderOtpEmail({
        appName: c.env.APP_NAME,
        code,
        expiresInMinutes: Math.floor(OTP_TTL_SECONDS / 60),
        signInUrl,
      });
      await mg.send({
        to: email,
        subject,
        text,
        html,
        tags: ['otp'],
      });
    } catch (err) {
      console.error('auth.request: mailgun send failed', err);
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

    const user = await signInAfterEmailProof(c.env, c, email);
    if (!user) {
      return c.json({ error: 'internal' }, 500);
    }

    return c.json({ user: presentUser(c.env, user) });
  })
  .post('/logout', (c) => {
    clearSessionCookie(c);
    return c.body(null, 204);
  });
