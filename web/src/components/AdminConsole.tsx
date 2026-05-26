/**
 * Admin console — list users, create users, edit any user's reminders.
 *
 * State-based router rather than URL-based: simpler, and the underlying
 * `/api/admin/*` calls all carry the target user_id explicitly, so an
 * accidentally-shared link to `/admin` can never auto-target someone.
 */

import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  type AdminUser,
  ApiError,
  type CurrentUser,
  type Reminder,
  api,
  detectBrowserTimezone,
} from '../api';
import { ReminderForm, adminClient } from './ReminderForm';
import { RemindersList, adminListClient } from './RemindersList';

interface Props {
  admin: CurrentUser;
  onExit: () => void;
  onLoggedOut: () => void;
  onEnterSettings?: () => void;
}

type View =
  | { kind: 'users' }
  | { kind: 'create_user' }
  | { kind: 'user'; user: AdminUser; mode: UserMode };

type UserMode = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; reminder: Reminder };

export function AdminConsole({ admin, onExit, onLoggedOut, onEnterSettings }: Props) {
  const [view, setView] = useState<View>({ kind: 'users' });
  const [busy, setBusy] = useState(false);

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
    <main class="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-12">
      <header class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">
            Admin <span class="text-zinc-400">/</span>{' '}
            <span class="font-normal text-zinc-600 dark:text-zinc-400">Remind Me</span>
          </h1>
          <p class="mt-1 text-xs text-zinc-500">
            Signed in as <span class="font-mono">{admin.email}</span>
          </p>
        </div>
        <div class="flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={onExit}
            class="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            ← Back to my reminders
          </button>
          {onEnterSettings && (
            <button
              type="button"
              onClick={onEnterSettings}
              class="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Settings
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

      {view.kind === 'users' && (
        <UsersList
          onPick={(user) => setView({ kind: 'user', user, mode: { kind: 'list' } })}
          onCreate={() => setView({ kind: 'create_user' })}
        />
      )}

      {view.kind === 'create_user' && (
        <CreateUserPanel
          onCancel={() => setView({ kind: 'users' })}
          onCreated={(user) => setView({ kind: 'user', user, mode: { kind: 'list' } })}
        />
      )}

      {view.kind === 'user' && (
        <UserPanel
          target={view.user}
          mode={view.mode}
          onModeChange={(mode) => setView({ kind: 'user', user: view.user, mode })}
          onUserChanged={(u) => setView({ kind: 'user', user: u, mode: view.mode })}
          onBack={() => setView({ kind: 'users' })}
        />
      )}
    </main>
  );
}

// ---- users list ------------------------------------------------------------

function UsersList({
  onPick,
  onCreate,
}: {
  onPick: (u: AdminUser) => void;
  onCreate: () => void;
}) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    try {
      const res = await api.adminListUsers(q || undefined);
      setUsers(res.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  return (
    <>
      <div class="flex flex-wrap items-center gap-2">
        <input
          placeholder="Search by email…"
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if ((e as KeyboardEvent).key === 'Enter') void load(query);
          }}
          class="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="button"
          onClick={() => void load(query)}
          class="rounded-md border border-zinc-300 px-3 py-2 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Search
        </button>
        <button
          type="button"
          onClick={onCreate}
          class="rounded-md bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          + Create user
        </button>
      </div>

      {error && (
        <p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {users === null ? (
        <p class="text-sm text-zinc-500">Loading…</p>
      ) : users.length === 0 ? (
        <p class="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No users found.
        </p>
      ) : (
        <div class="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table class="w-full text-left text-sm">
            <thead class="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th class="px-3 py-2 font-medium">Email</th>
                <th class="px-3 py-2 font-medium">Timezone</th>
                <th class="px-3 py-2 font-medium">Status</th>
                <th class="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
              {users.map((u) => (
                <tr key={u.id}>
                  <td class="px-3 py-3 font-mono text-xs">{u.email}</td>
                  <td class="px-3 py-3 text-xs">{u.timezone}</td>
                  <td class="px-3 py-3 text-xs">
                    {u.status}
                    {!u.tzConfirmed && (
                      <span class="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                        tz unconfirmed
                      </span>
                    )}
                    {u.isAdmin && (
                      <span class="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] uppercase text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                        admin
                      </span>
                    )}
                  </td>
                  <td class="px-3 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onPick(u)}
                      class="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      Manage →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---- create user -----------------------------------------------------------

function CreateUserPanel({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (u: AdminUser) => void;
}) {
  const [email, setEmail] = useState('');
  const [timezone, setTimezone] = useState(detectBrowserTimezone());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await api.adminCreateUser({ email, timezone });
      onCreated(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(
          'A user with that email already exists. Go back and search for them in the list above.',
        );
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Something went wrong.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section class="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <h2 class="mb-1 text-lg font-medium">Create user</h2>
      <p class="mb-4 text-xs text-zinc-500">
        Pre-creates a row in the users table so you can attach reminders before the person has ever
        signed in. They'll claim the account on their first OTP sign-in.
      </p>
      <form onSubmit={submit} class="space-y-4">
        <div class="space-y-1">
          <label class="block text-sm font-medium" for="new-user-email">
            Email
          </label>
          <input
            id="new-user-email"
            type="email"
            required
            value={email}
            onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)}
            class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <div class="space-y-1">
          <label class="block text-sm font-medium" for="new-user-tz">
            Default timezone
          </label>
          <input
            id="new-user-tz"
            list="admin-tz-list"
            value={timezone}
            onInput={(e) => setTimezone((e.currentTarget as HTMLInputElement).value)}
            class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <datalist id="admin-tz-list">
            {tzOptions().map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          <p class="text-xs text-zinc-500">
            The user will be prompted to confirm or change this on first sign-in.
          </p>
        </div>
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
            disabled={saving || !email.trim()}
            class="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {saving ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </form>
    </section>
  );
}

// ---- single user panel ----------------------------------------------------

function UserPanel({
  target,
  mode,
  onModeChange,
  onUserChanged,
  onBack,
}: {
  target: AdminUser;
  mode: UserMode;
  onModeChange: (mode: UserMode) => void;
  onUserChanged: (u: AdminUser) => void;
  onBack: () => void;
}) {
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.adminListReminders(target.id);
      setReminders(res.reminders);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed to load');
    }
  }, [target.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <ActingAsBanner target={target} onBack={onBack} onUserChanged={onUserChanged} />

      {mode.kind === 'list' && (
        <>
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-medium">Reminders</h2>
            <button
              type="button"
              onClick={() => onModeChange({ kind: 'new' })}
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
              userTimezone={target.timezone}
              client={adminListClient(target.id)}
              onEdit={(r) => onModeChange({ kind: 'edit', reminder: r })}
              onChanged={() => void refresh()}
            />
          )}
        </>
      )}

      {(mode.kind === 'new' || mode.kind === 'edit') && (
        <section class="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h2 class="mb-4 text-lg font-medium">
            {mode.kind === 'new'
              ? `New reminder for ${target.email}`
              : `Edit "${mode.reminder.title}"`}
          </h2>
          <ReminderForm
            user={{ timezone: target.timezone }}
            existing={mode.kind === 'edit' ? mode.reminder : null}
            client={adminClient(target.id)}
            onSaved={() => {
              void refresh();
              onModeChange({ kind: 'list' });
            }}
            onCancel={() => onModeChange({ kind: 'list' })}
          />
        </section>
      )}
    </>
  );
}

function ActingAsBanner({
  target,
  onBack,
  onUserChanged,
}: {
  target: AdminUser;
  onBack: () => void;
  onUserChanged: (u: AdminUser) => void;
}) {
  const [editingTz, setEditingTz] = useState(false);
  const [tz, setTz] = useState(target.timezone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveTz() {
    setSaving(true);
    setError(null);
    try {
      const res = await api.adminUpdateUser(target.id, { timezone: tz });
      onUserChanged(res.user);
      setEditingTz(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="rounded-lg border border-indigo-300 bg-indigo-50 p-4 text-sm dark:border-indigo-800 dark:bg-indigo-950">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p class="text-xs uppercase text-indigo-600 dark:text-indigo-400">Acting as</p>
          <p class="font-mono text-base">{target.email}</p>
        </div>
        <button
          type="button"
          onClick={onBack}
          class="rounded-md border border-indigo-300 bg-white px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
        >
          ← All users
        </button>
      </div>
      <div class="mt-3 text-xs text-indigo-900 dark:text-indigo-200">
        Timezone:{' '}
        {editingTz ? (
          <span class="inline-flex items-center gap-2">
            <input
              list="admin-tz-list-banner"
              value={tz}
              onInput={(e) => setTz((e.currentTarget as HTMLInputElement).value)}
              class="rounded-md border border-indigo-300 bg-white px-2 py-1 font-mono text-xs dark:border-indigo-700 dark:bg-indigo-900"
            />
            <datalist id="admin-tz-list-banner">
              {tzOptions().map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <button
              type="button"
              disabled={saving}
              onClick={() => void saveTz()}
              class="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setTz(target.timezone);
                setEditingTz(false);
                setError(null);
              }}
              class="text-xs text-indigo-700 underline dark:text-indigo-300"
            >
              Cancel
            </button>
          </span>
        ) : (
          <span class="inline-flex items-center gap-2 font-mono">
            {target.timezone}
            <button
              type="button"
              onClick={() => setEditingTz(true)}
              class="text-xs text-indigo-700 underline dark:text-indigo-300"
            >
              change
            </button>
          </span>
        )}
        {error && <span class="ml-2 text-red-700 dark:text-red-300">{error}</span>}
      </div>
    </div>
  );
}

function tzOptions(): string[] {
  type IntlExt = typeof Intl & { supportedValuesOf?: (k: 'timeZone') => string[] };
  return (Intl as IntlExt).supportedValuesOf?.('timeZone') ?? ['UTC'];
}
