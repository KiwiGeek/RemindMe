import { useEffect, useState } from 'preact/hooks';
import {
  ApiError,
  type CurrentUser,
  type PreviewInput,
  type PreviewResult,
  type Reminder,
  type ReminderInput,
  api,
} from '../api';
import { useDebounced } from '../hooks/useDebounced';
import { RecurrencePicker } from './RecurrencePicker';

/**
 * The form is agnostic about whether it's editing the signed-in user's own
 * reminders or — when in admin mode — someone else's. Callers inject the
 * three methods that differ between the two flows.
 */
export interface ReminderFormClient {
  preview: (input: PreviewInput) => Promise<PreviewResult>;
  create: (input: ReminderInput) => Promise<{ reminder: Reminder }>;
  update: (id: number, patch: Partial<ReminderInput>) => Promise<{ reminder: Reminder }>;
}

export const selfClient: ReminderFormClient = {
  preview: api.previewReminder,
  create: api.createReminder,
  update: api.updateReminder,
};

export function adminClient(userId: number): ReminderFormClient {
  return {
    preview: (input) => api.adminPreviewReminder(userId, input),
    create: (input) => api.adminCreateReminder(userId, input),
    update: (id, patch) => api.adminUpdateReminder(userId, id, patch),
  };
}

interface Props {
  user: Pick<CurrentUser, 'timezone'>;
  existing: Reminder | null;
  onSaved: (r: Reminder) => void;
  onCancel: () => void;
  /** Defaults to `selfClient`. Pass `adminClient(id)` to admin-edit another user. */
  client?: ReminderFormClient;
}

interface FormState {
  title: string;
  bodyMd: string;
  rrule: string;
  dtstart: string;
  timezone: string;
  endsKind: 'never' | 'after_count';
  endsAfterCount: string;
}

function initialState(user: Pick<CurrentUser, 'timezone'>, existing: Reminder | null): FormState {
  if (existing) {
    return {
      title: existing.title,
      bodyMd: existing.bodyMd,
      rrule: existing.rrule,
      dtstart: existing.dtstart,
      timezone: existing.timezone,
      endsKind: existing.remainingCount === null ? 'never' : 'after_count',
      endsAfterCount: existing.remainingCount === null ? '' : String(existing.remainingCount),
    };
  }
  return {
    title: '',
    bodyMd: '',
    rrule: 'FREQ=DAILY',
    dtstart: defaultDtstart(),
    timezone: user.timezone,
    endsKind: 'never',
    endsAfterCount: '',
  };
}

