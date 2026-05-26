/**
 * Mailgun "webhooks/v3" payload verification.
 *
 * Mailgun signs each delivery with HMAC-SHA256 over `timestamp + token`,
 * keyed by the domain's signing key. The signature is hex-encoded. The
 * `token` is unique per delivery, which we also use as a dedupe key in KV
 * because Mailgun retries 4xx/5xx for up to 8 hours.
 *
 * Reference: https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/webhooks
 */

import type { Env } from '~/env';
import { bytesToHex, timingSafeEqual } from '~/lib/crypto';

/** Mailgun timestamps are unix seconds (string). Allow ±30 minutes for clock skew + replay. */
const MAX_AGE_SECONDS = 30 * 60;

const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

export interface MailgunSignature {
  timestamp: string;
  token: string;
  signature: string;
}

export async function verifyMailgunSignature(
  signingKey: string,
  sig: MailgunSignature,
  nowMs: number = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: 'bad_signature' | 'stale_timestamp' }> {
  const ts = Number.parseInt(sig.timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  // Reject anything outside a ±30-min window — Mailgun signs with their own
  // clock, so we permit drift in both directions.
  if (Math.abs(nowMs / 1000 - ts) > MAX_AGE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const macBytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${sig.timestamp}${sig.token}`)),
  );
  const expected = bytesToHex(macBytes);
  if (!timingSafeEqual(expected, sig.signature)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}

/**
 * Returns `true` if this is the first time we're seeing this token (and
 * we've now reserved it for the next 24h), `false` if it's a redelivery.
 *
 * Race condition note: KV reads are eventually consistent, so two
 * webhooks delivered within milliseconds of each other might both see
 * `null` on read. That's acceptable — the suspension pipeline is itself
 * idempotent (we upsert the suppressions row and `setStatus(suspended)`
 * is a no-op if already suspended). The dedupe is mostly to keep audit
 * log noise down on the long-tail of retries.
 */
export async function dedupeMailgunToken(env: Env, token: string): Promise<boolean> {
  const key = `mw:dedupe:${token}`;
  const existing = await env.KV.get(key);
  if (existing) return false;
  await env.KV.put(key, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
  return true;
}
