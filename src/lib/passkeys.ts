/**
 * WebAuthn / passkey support layer.
 *
 * Two design notes worth knowing up front:
 *
 *   1. **RP ID and expected origin are derived per-request** from the `Origin`
 *      header instead of being baked into env vars. That keeps local
 *      development (`http://localhost:5173`, RP ID `localhost`) and production
 *      (`https://your-domain`, RP ID matching the same host) working from the
 *      same code without a special-case toggle. The browser will
 *      anyway refuse the ceremony unless the page's origin matches the
 *      registered RP ID, so a hostile origin can't trick the server into
 *      issuing a useful credential.
 *
 *   2. **Email OTP is always available.** Passkeys are additive — a user who
 *      deletes their last passkey can still sign in. That's deliberate: it
 *      removes the worst lock-out scenario and means we never need a
 *      recovery-code subsystem.
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppBindings, Env } from '~/env';

/** Where the WebAuthn ceremony is happening, derived from the request. */
export interface RpInfo {
  rpID: string;
  /** Must match the page origin exactly per spec. */
  expectedOrigin: string;
  rpName: string;
}

export function getRpInfo(c: Context<AppBindings>): RpInfo {
  const origin = c.req.header('origin');
  if (!origin) {
    // Only happens for non-browser callers; the WebAuthn JS API always sends Origin.
    throw new HTTPException(400, { message: 'missing_origin' });
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HTTPException(400, { message: 'invalid_origin' });
  }
  // Localhost (any port) is a WebAuthn-blessed exception to the HTTPS rule.
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new HTTPException(400, { message: 'insecure_origin' });
  }
  return {
    rpID: parsed.hostname,
    expectedOrigin: origin,
    rpName: c.env.APP_NAME,
  };
}

// ---- Challenge KV storage --------------------------------------------------
//
// Two key shapes:
//   `pk:reg:{userId}` -> the most recent registration challenge for a user
//   `pk:auth:{challenge}` -> marker entry asserting "we issued this challenge"
//
// Registration is keyed by userId because we already know who the user is.
// Authentication can't use userId (the user hasn't signed in yet), so we key
// by the challenge itself and the lookup amounts to a presence check.

const CHALLENGE_TTL_SECONDS = 5 * 60;

export async function saveRegistrationChallenge(
  env: Env,
  userId: number,
  challenge: string,
): Promise<void> {
  await env.KV.put(`pk:reg:${userId}`, challenge, {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });
}

export async function consumeRegistrationChallenge(
  env: Env,
  userId: number,
): Promise<string | null> {
  const key = `pk:reg:${userId}`;
  const value = await env.KV.get(key);
  if (!value) return null;
  await env.KV.delete(key);
  return value;
}

export async function saveAuthenticationChallenge(env: Env, challenge: string): Promise<void> {
  await env.KV.put(`pk:auth:${challenge}`, '1', {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });
}

export async function consumeAuthenticationChallenge(
  env: Env,
  challenge: string,
): Promise<boolean> {
  const key = `pk:auth:${challenge}`;
  const value = await env.KV.get(key);
  if (!value) return false;
  await env.KV.delete(key);
  return true;
}

// ---- Encoding helpers ------------------------------------------------------

/** Base64url with no padding, like @simplewebauthn does internally. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const base64 = s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat(pad);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @simplewebauthn returns `transports` as either undefined or
 * `AuthenticatorTransportFuture[]`. We persist them as JSON so we can pass
 * them back at authentication time as a hint to the browser.
 */
export function serializeTransports(transports: string[] | undefined): string | null {
  if (!transports || transports.length === 0) return null;
  return JSON.stringify(transports);
}

export function parseTransports(s: string | null): string[] | undefined {
  if (!s) return undefined;
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
