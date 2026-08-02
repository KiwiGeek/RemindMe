/**
 * AES-GCM encrypt/decrypt for settings at rest, keyed by INSTANCE_SECRET.
 * Wire format: `v1:` + base64url(iv || ciphertext||tag)
 */

import { base64UrlDecode, base64UrlEncode, utf8Decoder, utf8Encoder } from '~/lib/crypto';

const PREFIX = 'v1:';

async function deriveKey(instanceSecret: string): Promise<CryptoKey> {
  if (keyCache && keyCache.secret === instanceSecret) return keyCache.key;
  const material = await crypto.subtle.importKey(
    'raw',
    utf8Encoder.encode(instanceSecret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: utf8Encoder.encode('remindme-settings-v1'),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  keyCache = { secret: instanceSecret, key };
  return key;
}

let keyCache: { secret: string; key: CryptoKey } | null = null;

export async function encryptSecret(instanceSecret: string, plaintext: string): Promise<string> {
  const key = await deriveKey(instanceSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    utf8Encoder.encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return PREFIX + base64UrlEncode(combined);
}

export async function decryptSecret(instanceSecret: string, blob: string): Promise<string> {
  if (!blob.startsWith(PREFIX)) {
    throw new Error('unknown secret encoding');
  }
  const key = await deriveKey(instanceSecret);
  const combinedRaw = base64UrlDecode(blob.slice(PREFIX.length));
  const combined = new Uint8Array(combinedRaw.byteLength);
  combined.set(combinedRaw);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return utf8Decoder.decode(plain);
}
