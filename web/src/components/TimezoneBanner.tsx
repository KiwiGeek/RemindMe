import { useState } from 'preact/hooks';
import { type CurrentUser, api, detectBrowserTimezone } from '../api';

interface Props {
  user: CurrentUser;
  onConfirmed: (user: CurrentUser) => void;
}

export function TimezoneBanner({ user, onConfirmed }: Props) {
  const detected = detectBrowserTimezone();
  const [editing, setEditing] = useState(false);
  const [tz, setTz] = useState(detected);
  const [busy, setBusy] = useState(false);

  async function confirm(value: string) {
    setBusy(true);
    try {
      const res = await api.updateMe({ timezone: value, tzConfirmed: true });
      onConfirmed(res.user);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="rounded-2xl border border-amber-300/55 bg-gradient-to-br from-amber-50 to-amber-100/40 p-5 text-sm shadow-md shadow-amber-900/10 dark:border-amber-800/80 dark:from-amber-950 dark:to-amber-950/40 dark:shadow-black/30">
      <p class="mb-2 font-semibold text-amber-950 dark:text-amber-100">Confirm your timezone</p>
      {!editing ? (
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-amber-900 dark:text-amber-100">
            We think you&apos;re in <span class="font-mono">{detected}</span>. Reminders will fire
            in this timezone.
          </span>
          <div class="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirm(detected)}
              class="rounded-md bg-amber-900 px-3 py-1 text-xs font-medium text-amber-50 hover:bg-amber-800 disabled:opacity-50"
            >
              Yes, that&apos;s right
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              class="rounded-md border border-amber-700 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900"
            >
              Pick a different one
            </button>
          </div>
        </div>
      ) : (
        <div class="flex flex-wrap items-center gap-2">
          <input
            list="tz-list"
            value={tz}
            onInput={(e) => setTz((e.currentTarget as HTMLInputElement).value)}
            class="min-w-[16rem] rounded-md border border-amber-300 bg-white px-2 py-1 font-mono text-sm dark:border-amber-700 dark:bg-amber-900"
            placeholder="e.g. America/Los_Angeles"
          />
          <datalist id="tz-list">
            {tzOptions().map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
          <button
            type="button"
            disabled={busy || !tz}
            onClick={() => void confirm(tz)}
            class="rounded-md bg-amber-900 px-3 py-1 text-xs font-medium text-amber-50 hover:bg-amber-800 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setTz(detected);
            }}
            class="rounded-md border border-amber-700 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900"
          >
            Cancel
          </button>
          <p class="basis-full text-xs text-amber-800 dark:text-amber-300">
            You can change this anytime under Settings.
          </p>
        </div>
      )}
      <p class="mt-2 text-xs text-amber-800 dark:text-amber-300">
        Current account timezone: <span class="font-mono">{user.timezone}</span>
      </p>
    </div>
  );
}

function tzOptions(): string[] {
  type IntlExt = typeof Intl & { supportedValuesOf?: (k: 'timeZone') => string[] };
  const supported = (Intl as IntlExt).supportedValuesOf?.('timeZone');
  return supported ?? ['UTC'];
}
