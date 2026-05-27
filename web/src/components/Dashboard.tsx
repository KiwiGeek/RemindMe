import { useCallback, useEffect, useState } from 'preact/hooks';
import { type CurrentUser, type Reminder, api } from '../api';
import { ReminderForm } from './ReminderForm';
import { RemindersList } from './RemindersList';
import { ThemeToggle } from './ThemeToggle';
import { TimezoneBanner } from './TimezoneBanner';

interface Props {
  user: CurrentUser;
  onUserChanged: (user: CurrentUser) => void;
  onLoggedOut: () => void;
  /** Provided only when the signed-in user is an admin. */
  onEnterAdmin?: () => void;
  onEnterSettings: () => void;
}

type Mode = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; reminder: Reminder };

export function Dashboard({
  user,
  onUserChanged,
  onLoggedOut,
  onEnterAdmin,
  onEnterSettings,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listReminders();
      setReminders(res.reminders);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed to load');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
            Remind Me
          </h1>
          <p class="mt-0.5 max-w-md text-pretty text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Passwordless recurring email reminders — nothing to remember.
          </p>
          <p
            class="mt-2 truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400"
            title={user.email}
          >
            {user.email}
          </p>
        </div>
        <div class="-mr-1 flex max-w-full shrink-0 flex-nowrap items-center justify-end gap-2 self-start overflow-x-auto pb-0.5 pr-1 text-sm sm:pt-0.5">
          <ThemeToggle />
          <button type="button" onClick={onEnterSettings} class="ui-btn-secondary">
            Settings
          </button>
          {onEnterAdmin && (
            <button
              type="button"
              onClick={onEnterAdmin}
              class="inline-flex shrink-0 items-center justify-center rounded-lg border border-indigo-300/90 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-800 shadow-sm transition hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/90 dark:text-indigo-200 dark:hover:bg-indigo-900/80"
            >
              Admin
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void logout()}
            class="ui-btn-secondary shrink-0"
          >
            Sign out
          </button>
        </div>
      </header>

      {!user.tzConfirmed && <TimezoneBanner user={user} onConfirmed={onUserChanged} />}

      {mode.kind === 'list' && (
        <>
          <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 class="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Your reminders</h2>
              <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Upcoming sends are shown in your account timezone ({user.timezone}).
              </p>
            </div>
            <button
              type="button"
              onClick={() => setMode({ kind: 'new' })}
              class="ui-btn-primary shrink-0 self-start sm:self-auto"
            >
              + New reminder
            </button>
          </div>
          {loadError && (
            <p
              role="alert"
              class="rounded-xl border border-red-200/90 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/70 dark:bg-red-950/70 dark:text-red-200"
            >
              {loadError}
            </p>
          )}
          {reminders === null ? (
            <p class="text-sm text-zinc-500">Loading…</p>
          ) : (
            <RemindersList
              reminders={reminders}
              userTimezone={user.timezone}
              onEdit={(r) => setMode({ kind: 'edit', reminder: r })}
              onChanged={() => void refresh()}
            />
          )}
        </>
      )}

      {(mode.kind === 'new' || mode.kind === 'edit') && (
        <section class="ui-card">
          <h2 class="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            {mode.kind === 'new' ? 'New reminder' : `Edit "${mode.reminder.title}"`}
          </h2>
          <p class="mb-6 text-xs text-zinc-500 dark:text-zinc-400">
            {mode.kind === 'new'
              ? 'Title, schedule, and body — we send the next occurrence by email.'
              : 'Adjust the schedule or copy; changes apply from the next fire forward.'}
          </p>
          <ReminderForm
            user={user}
            existing={mode.kind === 'edit' ? mode.reminder : null}
            onSaved={() => {
              void refresh();
              setMode({ kind: 'list' });
            }}
            onCancel={() => setMode({ kind: 'list' })}
          />
        </section>
      )}
    </main>
  );
}
