/**
 * Stateless session cookie:
 *
 *   payload = { uid, iat, exp }      ← integers, seconds since epoch
 *   token   = base64url(JSON(payload)) + '.' + base64url(HMAC(secret, payload))
 *
 * Stored in the `rmd_sid` cookie. No server-side session table — verifying
 * the HMAC plus checking `exp` is enough. Logout = clear the cookie.
 *
 * Rolling expiry: when we read a valid cookie, the middleware rewrites it
 * with a fresh `exp` so active users stay logged in indefinitely.
 */

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  base64UrlDecode,
  base64UrlEncode,
  hmacSign,
  hmacVerify,
  utf8Decoder,
  utf8Encoder,
} from '~/lib/crypto';

export const SESSION_COOKIE = 'rmd_sid';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface SessionPayload {
  uid: number;
  iat: number;
  exp: number;
}

export async function signSession(secret: string, uid: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { uid, iat: now, exp: now + SESSION_TTL_SECONDS };
  const body = base64UrlEncode(utf8Encoder.encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, body);
  return `${body}.${sig}`;
}

export async function verifySession(secret: string, token: string): Promise<SessionPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!(await hmacVerify(secret, body, sig))) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(utf8Decoder.decode(base64UrlDecode(body))) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.uid !== 'number' ||
    typeof payload.exp !== 'number' ||
    payload.exp < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return payload;
}

/** Set the session cookie on the response. */
export function writeSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c), sameSite: 'Lax' });
}

function isHttps(c: Context): boolean {
  // Vite dev proxies http://localhost:5173 → http://localhost:8787 — `Secure`
  // would prevent the cookie from sticking in that flow. Detect the actual
  // request scheme rather than relying on `SITE_ORIGIN`.
  const url = new URL(c.req.url);
  if (url.protocol === 'https:') return true;
  const xfProto = c.req.header('x-forwarded-proto');
  return xfProto === 'https';
}