function defaultDtstart(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ReminderForm({ user, existing, onSaved, onCancel, client = selfClient }: Props) {
  const [state, setState] = useState<FormState>(() => initialState(user, existing));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const debouncedPreviewInput = useDebounced(state, 300);

  useEffect(() => {
    let cancelled = false;
    client
      .preview({
        title: debouncedPreviewInput.title,
        bodyMd: debouncedPreviewInput.bodyMd,
        rrule: debouncedPreviewInput.rrule,
        dtstart: debouncedPreviewInput.dtstart,
        timezone: debouncedPreviewInput.timezone,
        count: 5,
      })
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
        setPreviewError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(humanisePreviewError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedPreviewInput, client]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const ends: ReminderInput['ends'] =
        state.endsKind === 'after_count'
          ? { kind: 'after_count', afterCount: Number(state.endsAfterCount) || 1 }
          : { kind: 'never' };

      const payload: ReminderInput = {
        title: state.title,
        bodyMd: state.bodyMd,
        rrule: state.rrule,
        dtstart: state.dtstart,
        timezone: state.timezone,
        ends,
      };
      const res = existing
        ? await client.update(existing.id, payload)
        : await client.create(payload);
      onSaved(res.reminder);
    } catch (err) {
      setError(humaniseSaveError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} class="space-y-5">
      <div class="space-y-1">
        <label class="block text-sm font-medium" for="title">
          Title (will be the email subject)
        </label>
        <input
          id="title"
          required
          value={state.title}
          onInput={(e) => update('title', (e.currentTarget as HTMLInputElement).value)}
          maxLength={200}
          class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>

      <div class="space-y-1">
        <label class="block text-sm font-medium" for="body">
          Body (Markdown, supports template variables)
        </label>
        <textarea
          id="body"
          rows={5}
          value={state.bodyMd}
          onInput={(e) => update('bodyMd', (e.currentTarget as HTMLTextAreaElement).value)}
          maxLength={8000}
          placeholder="Hey {{user_email}}, today is {{date}} — don't forget!"
          class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <details class="text-xs text-zinc-500">
          <summary class="cursor-pointer">Available template variables</summary>
          <ul class="mt-2 space-y-0.5 font-mono">
            <li>
              <code>{'{{title}}'}</code> — the reminder title
            </li>
            <li>
              <code>{'{{date}}'}</code>, <code>{'{{time}}'}</code>, <code>{'{{datetime}}'}</code>
            </li>
            <li>
              <code>{'{{day_of_week}}'}</code>, <code>{'{{year}}'}</code>,{' '}
              <code>{'{{month}}'}</code>, <code>{'{{day}}'}</code>
            </li>
            <li>
              <code>{'{{occurrence_number}}'}</code>, <code>{'{{remaining_count}}'}</code>
            </li>
            <li>
              <code>{'{{next_date}}'}</code>, <code>{'{{since_start}}'}</code>,{' '}
              <code>{'{{user_email}}'}</code>
            </li>
          </ul>
        </details>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1">
          <label class="block text-sm font-medium" for="dtstart">
            Start
          </label>
          <input
            id="dtstart"
            type="datetime-local"
            required
            value={state.dtstart}
            onInput={(e) => update('dtstart', (e.currentTarget as HTMLInputElement).value)}
            class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <div class="space-y-1">
          <label class="block text-sm font-medium" for="timezone">
            Timezone
          </label>
          <input
            id="timezone"
            list="reminder-tz-list"
            value={state.timezone}
            onInput={(e) => update('timezone', (e.currentTarget as HTMLInputElement).value)}
            class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <datalist id="reminder-tz-list">
            {tzOptions().map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </div>
      </div>

      <RecurrencePicker value={state.rrule} onChange={(rrule) => update('rrule', rrule)} />

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium">Ends</legend>
        <label class="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="ends"
            checked={state.endsKind === 'never'}
            onChange={() => update('endsKind', 'never')}
          />
          Never
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="ends"
            checked={state.endsKind === 'after_count'}
            onChange={() => update('endsKind', 'after_count')}
          />
          After
          <input
            type="number"
            min={1}
            max={10000}
            value={state.endsAfterCount}
            onInput={(e) => update('endsAfterCount', (e.currentTarget as HTMLInputElement).value)}
            disabled={state.endsKind !== 'after_count'}
            class="w-20 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          occurrences
        </label>
      </fieldset>

      <Preview preview={preview} error={previewError} />

      {error && (
        <p
          role="alert"
          class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <div class="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          class="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !state.title.trim()}
          class="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {saving ? 'Saving…' : existing ? 'Save changes' : 'Create reminder'}
        </button>
      </div>
    </form>
  );
}

function Preview({
  preview,
  error,
}: {
  preview: PreviewResult | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Preview: {error}
      </div>
    );
  }
  if (!preview) {
    return (
      <div class="rounded-lg border border-dashed border-zinc-300 p-3 text-sm text-zinc-500 dark:border-zinc-700">
        Computing preview…
      </div>
    );
  }
  return (
    <div class="rounded-lg border border-zinc-300 p-3 text-sm dark:border-zinc-700">
      <p class="mb-2 font-medium">Schedule: {preview.summary}</p>
      <p class="text-xs text-zinc-500">Next 5 firings:</p>
      <ul class="mt-1 list-disc space-y-0.5 pl-5 text-xs font-mono">
        {preview.fires.length === 0 && <li>(no upcoming firings)</li>}
        {preview.fires.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      {preview.sample && (
        <div class="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <p class="text-xs uppercase text-zinc-500">Sample rendered email</p>
          <p class="mt-1 font-medium">{preview.sample.subject}</p>
          {/* HTML body is server-sanitised by `xss` before reaching us; same content goes into the
              outgoing email. Rendering inline so the preview matches what the user will see. */}
          <div
            class="prose prose-sm mt-1 max-w-none rounded bg-zinc-50 p-2 text-sm dark:bg-zinc-900"
            dangerouslySetInnerHTML={{ __html: preview.sample.htmlBody }}
          />
        </div>
      )}
    </div>
  );
}

function tzOptions(): string[] {
  type IntlExt = typeof Intl & { supportedValuesOf?: (k: 'timeZone') => string[] };
  return (Intl as IntlExt).supportedValuesOf?.('timeZone') ?? ['UTC'];
}

function humaniseSaveError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.message) {
      case 'invalid_rrule':
        return "That recurrence rule isn't valid. Double-check the RRULE syntax.";
      case 'invalid_timezone':
        return 'Unknown timezone.';
      case 'invalid_dtstart':
        return 'Invalid start date or time.';
      case 'rrule_includes_dtstart':
        return 'Custom RRULEs must not include DTSTART or TZID.';
      default:
        return `Couldn't save: ${err.message}`;
    }
  }
  return 'Something went wrong while saving.';
}

function humanisePreviewError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'preview unavailable';
}
