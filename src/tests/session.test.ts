import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from '~/lib/session';

describe('signSession / verifySession', () => {
  it('round-trips a payload', async () => {
    const token = await signSession('s3cret', 42);
    const payload = await verifySession('s3cret', token);
    expect(payload?.uid).toBe(42);
    expect(payload?.iat).toBeGreaterThan(0);
    expect(payload?.exp).toBeGreaterThan(payload?.iat ?? 0);
  });

  it('rejects a tampered body', async () => {
    const token = await signSession('s3cret', 42);
    const [body, sig] = token.split('.');
    const tampered = `${body}x.${sig}`;
    expect(await verifySession('s3cret', tampered)).toBeNull();
  });

  it('rejects a wrong secret', async () => {
    const token = await signSession('s3cret', 42);
    expect(await verifySession('other', token)).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifySession('s3cret', '')).toBeNull();
    expect(await verifySession('s3cret', 'no-dot')).toBeNull();
    expect(await verifySession('s3cret', '.justsig')).toBeNull();
  });

  it('rejects expired sessions', async () => {
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000_000_000;
      const token = await signSession('s3cret', 1);
      Date.now = () => 1_000_000_000_000 + 31 * 24 * 60 * 60 * 1000;
      expect(await verifySession('s3cret', token)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});
