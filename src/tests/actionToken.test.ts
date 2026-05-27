import { describe, expect, it } from 'vitest';
import {
  FIRE_ACTIONS,
  SNOOZE_DURATIONS,
  signFireAction,
  signMagicLink,
  signOtpLoginLink,
  snoozeDurationSeconds,
  verifyFireAction,
  verifyMagicLink,
  verifyOtpLoginLink,
} from '~/lib/actionToken';

const SECRET = 'unit-test-action-secret-do-not-deploy';

describe('signFireAction / verifyFireAction', () => {
  it('round-trips every fire action shape', async () => {
    for (const op of FIRE_ACTIONS) {
      const token = await signFireAction(SECRET, { rid: 42, fid: 7, op });
      const decoded = await verifyFireAction(SECRET, token);
      expect(decoded).not.toBeNull();
      expect(decoded?.rid).toBe(42);
      expect(decoded?.fid).toBe(7);
      expect(decoded?.op).toBe(op);
      expect(decoded?.k).toBe('fa');
    }
  });

  it('rejects tokens signed with a different secret', async () => {
    const token = await signFireAction(SECRET, { rid: 1, fid: 1, op: 'skip' });
    const decoded = await verifyFireAction(`${SECRET}!`, token);
    expect(decoded).toBeNull();
  });

  it('rejects tokens whose body was tampered with', async () => {
    const token = await signFireAction(SECRET, { rid: 1, fid: 1, op: 'skip' });
    const parts = token.split('.');
    const tampered = `${parts[0]}.YWJjZGVm.${parts[2]}`;
    expect(await verifyFireAction(SECRET, tampered)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const nowSec = 1_000_000_000;
    const token = await signFireAction(
      SECRET,
      { rid: 1, fid: 1, op: 'skip' },
      { ttlSec: 60, nowSec },
    );
    const stillValid = await verifyFireAction(SECRET, token, nowSec + 30);
    expect(stillValid).not.toBeNull();
    const expired = await verifyFireAction(SECRET, token, nowSec + 120);
    expect(expired).toBeNull();
  });

  it('refuses to decode a magic-link token as a fire action', async () => {
    const magic = await signMagicLink(SECRET, 99);
    expect(await verifyFireAction(SECRET, magic)).toBeNull();
  });

  it('refuses to decode an otp login link as a fire action', async () => {
    const link = await signOtpLoginLink(SECRET, 'a@example.com', 'abc123');
    expect(await verifyFireAction(SECRET, link)).toBeNull();
  });
});

describe('signMagicLink / verifyMagicLink', () => {
  it('round-trips', async () => {
    const token = await signMagicLink(SECRET, 99);
    const decoded = await verifyMagicLink(SECRET, token);
    expect(decoded?.uid).toBe(99);
    expect(decoded?.k).toBe('ml');
  });

  it("won't decode a fire-action token as a magic link", async () => {
    const fa = await signFireAction(SECRET, { rid: 1, fid: 1, op: 'skip' });
    expect(await verifyMagicLink(SECRET, fa)).toBeNull();
  });

  it('honours expiry', async () => {
    const nowSec = 1_000_000_000;
    const token = await signMagicLink(SECRET, 1, { ttlSec: 5, nowSec });
    expect(await verifyMagicLink(SECRET, token, nowSec + 4)).not.toBeNull();
    expect(await verifyMagicLink(SECRET, token, nowSec + 10)).toBeNull();
  });

  it("won't decode an otp login link as a magic link", async () => {
    const link = await signOtpLoginLink(SECRET, 'a@example.com', 'jti');
    expect(await verifyMagicLink(SECRET, link)).toBeNull();
  });
});

describe('signOtpLoginLink / verifyOtpLoginLink', () => {
  it('round-trips', async () => {
    const token = await signOtpLoginLink(SECRET, 'alice@example.com', 'deadbeef');
    const decoded = await verifyOtpLoginLink(SECRET, token);
    expect(decoded?.email).toBe('alice@example.com');
    expect(decoded?.jti).toBe('deadbeef');
    expect(decoded?.k).toBe('ol');
  });

  it('honours expiry', async () => {
    const nowSec = 1_000_000_000;
    const token = await signOtpLoginLink(SECRET, 'a@example.com', 'jti', {
      ttlSec: 600,
      nowSec,
    });
    expect(await verifyOtpLoginLink(SECRET, token, nowSec + 599)).not.toBeNull();
    expect(await verifyOtpLoginLink(SECRET, token, nowSec + 601)).toBeNull();
  });
});

describe('snoozeDurationSeconds', () => {
  it('returns ascending durations for the canonical list', () => {
    const values = SNOOZE_DURATIONS.map(snoozeDurationSeconds);
    const sorted = [...values].sort((a, b) => a - b);
    expect(values).toEqual(sorted);
  });
});
