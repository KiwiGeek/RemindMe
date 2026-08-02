/**
 * Passphrase-wrapped export bundles (PBKDF2 + AES-GCM).
 * Wire: JSON `{ v:1, salt, iv, ciphertext }` all base64url except v.
 */

import { base64UrlDecode, base64UrlEncode, utf8Decoder, utf8Encoder } from '~/lib/crypto';

export interface EncryptedBundle {
  v: 1;
  salt: string;
  iv: string;
  ciphertext: string;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const saltCopy = new Uint8Array(salt.byteLength);
  saltCopy.set(salt);
  const material = await crypto.subtle.importKey(
    'raw',
    utf8Encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltCopy,
      iterations: 200_000,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapWithPassphrase(
  passphrase: string,
  plaintext: string,
): Promise<EncryptedBundle> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    utf8Encoder.encode(plaintext),
  );
  return {
    v: 1,
    salt: base64UrlEncode(salt),
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(cipher)),
  };
}

export async function unwrapWithPassphrase(
  passphrase: string,
  bundle: EncryptedBundle,
): Promise<string> {
  if (bundle.v !== 1) throw new Error('unsupported bundle version');
  const salt = base64UrlDecode(bundle.salt);
  const ivRaw = base64UrlDecode(bundle.iv);
  const iv = new Uint8Array(ivRaw.byteLength);
  iv.set(ivRaw);
  const dataRaw = base64UrlDecode(bundle.ciphertext);
  const data = new Uint8Array(dataRaw.byteLength);
  data.set(dataRaw);
  const key = await deriveKey(passphrase, salt);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return utf8Decoder.decode(plain);
}
