import { describe, expect, it } from 'vitest';
import { type RenderContext, buildVars, renderReminder } from '~/lib/render';

const baseCtx: RenderContext = {
  title: 'Take vitamins',
  bodyMd: '',
  timezone: 'America/Los_Angeles',
  fireAtUtc: '2026-05-25T15:00:00Z', // 8 AM PDT
  occurrenceNumber: 14,
  remainingCount: 6,
  nextFireUtc: '2026-05-26T15:00:00Z',
  dtstartWall: '2026-05-12T08:00:00',
  userEmail: 'alice@example.com',
};

describe('buildVars', () => {
  it('formats date/time in the user timezone', () => {
    const vars = buildVars(baseCtx);
    expect(vars.date).toMatch(/Mon, 25 May 2026/);
    expect(vars.time).toBe('8:00 AM');
    expect(vars.day_of_week).toBe('Monday');
    expect(vars.year).toBe('2026');
    expect(vars.month).toBe('May');
    expect(vars.day).toBe('25');
  });

  it('exposes occurrence info', () => {
    const vars = buildVars(baseCtx);
    expect(vars.occurrence_number).toBe('14');
    expect(vars.remaining_count).toBe('6 more after this');
    expect(vars.next_date).toMatch(/Tue, 26 May 2026/);
    expect(vars.since_start).toMatch(/^Day \d+$/);
    expect(vars.user_email).toBe('alice@example.com');
  });

  it('handles indefinite reminders and last occurrence', () => {
    const vars = buildVars({ ...baseCtx, remainingCount: null, nextFireUtc: null });
    expect(vars.remaining_count).toBe('Indefinite');
    expect(vars.next_date).toBe('This is the last one');
  });
});

describe('renderReminder', () => {
  it('substitutes vars in subject and body, then renders Markdown', () => {
    const out = renderReminder({
      ...baseCtx,
      title: 'Take vitamins ({{date}})',
      bodyMd: '**Hi {{user_email}}** — day {{day}}!',
    });
    expect(out.subject).toMatch(/Take vitamins \(Mon, 25 May 2026\)/);
    expect(out.textBody).toContain('**Hi alice@example.com** — day 25!');
    // linkify is enabled, so the email becomes a mailto: link inside the <strong>.
    expect(out.htmlBody).toContain('<strong>');
    expect(out.htmlBody).toContain('alice@example.com');
    expect(out.htmlBody).toContain('day 25!');
  });

  it('leaves unknown {{vars}} intact', () => {
    const out = renderReminder({ ...baseCtx, title: '{{title}} {{not_a_var}}', bodyMd: '' });
    expect(out.subject).toContain('{{not_a_var}}');
  });

  it('honours backslash-escaped {{vars}}', () => {
    const out = renderReminder({ ...baseCtx, title: 'lit \\{{title}}', bodyMd: '' });
    expect(out.subject).toBe('lit {{title}}');
  });

  it('sanitises dangerous HTML in the rendered body', () => {
    const out = renderReminder({
      ...baseCtx,
      title: 't',
      bodyMd: [
        '<script>alert(1)</script>',
        '[evil](javascript:alert(1))',
        '[ok](https://example.com)',
      ].join('\n\n'),
    });
    expect(out.htmlBody).not.toMatch(/<script/i);
    // No anchor tag may carry a javascript: href.
    expect(out.htmlBody).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
    // Safe links survive.
    expect(out.htmlBody).toMatch(/href=["']https:\/\/example\.com/);
  });

  it('caps subject length at 250 chars', () => {
    const out = renderReminder({ ...baseCtx, title: 'x'.repeat(500), bodyMd: '' });
    expect(out.subject.length).toBe(250);
  });
});
