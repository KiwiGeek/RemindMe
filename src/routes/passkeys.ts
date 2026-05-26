/**
 * Passkey routes — registration and authentication ceremonies plus
 * management (list, rename, delete) of a user's stored credentials.
 *
 *   POST /api/passkeys/register/options    (auth)   — generate + persist challenge
 *   POST /api/passkeys/register/verify     (auth)   — verify attestation + store
 *   GET  /api/passkeys                      (auth)   — list signed-in user's passkeys
 *   PATCH/DELETE /api/passkeys/:id         (auth)   — rename / remove
 *   POST /api/passkeys/auth/options                  — generate auth options (public)
 *   POST /api/passkeys/auth/verify                   — verify, set session (public)
 *
 * Authentication uses **discoverable credentials**: we never ask for an
 * email, the browser picks a passkey, the server looks the user up via the
 * credential_id. That's the standard "passkey autofill" UX and means we
 * don't leak email→credential mappings.
 */

import { zValidator } from '@hono/zod-validator';
import {
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getDb } from '~/db/client';
import { passkeys, users } from '~/db/schema';
import type { AppBindings } from '~/env';
import { requireAuth } from '~/lib/auth';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  consumeAuthenticationChallenge,
  consumeRegistrationChallenge,
  getRpInfo,
  parseTransports,
  saveAuthenticationChallenge,
  saveRegistrationChallenge,
  serializeTransports,
} from '~/lib/passkeys';
import { rateLimit } from '~/lib/ratelimit';
import { signSession, writeSessionCookie } from '~/lib/session';
import { presentUser } from '~/routes/me';

function clientIp(c: { req: { header: (h: string) => string | undefined } }): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? '0.0.0.0';
}

const MAX_NICKNAME_LEN = 64;
const MAX_PASSKEYS_PER_USER = 10;

const registerOptionsBody = z
  .object({
    /** Optional friendly label captured up front; can also be set later via PATCH. */
    nickname: z.string().trim().max(MAX_NICKNAME_LEN).optional(),
  })
  .optional();

const registerVerifyBody = z.object({
  /** The full registration response from `startRegistration()` on the client. */
  response: z.any(),
  nickname: z.string().trim().max(MAX_NICKNAME_LEN).optional(),
});

const authOptionsBody = z.object({}).optional();

const authVerifyBody = z.object({
  response: z.any(),
});

const patchBody = z
  .object({
    nickname: z.string().trim().max(MAX_NICKNAME_LEN).optional(),
  })
  .refine((v) => v.nickname !== undefined, { message: 'no_changes' });

function presentPasskey(p: typeof passkeys.$inferSelect) {
  return {
    id: p.id,
    nickname: p.nickname,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    transports: parseTransports(p.transports),
  };
}

