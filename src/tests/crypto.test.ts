import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  hashOtp,
  hexToBytes,
  hmacSign,
  hmacVerify,
  randomHex,
  randomNumericCode,
  timingSafeEqual,
} from '~/lib/crypto';

describe('randomNumericCode', () => {
  it('returns the requested number of digits', () => {
    for (let n = 1; n <= 8; n++) {
      const code = randomNumericCode(n);
      expect(code).toMatch(new RegExp(`^\\d{${n}}$`));
    }
  });

  it('rejects out-of-range sizes', () => {
    expect(() => randomNumericCode(0)).toThrow();
    expect(() => randomNumericCode(13)).toThrow();
  });

  it('looks roughly distributed across many samples', () => {
    const counts = new Array(10).fill(0) as number[];
    for (let i = 0; i < 5000; i++) {
      const c = randomNumericCode(1);
      counts[Number.parseInt(c, 10)] = (counts[Number.parseInt(c, 10)] ?? 0) + 1;
    }
    for (const n of counts) {
      expect(n).toBeGreaterThan(300);
      expect(n).toBeLessThan(700);
    }
  });
});

describe('hex round-trip', () => {
  it('encodes and decodes bytes', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 255]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it('randomHex returns the right length', () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('base64url round-trip', () => {
  it('handles arbitrary bytes including those that need padding', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 16, 31, 32, 33]) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = i;
      const round = base64UrlDecode(base64UrlEncode(bytes));
      expect(round).toEqual(bytes);
    }
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });
  it('returns false for different strings', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('hmac sign/verify', () => {
  it('verifies its own signature', async () => {
    const sig = await hmacSign('secret', 'hello');
    expect(await hmacVerify('secret', 'hello', sig)).toBe(true);
  });
  it('rejects tampered signatures', async () => {
    const sig = await hmacSign('secret', 'hello');
    expect(await hmacVerify('secret', 'hello', `${sig}x`)).toBe(false);
    expect(await hmacVerify('secret', 'world', sig)).toBe(false);
    expect(await hmacVerify('other', 'hello', sig)).toBe(false);
  });
});

describe('hashOtp', () => {
  it('is deterministic for the same pepper and code', async () => {
    const a = await hashOtp('pep', '123456');
    const b = await hashOtp('pep', '123456');
    expect(a).toBe(b);
  });
  it('changes when the pepper changes', async () => {
    expect(await hashOtp('pep1', '123456')).not.toBe(await hashOtp('pep2', '123456'));
  });
  it('changes when the code changes', async () => {
    expect(await hashOtp('pep', '111111')).not.toBe(await hashOtp('pep', '111112'));
  });
});
