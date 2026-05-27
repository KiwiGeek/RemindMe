/**
 * HMAC-signed, stateless tokens used in outgoing email links.
 *
 * Two kinds, distinguished by a 2-letter prefix that's part of the signed
 * payload to prevent cross-kind confusion:
 *
 *   - `fa.<body>.<sig>`  Fire action — snooze / skip / done / unsub for a
 *                         specific (reminder_id, reminder_fires.id). Burnable
 *                         server-side via `reminder_fires.action_consumed_at`.
 *   - `ml.<body>.<sig>`  Magic-link sign-in — opens a fresh session for a
 *                         user. Used by the "Manage your reminders" footer
 *                         link so recipients don't need to do an OTP loop
 *                         just to unsubscribe.
 *   - `ol.<body>.<sig>`  OTP login link — email-scoped, short TTL, single-use
 *                         via KV. Included in OTP emails alongside the code.
 *
 * Signature is HMAC-SHA256 over the base64url-encoded JSON payload, signed
 * with `ACTION_TOKEN_SECRET`. The prefix is part of the HMAC input so a
 * fire-action token can't be replayed as a magic-link or vice versa.
 *
 * Tokens are pure URL-safe (RFC 4648 §5 base64url, no padding) and contain
 * an `exp` field. Default TTL is 30 days, which matches the plan's window
 * for "can still snooze/manage from old emails".
 */

import { base64UrlDecode, base64UrlEncode, hmacSign, hmacVerify } from '~/lib/crypto';

export const ACTION_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

export const SNOOZE_DURATIONS = ['1h', '3h', '1d', '3d', '1w'] as const;
export type SnoozeDuration = (typeof SNOOZE_DURATIONS)[number];

const SNOOZE_SECONDS: Record<SnoozeDuration, number> = {
  '1h': 60 * 60,
  '3h': 3 * 60 * 60,
  '1d': 24 * 60 * 60,
  '3d': 3 * 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
};

export function snoozeDurationSeconds(d: SnoozeDuration): number {
  return SNOOZE_SECONDS[d];
}

export type FireAction = `snooze:${SnoozeDuration}` | 'skip' | 'done' | 'unsub';

export const FIRE_ACTIONS: readonly FireAction[] = [
  ...SNOOZE_DURATIONS.map((d): FireAction => `snooze:${d}`),
  'skip',
  'done',
  'unsub',
];

export interface FireActionPayload {
  /** kind tag — also enforced via the URL prefix; double check for safety. */
  k: 'fa';
  /** reminder id. */
  rid: number;
  /** reminder_fires.id this action is scoped to. */
  fid: number;
  op: FireAction;
  /** unix epoch seconds. */
  exp: number;
}

export interface MagicLinkPayload {
  k: 'ml';
  /** user id. */
  uid: number;
  exp: number;
}

export interface OtpLoginLinkPayload {
  k: 'ol';
  email: string;
  jti: string;
  exp: number;
}

const FIRE_PREFIX = 'fa';
const MAGIC_PREFIX = 'ml';
const OTP_LINK_PREFIX = 'ol';

export function otpLoginLinkKvKey(jti: string): string {
  return `ol:${jti}`;
}

export async function signFireAction(
  secret: string,
  args: { rid: number; fid: number; op: FireAction },
  opts: { ttlSec?: number; nowSec?: number } = {},
): Promise<string> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const payload: FireActionPayload = {
    k: 'fa',
    rid: args.rid,
    fid: args.fid,
    op: args.op,
    exp: nowSec + (opts.ttlSec ?? ACTION_TOKEN_TTL_SEC),
  };
  return signWithPrefix(secret, FIRE_PREFIX, payload);
}

export async function verifyFireAction(
  secret: string,
  token: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<FireActionPayload | null> {
  return verifyWithPrefix<FireActionPayload>(secret, FIRE_PREFIX, 'fa', token, nowSec);
}

export async function signMagicLink(
  secret: string,
  uid: number,
  opts: { ttlSec?: number; nowSec?: number } = {},
): Promise<string> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const payload: MagicLinkPayload = {
    k: 'ml',
    uid,
    exp: nowSec + (opts.ttlSec ?? ACTION_TOKEN_TTL_SEC),
  };
  return signWithPrefix(secret, MAGIC_PREFIX, payload);
}

export async function verifyMagicLink(
  secret: string,
  token: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<MagicLinkPayload | null> {
  return verifyWithPrefix<MagicLinkPayload>(secret, MAGIC_PREFIX, 'ml', token, nowSec);
}

export async function signOtpLoginLink(
  secret: string,
  email: string,
  jti: string,
  opts: { ttlSec?: number; nowSec?: number } = {},
): Promise<string> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const payload: OtpLoginLinkPayload = {
    k: 'ol',
    email,
    jti,
    exp: nowSec + (opts.ttlSec ?? ACTION_TOKEN_TTL_SEC),
  };
  return signWithPrefix(secret, OTP_LINK_PREFIX, payload);
}

export async function verifyOtpLoginLink(
  secret: string,
  token: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<OtpLoginLinkPayload | null> {
  return verifyWithPrefix<OtpLoginLinkPayload>(secret, OTP_LINK_PREFIX, 'ol', token, nowSec);
}

async function signWithPrefix(
  secret: string,
  prefix: string,
  payload: { k: string; exp: number },
): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, `${prefix}.${body}`);
  return `${prefix}.${body}.${sig}`;
}

async function verifyWithPrefix<T extends { k: string; exp: number }>(
  secret: string,
  prefix: string,
  expectedKind: T['k'],
  token: string,
  nowSec: number,
): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [tokPrefix, body, sig] = parts;
  if (tokPrefix !== prefix || !body || !sig) return null;
  const ok = await hmacVerify(secret, `${prefix}.${body}`, sig);
  if (!ok) return null;
  let payload: T;
  try {
    const json = new TextDecoder().decode(base64UrlDecode(body));
    payload = JSON.parse(json) as T;
  } catch {
    return null;
  }
  if (payload.k !== expectedKind) return null;
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null;
  return payload;
}
