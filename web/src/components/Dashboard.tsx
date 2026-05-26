import { useState } from 'preact/hooks';
import { type CurrentUser, api } from '../api';
import { TimezoneBanner } from './TimezoneBanner';

interface Props {
  user: CurrentUser;
  onUserChanged: (user: CurrentUser) => void;
  onLoggedOut: () => void;
}

export function Dashboard({ user, onUserChanged, onLoggedOut }: Props) {
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
    <main class="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-12">
      <header class="flex items-center justify-between">
        <h1 class="text-2xl font-semibold tracking-tight">Remind Me</h1>
        <div class="flex items-center gap-3 text-sm">
          <span class="text-zinc-600 dark:text-zinc-400">{user.email}</span>
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

      <section class="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-zinc-500 dark:border-zinc-700">
        <p class="text-sm">
          Your reminders will appear here once we ship the CRUD UI in the next milestone.
        </p>
      </section>
    </main>
  );
}
