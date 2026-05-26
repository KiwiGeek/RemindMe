/**
 * Crypto primitives built on Web Crypto. Everything async; no Node-specific
 * APIs so Workers tests in Miniflare behave identically to production.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Generate a random N-digit numeric string with cryptographically-strong RNG. */
export function randomNumericCode(digits: number): string {
  if (digits <= 0 || digits > 12) throw new Error('digits out of range');
  const bytes = new Uint8Array(digits);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += (b % 10).toString();
  return out;
}

/** Generate `bytes` random bytes encoded as lowercase hex. */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/** Lowercase hex (no `0x`). */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('bad hex');
    out[i] = byte;
  }
  return out;
}

/** URL-safe base64 (no padding) — RFC 4648 §5. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Timing-safe equality on two equal-length strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** HMAC-SHA256 → URL-safe base64. */
export async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return base64UrlEncode(new Uint8Array(sig));
}

export async function hmacVerify(
  secret: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const expected = await hmacSign(secret, message);
  return timingSafeEqual(expected, signature);
}

/**
 * Hash an OTP using SHA-256 with a worker-wide pepper. Returns hex.
 *
 * Codes are 6-digit; brute force over the entire space takes microseconds
 * locally, but the pepper means an attacker with read-only KV access still
 * needs the pepper to confirm a guess.
 */
export async function hashOtp(pepper: string, code: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(`${pepper}:${code}`));
  return bytesToHex(new Uint8Array(buf));
}

export { enc as utf8Encoder, dec as utf8Decoder };
