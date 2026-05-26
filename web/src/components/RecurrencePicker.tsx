import { useEffect, useMemo, useState } from 'preact/hooks';

export type RecurrencePattern =
  | { kind: 'daily' }
  | { kind: 'weekdays' }
  | { kind: 'weekly'; days: WeekDay[] }
  | { kind: 'monthly' }
  | { kind: 'yearly' }
  | { kind: 'custom'; rrule: string };

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

interface Props {
  value: string;
  onChange: (rrule: string) => void;
}

export function RecurrencePicker({ value, onChange }: Props) {
  const initialPattern = useMemo(() => parseRrule(value), [value]);
  const [pattern, setPattern] = useState<RecurrencePattern>(initialPattern);

  useEffect(() => {
    onChange(buildRrule(pattern));
  }, [pattern, onChange]);

  return (
    <div class="space-y-3">
      <label class="block text-sm font-medium" for="recurrence-kind">
        Repeat
      </label>
      <select
        id="recurrence-kind"
        value={pattern.kind}
        onChange={(e) => {
          const k = (e.currentTarget as HTMLSelectElement).value as RecurrencePattern['kind'];
          setPattern(defaultPattern(k));
        }}
        class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="daily">Every day</option>
        <option value="weekdays">Every weekday (Mon–Fri)</option>
        <option value="weekly">Every week on selected days</option>
        <option value="monthly">Every month on the start date</option>
        <option value="yearly">Every year on the start date</option>
        <option value="custom">Custom (RRULE)</option>
      </select>

      {pattern.kind === 'weekly' && (
        <div class="flex flex-wrap gap-2">
          {WEEK_DAY_CODES.map((code) => {
            const selected = pattern.days.includes(code);
            return (
              <button
                key={code}
                type="button"
                onClick={() =>
                  setPattern({
                    kind: 'weekly',
                    days: selected
                      ? pattern.days.filter((d) => d !== code)
                      : [...pattern.days, code],
                  })
                }
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
      )}

      {pattern.kind === 'custom' && (
        <div class="space-y-1">
          <input
            value={pattern.rrule}
            onInput={(e) =>
              setPattern({ kind: 'custom', rrule: (e.currentTarget as HTMLInputElement).value })
            }
            placeholder="FREQ=DAILY;INTERVAL=2"
            class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <p class="text-xs text-zinc-500">
            RFC 5545 RRULE. Don&apos;t include DTSTART or TZID — those come from the start date and
            timezone above.
          </p>
        </div>
      )}
    </div>
  );
}

function defaultPattern(kind: RecurrencePattern['kind']): RecurrencePattern {
  switch (kind) {
    case 'daily':
      return { kind: 'daily' };
    case 'weekdays':
      return { kind: 'weekdays' };
    case 'weekly':
      return { kind: 'weekly', days: ['MO'] };
    case 'monthly':
      return { kind: 'monthly' };
    case 'yearly':
      return { kind: 'yearly' };
    case 'custom':
      return { kind: 'custom', rrule: 'FREQ=DAILY' };
  }
}

function buildRrule(p: RecurrencePattern): string {
  switch (p.kind) {
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly': {
      const days = p.days.length === 0 ? ['MO'] : p.days;
      return `FREQ=WEEKLY;BYDAY=${days.join(',')}`;
    }
    case 'monthly':
      return 'FREQ=MONTHLY';
    case 'yearly':
      return 'FREQ=YEARLY';
    case 'custom':
      return p.rrule;
  }
}

function parseRrule(rrule: string): RecurrencePattern {
  const upper = rrule.toUpperCase();
  if (upper === 'FREQ=DAILY') return { kind: 'daily' };
  if (upper === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') return { kind: 'weekdays' };
  if (upper === 'FREQ=MONTHLY') return { kind: 'monthly' };
  if (upper === 'FREQ=YEARLY') return { kind: 'yearly' };
  const m = upper.match(/^FREQ=WEEKLY;BYDAY=([A-Z,]+)$/);
  const dayList = m?.[1];
  if (dayList) {
    const days = dayList
      .split(',')
      .filter((d): d is WeekDay => (WEEK_DAY_CODES as readonly string[]).includes(d));
    if (days.length > 0) return { kind: 'weekly', days };
  }
  return { kind: 'custom', rrule };
}
