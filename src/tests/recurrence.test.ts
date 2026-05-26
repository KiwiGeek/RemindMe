import { describe, expect, it } from 'vitest';
import { RecurrenceValidationError, nextFires, summarize, validateInputs } from '~/lib/recurrence';

describe('validateInputs', () => {
  it('accepts a sane combination', () => {
    expect(() =>
      validateInputs({
        rrule: 'FREQ=DAILY',
        dtstart: '2026-05-25T08:00:00',
        timezone: 'America/Los_Angeles',
      }),
    ).not.toThrow();
  });

  it('rejects invalid dtstart', () => {
    expect(() =>
      validateInputs({
        rrule: 'FREQ=DAILY',
        dtstart: 'tomorrow at noon',
        timezone: 'UTC',
      }),
    ).toThrow(/invalid_dtstart|invalid dtstart/);
  });

  it('rejects invalid timezone', () => {
    try {
      validateInputs({
        rrule: 'FREQ=DAILY',
        dtstart: '2026-05-25T08:00:00',
        timezone: 'Mars/Olympus',
      });
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RecurrenceValidationError);
      expect((e as RecurrenceValidationError).code).toBe('invalid_timezone');
    }
  });

  it('rejects RRULE missing FREQ', () => {
    try {
      validateInputs({
        rrule: 'INTERVAL=2',
        dtstart: '2026-05-25T08:00:00',
        timezone: 'UTC',
      });
      expect.fail('expected throw');
    } catch (e) {
      expect((e as RecurrenceValidationError).code).toBe('invalid_rrule');
    }
  });

  it('rejects DTSTART embedded in the RRULE', () => {
    try {
      validateInputs({
        rrule: 'DTSTART:20260525T080000Z\nRRULE:FREQ=DAILY',
        dtstart: '2026-05-25T08:00:00',
        timezone: 'UTC',
      });
      expect.fail('expected throw');
    } catch (e) {
      expect((e as RecurrenceValidationError).code).toBe('rrule_includes_dtstart');
    }
  });
});

describe('nextFires', () => {
  it('returns the first N daily fires anchored at dtstart, in the user tz', () => {
    const fires = nextFires(
      { rrule: 'FREQ=DAILY', dtstart: '2026-05-25T08:00:00', timezone: 'America/Los_Angeles' },
      3,
    );
    expect(fires).toHaveLength(3);
    // 8 AM PDT (UTC-7) on May 25 = 15:00 UTC
    expect(fires[0]).toBe('2026-05-25T15:00:00Z');
    expect(fires[1]).toBe('2026-05-26T15:00:00Z');
    expect(fires[2]).toBe('2026-05-27T15:00:00Z');
  });

  it('handles UTC dtstart trivially', () => {
    const fires = nextFires(
      { rrule: 'FREQ=DAILY', dtstart: '2026-05-25T00:00:00', timezone: 'UTC' },
      2,
    );
    expect(fires).toEqual(['2026-05-25T00:00:00Z', '2026-05-26T00:00:00Z']);
  });

  it('crosses DST without wall-time drift (LA, spring-forward)', () => {
    // PST → PDT transition happens at 02:00 local on 2026-03-08.
    // A daily 8 AM reminder should fire at 16:00 UTC before, 15:00 UTC after.
    const fires = nextFires(
      {
        rrule: 'FREQ=DAILY',
        dtstart: '2026-03-07T08:00:00',
        timezone: 'America/Los_Angeles',
      },
      3,
    );
    expect(fires[0]).toBe('2026-03-07T16:00:00Z'); // PST
    expect(fires[1]).toBe('2026-03-08T15:00:00Z'); // PDT
    expect(fires[2]).toBe('2026-03-09T15:00:00Z'); // PDT
  });

  it('returns fires only after a cursor when afterUtc is set', () => {
    const fires = nextFires(
      { rrule: 'FREQ=DAILY', dtstart: '2026-05-25T00:00:00', timezone: 'UTC' },
      2,
      { afterUtc: '2026-05-26T12:00:00Z' },
    );
    expect(fires).toEqual(['2026-05-27T00:00:00Z', '2026-05-28T00:00:00Z']);
  });

  it('respects untilUtc bound', () => {
    const fires = nextFires(
      { rrule: 'FREQ=DAILY', dtstart: '2026-05-25T00:00:00', timezone: 'UTC' },
      100,
      { untilUtc: '2026-05-28T00:00:00Z' },
    );
    expect(fires).toEqual([
      '2026-05-25T00:00:00Z',
      '2026-05-26T00:00:00Z',
      '2026-05-27T00:00:00Z',
      '2026-05-28T00:00:00Z',
    ]);
  });

  it('handles weekly on selected days', () => {
    const fires = nextFires(
      {
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
        dtstart: '2026-05-25T09:00:00', // Monday
        timezone: 'UTC',
      },
      4,
    );
    expect(fires).toEqual([
      '2026-05-25T09:00:00Z', // Mon
      '2026-05-27T09:00:00Z', // Wed
      '2026-05-29T09:00:00Z', // Fri
      '2026-06-01T09:00:00Z', // Mon
    ]);
  });
});

describe('summarize', () => {
  it('produces a human string for common patterns', () => {
    expect(summarize('FREQ=DAILY')).toMatch(/every day/i);
    expect(summarize('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toMatch(/weekday/i);
    expect(summarize('FREQ=MONTHLY')).toMatch(/month/i);
  });

  it('falls back to the raw rule on parse failure', () => {
    expect(summarize('garbage')).toBe('garbage');
  });
});