export const passkeysRoute = new Hono<AppBindings>()
  // ---- registration (signed-in user adding a passkey) ----------------------

  .post('/register/options', requireAuth, zValidator('json', registerOptionsBody), async (c) => {
    const userId = c.get('userId');
    const db = getDb(c.env);
    const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!user) throw new HTTPException(401, { message: 'unauthorized' });

    // Cap how many passkeys per user — a runaway browser extension could
    // otherwise spam-register hundreds of resident keys.
    const existing = await db
      .select({
        credentialId: passkeys.credentialId,
        transports: passkeys.transports,
      })
      .from(passkeys)
      .where(eq(passkeys.userId, userId));
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      return c.json({ error: 'limit_reached' }, 400);
    }

    const rp = getRpInfo(c);
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      // Use the email so platform authenticators show the right account name.
      userName: user.email,
      userDisplayName: user.email,
      // Static user identifier so the device replaces an old credential for
      // the same user rather than treating it as a separate account.
      userID: new TextEncoder().encode(`u:${user.id}`),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      // Disallow registering the same credential twice.
      excludeCredentials: existing.map((p) => {
        const transports = parseTransports(p.transports) as
          | AuthenticatorTransportFuture[]
          | undefined;
        return transports ? { id: p.credentialId, transports } : { id: p.credentialId };
      }),
    });

    await saveRegistrationChallenge(c.env, userId, options.challenge);
    return c.json({ options });
  })

  .post('/register/verify', requireAuth, zValidator('json', registerVerifyBody), async (c) => {
    const userId = c.get('userId');
    const { response, nickname } = c.req.valid('json');

    const expectedChallenge = await consumeRegistrationChallenge(c.env, userId);
    if (!expectedChallenge) {
      return c.json({ error: 'challenge_expired' }, 400);
    }

    const rp = getRpInfo(c);
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.expectedOrigin,
        expectedRPID: rp.rpID,
      });
    } catch (err) {
      console.warn('passkey register verify failed', err);
      return c.json({ error: 'verification_failed' }, 400);
    }
    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: 'verification_failed' }, 400);
    }

    const { credential } = verification.registrationInfo;
    const db = getDb(c.env);
    try {
      const inserted = (
        await db
          .insert(passkeys)
          .values({
            userId,
            // `credential.id` is already a base64url string.
            credentialId: credential.id,
            publicKey: bytesToBase64Url(credential.publicKey),
            counter: credential.counter,
            transports: serializeTransports(credential.transports),
            nickname: nickname ?? null,
          })
          .returning()
      )[0];
      if (!inserted) throw new Error('insert_failed');
      return c.json({ passkey: presentPasskey(inserted) }, 201);
    } catch (err) {
      // UNIQUE constraint on credential_id — someone tried to re-register.
      console.warn('passkey insert failed', err);
      return c.json({ error: 'already_registered' }, 409);
    }
  })

  // ---- management ---------------------------------------------------------

  .get('/', requireAuth, async (c) => {
    const userId = c.get('userId');
    const db = getDb(c.env);
    const rows = await db.select().from(passkeys).where(eq(passkeys.userId, userId));
    return c.json({ passkeys: rows.map(presentPasskey) });
  })

  .patch('/:id{[0-9]+}', requireAuth, zValidator('json', patchBody), async (c) => {
    const userId = c.get('userId');
    const id = Number(c.req.param('id'));
    const { nickname } = c.req.valid('json');
    const db = getDb(c.env);
    const updated = await db
      .update(passkeys)
      .set({ nickname: nickname ?? null })
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .returning();
    if (updated.length === 0) throw new HTTPException(404, { message: 'not_found' });
    const row = updated[0];
    if (!row) throw new HTTPException(404, { message: 'not_found' });
    return c.json({ passkey: presentPasskey(row) });
  })

  .delete('/:id{[0-9]+}', requireAuth, async (c) => {
    const userId = c.get('userId');
    const id = Number(c.req.param('id'));
    const db = getDb(c.env);
    const deleted = await db
      .delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .returning();
    if (deleted.length === 0) throw new HTTPException(404, { message: 'not_found' });
    return c.body(null, 204);
  })

  // ---- authentication (public) --------------------------------------------

  .post('/auth/options', zValidator('json', authOptionsBody), async (c) => {
    const ip = clientIp(c);
    // Rate-limit cheap to make, but cheap to spam too. 60/hour/IP is plenty.
    const limited = await rateLimit(c.env.KV, `pk:auth:opts:${ip}`, 60, 3600);
    if (!limited.allowed) return c.json({ error: 'rate_limited' }, 429);

    const rp = getRpInfo(c);
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: 'preferred',
      // Discoverable credentials: do NOT pre-populate allowCredentials. The
      // browser will offer any passkey it knows about for this RP ID.
    });
    await saveAuthenticationChallenge(c.env, options.challenge);
    return c.json({ options });
  })

  .post('/auth/verify', zValidator('json', authVerifyBody), async (c) => {
    const ip = clientIp(c);
    const limited = await rateLimit(c.env.KV, `pk:auth:verify:${ip}`, 30, 3600);
    if (!limited.allowed) return c.json({ error: 'rate_limited' }, 429);

    const { response } = c.req.valid('json');
    if (!response || typeof response !== 'object') {
      return c.json({ error: 'invalid_response' }, 400);
    }
    // Pull `id` out of the response to look the credential up. Mirrors what
    // @simplewebauthn does internally; doing it here lets us 400 cleanly.
    const credentialIdRaw = (response as { id?: unknown }).id;
    if (typeof credentialIdRaw !== 'string' || credentialIdRaw.length === 0) {
      return c.json({ error: 'invalid_response' }, 400);
    }

    // Get the challenge from `clientDataJSON` to verify we issued it.
    let clientChallenge: string;
    try {
      const responseObj = (response as { response?: { clientDataJSON?: string } }).response;
      if (!responseObj?.clientDataJSON) throw new Error('missing clientDataJSON');
      const dataBytes = base64UrlToBytes(responseObj.clientDataJSON);
      const dataText = new TextDecoder().decode(dataBytes);
      const parsed = JSON.parse(dataText) as { challenge?: string };
      if (typeof parsed.challenge !== 'string') throw new Error('missing challenge');
      clientChallenge = parsed.challenge;
    } catch (err) {
      console.warn('passkey auth verify: failed to parse clientDataJSON', err);
      return c.json({ error: 'invalid_response' }, 400);
    }

    const issued = await consumeAuthenticationChallenge(c.env, clientChallenge);
    if (!issued) {
      return c.json({ error: 'challenge_expired' }, 400);
    }

    const db = getDb(c.env);
    const cred = (
      await db.select().from(passkeys).where(eq(passkeys.credentialId, credentialIdRaw)).limit(1)
    )[0];
    if (!cred) return c.json({ error: 'unknown_credential' }, 400);

    const user = (await db.select().from(users).where(eq(users.id, cred.userId)).limit(1))[0];
    if (!user) return c.json({ error: 'unknown_credential' }, 400);
    if (user.status === 'suspended') {
      // Same treatment as OTP — don't admit a suspended account.
      return c.json({ error: 'account_suspended' }, 403);
    }

    const rp = getRpInfo(c);
    // Copy the decoded bytes into a fresh `Uint8Array<ArrayBuffer>` so it
    // matches @simplewebauthn's TS signature (Uint8Array<ArrayBufferLike>
    // doesn't satisfy `Uint8Array<ArrayBuffer>` under exactOptionalPropertyTypes).
    const pkBytes = base64UrlToBytes(cred.publicKey);
    const credPublicKey = new Uint8Array(pkBytes.byteLength);
    credPublicKey.set(pkBytes);
    const credTransports = parseTransports(cred.transports) as
      | AuthenticatorTransportFuture[]
      | undefined;

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: clientChallenge,
        expectedOrigin: rp.expectedOrigin,
        expectedRPID: rp.rpID,
        credential: credTransports
          ? {
              id: cred.credentialId,
              publicKey: credPublicKey,
              counter: cred.counter,
              transports: credTransports,
            }
          : {
              id: cred.credentialId,
              publicKey: credPublicKey,
              counter: cred.counter,
            },
        requireUserVerification: false,
      });
    } catch (err) {
      console.warn('passkey auth verify failed', err);
      return c.json({ error: 'verification_failed' }, 400);
    }
    if (!verification.verified) {
      return c.json({ error: 'verification_failed' }, 400);
    }

    // Persist the new counter + last-used; this also reveals counter rollback
    // on the next attempt.
    await db
      .update(passkeys)
      .set({
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date().toISOString(),
      })
      .where(eq(passkeys.id, cred.id));

    const token = await signSession(c.env.SESSION_SECRET, user.id);
    writeSessionCookie(c, token);

    return c.json({ user: presentUser(c.env, user) });
  });
