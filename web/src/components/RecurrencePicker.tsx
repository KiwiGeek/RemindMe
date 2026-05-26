import { useMemo, useState } from 'preact/hooks';

/**
 * Recurrence picker. The RRULE string in the parent's form state remains
 * the source of truth for *which schedule will be saved*. We derive the
 * structured pattern from `value` via `useMemo` and emit changes through
 * `onChange` from each event handler — no `useEffect`-based prop→state
 * mirroring (an earlier version did that and caused an infinite render
 * loop, because the parent passes a fresh inline `onChange`, the effect
 * re-fired every render, and each emit re-rendered the parent).
 *
 * The one piece of UI-only state we keep is `stickyCustom`: once the user
 * explicitly picks "Custom" from the dropdown, we stay in custom mode even
 * if the typed RRULE happens to parse back into a structured kind (e.g.
 * `FREQ=DAILY`, which the parser would otherwise snap to "Every day" and
 * close the textbox out from under them). It's seeded from the initial
 * parse so loading an existing custom reminder lands in custom mode
 * without an extra click. The parent unmounts the form (and us) when it
 * switches between "new" / "edit", so we don't need to worry about
 * external value resets surviving the toggle.
 */

const WEEK_DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
type WeekDay = (typeof WEEK_DAY_CODES)[number];

const WEEK_DAY_LABELS: Record<WeekDay, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};

const WEEK_DAY_LONG: Record<WeekDay, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};

// 5th-of-month is omitted on purpose: months that don't have a 5th occurrence
// of a given weekday silently skip the firing, which is rarely what users
// actually want. "Last" covers that intent better.
const ORDINALS = [1, 2, 3, 4, -1] as const;
type Ordinal = (typeof ORDINALS)[number];

const ORDINAL_LABELS: Record<Ordinal, string> = {
  1: 'First',
  2: 'Second',
  3: 'Third',
  4: 'Fourth',
  '-1': 'Last',
};

export type RecurrencePattern =
  | { kind: 'daily' }
  | { kind: 'weekdays' }
  | { kind: 'weekly'; interval: number; days: WeekDay[] }
  | { kind: 'monthly_day' }
  | { kind: 'monthly_nth'; ordinal: Ordinal; day: WeekDay }
  | { kind: 'yearly' }
  | { kind: 'custom'; rrule: string };

type Kind = RecurrencePattern['kind'];

interface Props {
  value: string;
  onChange: (rrule: string) => void;
}

