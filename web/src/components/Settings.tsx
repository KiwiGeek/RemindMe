/**
 * Account settings — passkeys, account timezone, theme. Kept as a
 * top-level view so heavier options (deletion, notification prefs) can
 * land here without a re-layout.
 */

import { useEffect, useState } from 'preact/hooks';
import { ApiError, type CurrentUser, api } from '../api';
import { PasskeysSection } from './PasskeysSection';
import { ThemeToggle } from './ThemeToggle';

interface Props {
  user: CurrentUser;
  onUserChanged: (user: CurrentUser) => void;
  onExit: () => void;
  onLoggedOut: () => void;
}

function tzOptions(): string[] {
  type IntlExt = typeof Intl & { supportedValuesOf?: (k: 'timeZone') => string[] };
  return (Intl as IntlExt).supportedValuesOf?.('timeZone') ?? ['UTC'];
}

function timezoneFieldError(code: string): string {
  switch (code) {
    case 'invalid_timezone':
      return 'Unknown timezone. Pick a value from the list or check the spelling.';
    default:
      return 'Could not save timezone.';
  }
}

export function Settings({ user, onUserChanged, onExit, onLoggedOut }: Props) {
  const [busy, setBusy] = useState(false);
  const [timezoneInput, setTimezoneInput] = useState(user.timezone);
  const [tzBusy, setTzBusy] = useState(false);
  const [tzError, setTzError] = useState<string | null>(null);

  useEffect(() => {
    setTimezoneInput(user.timezone);
  }, [user.timezone]);

  const normalizedTz = timezoneInput.trim();
  const tzDirty =
    normalizedTz !== user.timezone || !user.tzConfirmed;

  async function saveTimezone() {
    if (!normalizedTz) return;
    setTzBusy(true);
    setTzError(null);
    try {
      const res = await api.updateMe({
        timezone: normalizedTz,
        tzConfirmed: true,
      });
      onUserChanged(res.user);
    } catch (err) {
      const code = err instanceof ApiError ? err.message : 'unknown';
      setTzError(timezoneFieldError(code));
    } finally {
      setTzBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await api.logout();
      onLoggedOut();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
      <header class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">
            Settings <span class="text-zinc-400">/</span>{' '}
            <span class="font-normal text-zinc-600 dark:text-zinc-400">Remind Me</span>
          </h1>
          <p class="mt-1 text-xs text-zinc-500">
            Signed in as <span class="font-mono">{user.email}</span>
          </p>
        </div>
        <div class="flex items-center gap-2 text-sm">
          <ThemeToggle />
          <button
            type="button"
            onClick={onExit}
            class="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            ← Back to reminders
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void logout()}
            class="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Sign out
          </button>
        </div>
      </header>

      <section
        class="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
        aria-labelledby="settings-timezone-heading"
      >
        <h2 id="settings-timezone-heading" class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Timezone
        </h2>
        <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          New reminders default to this IANA timezone. Existing reminders keep their own timezone until you edit them.
        </p>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <input
            aria-label="Account timezone"
            list="settings-tz-options"
            value={timezoneInput}
            onInput={(e) => {
              setTzError(null);
              setTimezoneInput((e.currentTarget as HTMLInputElement).value);
            }}
            class="min-w-[16rem] flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-600 dark:bg-zinc-900"
            placeholder="e.g. America/Los_Angeles"
            autoCapitalize="off"
            autoCorrect="off"
            spellcheck={false}
          />
          <datalist id="settings-tz-options">
            {tzOptions().map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          <button
            type="button"
            disabled={tzBusy || !normalizedTz || !tzDirty}
            onClick={() => void saveTimezone()}
            class="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {tzBusy ? 'Saving…' : 'Save timezone'}
          </button>
        </div>
        {tzError && (
          <p class="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">
            {tzError}
          </p>
        )}
      </section>

      <PasskeysSection />
    </main>
  );
}
