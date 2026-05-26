/**
 * Account settings — currently houses passkey management. Designed as a
 * separate top-level view (rather than a modal) so additional settings
 * — timezone editing, account deletion, notification preferences — can
 * land here later without needing a re-layout.
 */

import { useState } from 'preact/hooks';
import { type CurrentUser, api } from '../api';
import { PasskeysSection } from './PasskeysSection';

interface Props {
  user: CurrentUser;
  onExit: () => void;
  onLoggedOut: () => void;
}

export function Settings({ user, onExit, onLoggedOut }: Props) {
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

      <PasskeysSection />
    </main>
  );
}
