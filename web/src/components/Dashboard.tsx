import { useCallback, useEffect, useState } from 'preact/hooks';
import { type CurrentUser, type Reminder, api } from '../api';
import { PasskeysSection } from './PasskeysSection';
import { ReminderForm } from './ReminderForm';
import { RemindersList } from './RemindersList';
import { TimezoneBanner } from './TimezoneBanner';

interface Props {
  user: CurrentUser;
  onUserChanged: (user: CurrentUser) => void;
  onLoggedOut: () => void;
  /** Provided only when the signed-in user is an admin. */
  onEnterAdmin?: () => void;
}

type Mode = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; reminder: Reminder };

export function Dashboard({ user, onUserChanged, onLoggedOut, onEnterAdmin }: Props) {
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
    <main class="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
      <header class="flex items-center justify-between">
        <h1 class="text-2xl font-semibold tracking-tight">Remind Me</h1>
        <div class="flex items-center gap-3 text-sm">
          <span class="text-zinc-600 dark:text-zinc-400">{user.email}</span>
          {onEnterAdmin && (
            <button
              type="button"
              onClick={onEnterAdmin}
              class="rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900"
            >
              Admin
            </button>
          )}
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

      {!user.tzConfirmed && <TimezoneBanner user={user} onConfirmed={onUserChanged} />}

      {mode.kind === 'list' && (
        <>
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-medium">Your reminders</h2>
            <button
              type="button"
              onClick={() => setMode({ kind: 'new' })}
              class="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            >
              + New reminder
            </button>
          </div>
          {loadError && (
            <p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
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
          <PasskeysSection />
        </>
      )}

      {(mode.kind === 'new' || mode.kind === 'edit') && (
        <section class="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h2 class="mb-4 text-lg font-medium">
            {mode.kind === 'new' ? 'New reminder' : `Edit "${mode.reminder.title}"`}
          </h2>
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
