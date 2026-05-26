/**
 * Recurrence engine built on top of `rrule` + `luxon`.
 *
 * Storage model:
 *   - `rrule`     RRULE string with no DTSTART/TZID embedded
 *                 (e.g. `FREQ=DAILY;INTERVAL=2;BYHOUR=8;BYMINUTE=0`)
 *   - `dtstart`   ISO-8601 wall-clock time, NO offset
 *                 (e.g. `2026-05-25T08:00:00`)
 *   - `timezone`  IANA tz string (e.g. `America/Los_Angeles`)
 *
 * We construct the underlying RRule with the wall-clock numbers stuffed into
 * a UTC Date, then translate each occurrence back to a real UTC moment via
 * luxon using the user's tz. This keeps DST semantics in our control rather
 * than relying on rrule's optional tzid support, which has spotty behaviour
 * in bundler/runtime combinations.
 */

import { DateTime } from 'luxon';
import { RRule } from 'rrule';

export interface RecurrenceInputs {
  rrule: string;
  dtstart: string;
  timezone: string;
}

export type ValidationCode =
  | 'invalid_rrule'
  | 'invalid_dtstart'
  | 'invalid_timezone'
  | 'rrule_includes_dtstart';

export class RecurrenceValidationError extends Error {
  constructor(
    readonly code: ValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'RecurrenceValidationError';
  }
}

export function validateInputs(inputs: RecurrenceInputs): void {
  if (!DateTime.fromISO(inputs.dtstart, { setZone: false }).isValid) {
    throw new RecurrenceValidationError('invalid_dtstart', `invalid dtstart: ${inputs.dtstart}`);
  }
  if (!DateTime.local().setZone(inputs.timezone).isValid) {
    throw new RecurrenceValidationError('invalid_timezone', `invalid timezone: ${inputs.timezone}`);
  }
  if (/\bDTSTART\b|\bTZID\b/i.test(inputs.rrule)) {
    throw new RecurrenceValidationError(
      'rrule_includes_dtstart',
      'DTSTART and TZID are tracked separately; do not include them in RRULE',
    );
  }
  let opts: Partial<ConstructorParameters<typeof RRule>[0]>;
  try {
    opts = RRule.parseString(inputs.rrule);
  } catch (e) {
    throw new RecurrenceValidationError(
      'invalid_rrule',
      e instanceof Error ? e.message : 'invalid RRULE',
    );
  }
  if (opts.freq === undefined || opts.freq === null) {
    throw new RecurrenceValidationError('invalid_rrule', 'RRULE must include FREQ=');
  }
}

function buildRule(inputs: RecurrenceInputs): RRule {
  const opts = RRule.parseString(inputs.rrule);
  const dt = DateTime.fromISO(inputs.dtstart, { setZone: false });
  const dtstart = new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second));
  return new RRule({ ...opts, dtstart });
}

/** Convert an rrule "wall-clock-as-UTC" Date to a real UTC ISO string. */
function wallToUtcIso(d: Date, tz: string): string {
  const wall = DateTime.fromObject(
    {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    },
    { zone: tz },
  );
  return wall.toUTC().toISO({ suppressMilliseconds: true }) ?? '';
}

/** Inverse of `wallToUtcIso` for cursor advancement. */
function utcIsoToWallDate(utc: string, tz: string): Date {
  const local = DateTime.fromISO(utc, { zone: 'utc' }).setZone(tz);
  return new Date(
    Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second),
  );
}

export interface NextFiresOptions {
  /** Strictly after this UTC moment. Defaults to dtstart. */
  afterUtc?: string;
  /** Stop returning fires past this UTC moment. */
  untilUtc?: string;
  /** Hard ceiling on internal iteration; defaults to count + small margin. */
  maxIterations?: number;
}

/**
 * Return up to `count` future firings as UTC ISO strings.
 *
 * - If `afterUtc` is omitted, returns the first `count` occurrences starting
 *   at dtstart.
 * - If `untilUtc` is set, stops as soon as the next fire would be after it.
 */
export function nextFires(
  inputs: RecurrenceInputs,
  count: number,
  opts: NextFiresOptions = {},
): string[] {
  if (count <= 0) return [];
  validateInputs(inputs);
  const rule = buildRule(inputs);
  const fires: string[] = [];
  const maxIter = opts.maxIterations ?? Math.max(count * 4, 100);

  if (!opts.afterUtc) {
    let i = 0;
    const all = rule.all((_, idx) => {
      i = idx;
      return idx < count && i < maxIter;
    });
    for (const d of all) {
      const iso = wallToUtcIso(d, inputs.timezone);
      if (opts.untilUtc && iso > opts.untilUtc) break;
      fires.push(iso);
      if (fires.length >= count) break;
    }
    return fires;
  }

  let cursor = utcIsoToWallDate(opts.afterUtc, inputs.timezone);
  let iter = 0;
  while (fires.length < count && iter++ < maxIter) {
    const next = rule.after(cursor, false);
    if (!next) break;
    const iso = wallToUtcIso(next, inputs.timezone);
    if (opts.untilUtc && iso > opts.untilUtc) break;
    fires.push(iso);
    cursor = next;
  }
  return fires;
}

/** Human-readable schedule summary, e.g. "every weekday at 8 AM". */
export function summarize(rrule: string): string {
  try {
    return new RRule(RRule.parseString(rrule)).toText();
  } catch {
    return rrule;
  }
}
