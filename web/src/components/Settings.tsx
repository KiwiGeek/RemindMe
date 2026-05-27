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
  const tzDirty = normalizedTz !== user.timezone || !user.tzConfirmed;

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
    <main class="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
      <header class="ui-header">
        <div class="min-w-0 flex-1">
          <h1 class="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Settings <span class="text-zinc-400 dark:text-zinc-500">/</span>{' '}
            <span class="font-normal text-zinc-600 dark:text-zinc-400">Remind Me</span>
          </h1>
          <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Signed in as{' '}
            <span class="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-700/80">
              {user.email}
            </span>
          </p>
        </div>
        <div class="-mr-1 flex max-w-full shrink-0 flex-nowrap items-center gap-2 self-start overflow-x-auto pb-0.5 pr-1 text-sm sm:pt-0.5">
          <ThemeToggle />
          <button type="button" onClick={onExit} class="ui-btn-secondary">
            ← Back to reminders
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void logout()}
            class="ui-btn-secondary"
          >
            Sign out
          </button>
        </div>
      </header>

      <section class="ui-card" aria-labelledby="settings-timezone-heading">
        <h2
          id="settings-timezone-heading"
          class="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Timezone
        </h2>
        <p class="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
          New reminders default to this IANA timezone. Existing reminders keep their own timezone
          until you edit them.
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
            class="min-w-[16rem] flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm shadow-inner shadow-zinc-900/5 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400/35 dark:border-zinc-600 dark:bg-zinc-900 dark:focus:border-zinc-400 dark:focus:ring-zinc-600/40"
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
            class="ui-btn-primary disabled:pointer-events-none"
          >
            {tzBusy ? 'Saving…' : 'Save timezone'}
          </button>
        </div>
        {tzError && (
          <p class="mt-3 text-xs text-red-700 dark:text-red-300" role="alert">
            {tzError}
          </p>
        )}
      </section>

      <PasskeysSection />
    </main>
  );
}
