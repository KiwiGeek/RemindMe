/**
 * Reminder rendering: template-variable substitution → Markdown → sanitized
 * HTML. Used by both the email-preview API and (in M3) the actual sender.
 *
 * Template variable rules:
 *   - `{{name}}` or `{{ name }}` are replaced.
 *   - Unknown names are left intact, so users who want a literal `{{x}}` get
 *     it. They can also escape with `\{{x}}` if needed.
 *   - All values rendered in the user's timezone via luxon.
 */

import { DateTime } from 'luxon';
import MarkdownIt from 'markdown-it';
import xss from 'xss';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export interface RenderContext {
  title: string;
  bodyMd: string;
  timezone: string;
  /** ISO UTC of the firing being rendered. */
  fireAtUtc: string;
  /** 1-based count of this firing for the reminder. */
  occurrenceNumber: number;
  /** Null = indefinite; otherwise = fires remaining after this one. */
  remainingCount: number | null;
  /** ISO UTC of the next firing after this one, or null if last. */
  nextFireUtc: string | null;
  /** Reminder's stored wall-clock dtstart, no offset. */
  dtstartWall: string;
  /** Recipient. */
  userEmail: string;
}

export interface RenderedReminder {
  subject: string;
  textBody: string;
  htmlBody: string;
}

export function renderReminder(ctx: RenderContext): RenderedReminder {
  const vars = buildVars(ctx);
  const subject = applyVars(ctx.title, vars).slice(0, 250);
  const textBody = applyVars(ctx.bodyMd, vars);
  const htmlBody = xss(md.render(textBody));
  return { subject, textBody, htmlBody };
}

const VAR_PATTERN = /(\\?)\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function applyVars(template: string, vars: Record<string, string>): string {
  return template.replace(VAR_PATTERN, (match, escaped: string, name: string) => {
    if (escaped) return match.slice(1);
    return name in vars ? (vars[name] as string) : match;
  });
}

export function buildVars(ctx: RenderContext): Record<string, string> {
  const fire = DateTime.fromISO(ctx.fireAtUtc, { zone: 'utc' }).setZone(ctx.timezone);
  const dtstart = DateTime.fromISO(ctx.dtstartWall, { zone: ctx.timezone, setZone: true });
  const sinceStart = Math.max(1, Math.floor(fire.diff(dtstart, 'days').days) + 1);

  const next = ctx.nextFireUtc
    ? DateTime.fromISO(ctx.nextFireUtc, { zone: 'utc' }).setZone(ctx.timezone)
    : null;

  return {
    title: ctx.title,
    date: fire.toFormat('ccc, d LLL yyyy'),
    time: fire.toFormat('h:mm a'),
    datetime: fire.toFormat("ccc, d LLL yyyy 'at' h:mm a ZZZZ"),
    day_of_week: fire.toFormat('cccc'),
    year: String(fire.year),
    month: fire.toFormat('LLLL'),
    day: String(fire.day),
    occurrence_number: String(ctx.occurrenceNumber),
    remaining_count:
      ctx.remainingCount === null ? 'Indefinite' : `${ctx.remainingCount} more after this`,
    next_date: next ? next.toFormat('ccc, d LLL yyyy') : 'This is the last one',
    since_start: `Day ${sinceStart}`,
    user_email: ctx.userEmail,
  };
}

/** Reference list for the SPA — keeps the docs and code in lockstep. */
export const TEMPLATE_VARIABLES: readonly { name: string; description: string }[] = [
  { name: 'title', description: 'The reminder title' },
  { name: 'date', description: 'Date of this firing (e.g. "Mon, 25 May 2026")' },
  { name: 'time', description: 'Time of this firing (e.g. "8:00 AM")' },
  { name: 'datetime', description: 'Date + time + timezone' },
  { name: 'day_of_week', description: 'Long weekday name (e.g. "Monday")' },
  { name: 'year', description: 'Year, e.g. "2026"' },
  { name: 'month', description: 'Long month name, e.g. "May"' },
  { name: 'day', description: 'Day of month' },
  { name: 'occurrence_number', description: '1-based count of this firing' },
  { name: 'remaining_count', description: 'Fires left after this, or "Indefinite"' },
  { name: 'next_date', description: 'Date of the next firing, or "This is the last one"' },
  { name: 'since_start', description: 'Days since the reminder started ("Day 14")' },
  { name: 'user_email', description: 'Recipient email address' },
];
