import { DateTime } from 'luxon';
import { useState } from 'preact/hooks';
import { type Reminder, type ReminderStatus, api } from '../api';

/** Same shape as the admin/self distinction in `ReminderForm`. */
export interface RemindersListClient {
  setStatus: (id: number, status: ReminderStatus) => Promise<unknown>;
  remove: (id: number) => Promise<unknown>;
}

export const selfListClient: RemindersListClient = {
  setStatus: (id, status) => api.updateReminder(id, { status }),
  remove: (id) => api.deleteReminder(id),
};

export function adminListClient(userId: number): RemindersListClient {
  return {
    setStatus: (id, status) => api.adminUpdateReminder(userId, id, { status }),
    remove: (id) => api.adminDeleteReminder(userId, id),
  };
}

interface Props {
  reminders: Reminder[];
  userTimezone: string;
  onEdit: (r: Reminder) => void;
  onChanged: () => void;
  client?: RemindersListClient;
}

export function RemindersList({
  reminders,
  userTimezone,
  onEdit,
  onChanged,
  client = selfListClient,
}: Props) {
  const [busyId, setBusyId] = useState<number | null>(null);

  async function togglePause(r: Reminder) {
    setBusyId(r.id);
    try {
      await client.setStatus(r.id, r.status === 'paused' ? 'active' : 'paused');
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  async function reactivate(r: Reminder) {
    setBusyId(r.id);
    try {
      // PATCH to 'active' triggers the server to skip past any missed
      // occurrences so the user doesn't get a flood of backdated emails.
      await client.setStatus(r.id, 'active');
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(r: Reminder) {
    if (!confirm(`Delete "${r.title}"? This cannot be undone.`)) return;
    setBusyId(r.id);
    try {
      await client.remove(r.id);
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  if (reminders.length === 0) {
    return (
      <div class="rounded-2xl border border-dashed border-zinc-300/90 bg-white/70 px-8 py-12 text-center shadow-sm dark:border-zinc-700 dark:bg-zinc-950/60">
        <p class="text-2xl" aria-hidden="true">
          🔔
        </p>
        <p class="mt-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">No reminders yet</p>
        <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Use <span class="font-semibold text-zinc-600 dark:text-zinc-300">New reminder</span> above to
          set up your first schedule.
        </p>
      </div>
    );
  }

  return (
      <div class="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-md shadow-zinc-950/5 dark:border-zinc-800/90 dark:bg-zinc-950/90 dark:shadow-black/40">
        <table class="w-full text-left text-sm">
          <thead class="bg-zinc-50/95 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/95 dark:text-zinc-400">
          <tr>
            <th scope="col" class="px-4 py-3 font-semibold">
              Reminder
            </th>
            <th scope="col" class="px-4 py-3 font-semibold">
              Next
            </th>
            <th scope="col" class="px-4 py-3 font-semibold">
              Status
            </th>
            <th scope="col" class="px-4 py-3 font-semibold">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-100 dark:divide-zinc-800/90">
          {reminders.map((r) => (
            <tr key={r.id} class="transition-colors hover:bg-zinc-50/90 dark:hover:bg-zinc-900/40">
              <td class="px-4 py-4">
                <div class="font-medium text-zinc-900 dark:text-zinc-100">{r.title}</div>
                <div class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{r.summary}</div>
              </td>
              <td class="px-4 py-4 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                {formatNext(r.nextFireAt, userTimezone)}
              </td>
              <td class="px-4 py-4">
                <StatusPill status={r.status} />
              </td>
              <td class="px-4 py-4 text-right">
                <div class="inline-flex flex-wrap justify-end gap-1.5">
                  {r.status === 'suspended' ? (
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => void reactivate(r)}
                      aria-label={`Reactivate ${r.title}`}
                      class="inline-flex items-center justify-center rounded-lg border border-emerald-400/40 bg-emerald-50/95 px-2.5 py-1 text-xs font-medium text-emerald-800 shadow-sm transition hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-200 dark:hover:bg-emerald-900/60"
                    >
                      Reactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === r.id || r.status === 'completed'}
                      onClick={() => void togglePause(r)}
                      aria-label={`${r.status === 'paused' ? 'Resume' : 'Pause'} ${r.title}`}
                      class="ui-btn-secondary-sm"
                    >
                      {r.status === 'paused' ? 'Resume' : 'Pause'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onEdit(r)}
                    aria-label={`Edit ${r.title}`}
                    class="ui-btn-secondary-sm"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busyId === r.id}
                    onClick={() => void remove(r)}
                    aria-label={`Delete ${r.title}`}
                    class="inline-flex items-center justify-center rounded-lg border border-red-400/35 bg-white px-2.5 py-1 text-xs font-medium text-red-700 shadow-sm transition hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950/50"
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: Reminder['status'] }) {
  const palette: Record<Reminder['status'], string> = {
    active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    paused: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    completed: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400',
    suspended: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    deleted: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
  };
  return (
    <span class={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${palette[status]}`}>
      {status}
    </span>
  );
}

function formatNext(iso: string | null, tz: string): string {
  if (!iso) return '—';
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz);
  if (!dt.isValid) return iso;
  return dt.toFormat('ccc, d LLL yyyy h:mm a ZZZZ');
}