export function RecurrencePicker({ value, onChange }: Props) {
  const parsed = useMemo(() => parseRrule(value), [value]);
  const [stickyCustom, setStickyCustom] = useState(() => parsed.kind === 'custom');
  const pattern: RecurrencePattern = stickyCustom ? { kind: 'custom', rrule: value } : parsed;

  function selectKind(kind: Kind) {
    setStickyCustom(kind === 'custom');
    onChange(buildRrule(defaultPattern(kind)));
  }

  function toggleDay(code: WeekDay) {
    if (pattern.kind !== 'weekly') return;
    const current = pattern.days;
    const next = current.includes(code) ? current.filter((d) => d !== code) : [...current, code];
    // Empty selection would produce an invalid RRULE; fall back to Monday
    // so the schedule remains valid while the user clicks around.
    onChange(buildRrule({ ...pattern, days: next.length === 0 ? ['MO'] : next }));
  }

  function setInterval(n: number) {
    if (pattern.kind !== 'weekly') return;
    const safe = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    onChange(buildRrule({ ...pattern, interval: safe }));
  }

  function setOrdinal(ord: Ordinal) {
    if (pattern.kind !== 'monthly_nth') return;
    onChange(buildRrule({ ...pattern, ordinal: ord }));
  }

  function setMonthlyDay(day: WeekDay) {
    if (pattern.kind !== 'monthly_nth') return;
    onChange(buildRrule({ ...pattern, day }));
  }

  return (
    <div class="space-y-3">
      <label class="block text-sm font-medium" for="recurrence-kind">
        Repeat
      </label>
      <select
        id="recurrence-kind"
        value={pattern.kind}
        onChange={(e) => selectKind((e.currentTarget as HTMLSelectElement).value as Kind)}
        class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="daily">Every day</option>
        <option value="weekdays">Every weekday (Mon–Fri)</option>
        <option value="weekly">Every N weeks on selected days</option>
        <option value="monthly_day">Every month on the start day</option>
        <option value="monthly_nth">Every month on the Nth weekday</option>
        <option value="yearly">Every year on the start date</option>
        <option value="custom">Custom (RRULE)</option>
      </select>

      {pattern.kind === 'weekly' && (
        <div class="space-y-2">
          <div class="flex items-center gap-2 text-sm">
            <span>Every</span>
            <input
              type="number"
              min={1}
              max={52}
              value={pattern.interval}
              onInput={(e) => setInterval(Number((e.currentTarget as HTMLInputElement).value))}
              aria-label="Repeat interval, in weeks"
              class="w-16 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>{pattern.interval === 1 ? 'week on' : 'weeks on'}</span>
          </div>
          <div class="flex flex-wrap gap-2">
            {WEEK_DAY_CODES.map((code) => {
              const selected = pattern.days.includes(code);
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => toggleDay(code)}
                  aria-pressed={selected}
                  class={`rounded-md border px-2 py-1 text-xs font-medium ${
                    selected
                      ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                      : 'border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900'
                  }`}
                >
                  {WEEK_DAY_LABELS[code]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {pattern.kind === 'monthly_nth' && (
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span>On the</span>
          <select
            value={String(pattern.ordinal)}
            onChange={(e) =>
              setOrdinal(Number((e.currentTarget as HTMLSelectElement).value) as Ordinal)
            }
            aria-label="Which occurrence in the month"
            class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {ORDINALS.map((o) => (
              <option key={o} value={String(o)}>
                {ORDINAL_LABELS[o]}
              </option>
            ))}
          </select>
          <select
            value={pattern.day}
            onChange={(e) => setMonthlyDay((e.currentTarget as HTMLSelectElement).value as WeekDay)}
            aria-label="Day of week"
            class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {WEEK_DAY_CODES.map((d) => (
              <option key={d} value={d}>
                {WEEK_DAY_LONG[d]}
              </option>
            ))}
          </select>
          <span>of every month</span>
        </div>
      )}

      {pattern.kind === 'custom' && (
        <div class="space-y-1">
          <input
            value={pattern.rrule}
            onInput={(e) =>
              onChange(
                buildRrule({
                  kind: 'custom',
                  rrule: (e.currentTarget as HTMLInputElement).value,
                }),
              )
            }
            placeholder="FREQ=DAILY;INTERVAL=2"
            spellcheck={false}
            autocapitalize="off"
            autocorrect="off"
            class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <p class="text-xs text-zinc-500">
            RFC 5545 RRULE. Don&apos;t include DTSTART or TZID — those come from the start date and
            timezone above. The preview below will flag invalid rules.
          </p>
        </div>
      )}
    </div>
  );
}

function defaultPattern(kind: Kind): RecurrencePattern {
  switch (kind) {
    case 'daily':
      return { kind: 'daily' };
    case 'weekdays':
      return { kind: 'weekdays' };
    case 'weekly':
      return { kind: 'weekly', interval: 1, days: ['MO'] };
    case 'monthly_day':
      return { kind: 'monthly_day' };
    case 'monthly_nth':
      return { kind: 'monthly_nth', ordinal: 1, day: 'MO' };
    case 'yearly':
      return { kind: 'yearly' };
    case 'custom':
      return { kind: 'custom', rrule: 'FREQ=DAILY' };
  }
}

export function buildRrule(p: RecurrencePattern): string {
  switch (p.kind) {
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly': {
      const source: WeekDay[] = p.days.length === 0 ? ['MO'] : p.days;
      const days = source
        .slice()
        .sort((a, b) => WEEK_DAY_CODES.indexOf(a) - WEEK_DAY_CODES.indexOf(b));
      const interval = p.interval > 1 ? `;INTERVAL=${p.interval}` : '';
      return `FREQ=WEEKLY${interval};BYDAY=${days.join(',')}`;
    }
    case 'monthly_day':
      return 'FREQ=MONTHLY';
    case 'monthly_nth':
      return `FREQ=MONTHLY;BYDAY=${p.ordinal}${p.day}`;
    case 'yearly':
      return 'FREQ=YEARLY';
    case 'custom':
      return p.rrule;
  }
}

/**
 * Parse an RRULE string into a `RecurrencePattern`. Order-insensitive across
 * the RRULE parts: `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO` and
 * `INTERVAL=2;BYDAY=MO;FREQ=WEEKLY` map to the same pattern.
 *
 * Anything we can't faithfully represent through the dropdown (BYMONTHDAY,
 * UNTIL, COUNT, BYSETPOS, multi-occurrence BYDAY for monthly, etc.) falls
 * back to `kind: 'custom'` so the user keeps editing it as raw RRULE rather
 * than us silently dropping their parameters.
 */
export function parseRrule(rrule: string): RecurrencePattern {
  const parts = toParts(rrule);
  if (parts.size === 0) return { kind: 'custom', rrule };

  const freq = parts.get('FREQ');
  const interval = clampInterval(parts.get('INTERVAL'));
  const byday = parts.get('BYDAY');
  const extraKeys = [...parts.keys()].filter(
    (k) => k !== 'FREQ' && k !== 'INTERVAL' && k !== 'BYDAY',
  );
  if (extraKeys.length > 0) return { kind: 'custom', rrule };

  if (freq === 'DAILY' && interval === 1 && !byday) return { kind: 'daily' };

  if (freq === 'WEEKLY' && byday) {
    const days = parseWeekDays(byday);
    if (days && days.length > 0) {
      if (interval === 1 && isMondayThroughFriday(days)) return { kind: 'weekdays' };
      return { kind: 'weekly', interval, days };
    }
  }

  if (freq === 'MONTHLY' && !byday && interval === 1) return { kind: 'monthly_day' };

  if (freq === 'MONTHLY' && byday && interval === 1) {
    const nth = parseNthWeekday(byday);
    if (nth) return { kind: 'monthly_nth', ordinal: nth.ordinal, day: nth.day };
  }

  if (freq === 'YEARLY' && interval === 1 && !byday) return { kind: 'yearly' };

  return { kind: 'custom', rrule };
}

function toParts(rrule: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim().toUpperCase();
    const v = part
      .slice(eq + 1)
      .trim()
      .toUpperCase();
    if (k && v) map.set(k, v);
  }
  return map;
}

function clampInterval(raw: string | undefined): number {
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function parseWeekDays(byday: string): WeekDay[] | null {
  const out: WeekDay[] = [];
  for (const tok of byday.split(',')) {
    const t = tok.trim();
    if (!(WEEK_DAY_CODES as readonly string[]).includes(t)) return null;
    out.push(t as WeekDay);
  }
  return out;
}

function isMondayThroughFriday(days: WeekDay[]): boolean {
  if (days.length !== 5) return false;
  const set = new Set(days);
  return ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => set.has(d as WeekDay));
}

function parseNthWeekday(byday: string): { ordinal: Ordinal; day: WeekDay } | null {
  // RFC 5545 BYDAY may be a comma-separated list. The dropdown only
  // represents a single occurrence, so we bail to custom on lists.
  if (byday.includes(',')) return null;
  const m = byday.match(/^(-?\d+)(MO|TU|WE|TH|FR|SA|SU)$/);
  if (!m) return null;
  const ord = Number(m[1]);
  if (!(ORDINALS as readonly number[]).includes(ord)) return null;
  return { ordinal: ord as Ordinal, day: m[2] as WeekDay };
}
