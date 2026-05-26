import { DateTime } from 'luxon';
import { useState } from 'preact/hooks';
import { type Reminder, api } from '../api';

interface Props {
  reminders: Reminder[];
  userTimezone: string;
  onEdit: (r: Reminder) => void;
  onChanged: () => void;
}

export function RemindersList({ reminders, userTimezone, onEdit, onChanged }: Props) {
  const [busyId, setBusyId] = useState<number | null>(null);

  async function togglePause(r: Reminder) {
    setBusyId(r.id);
    try {
      await api.updateReminder(r.id, {
        status: r.status === 'paused' ? 'active' : 'paused',
      });
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(r: Reminder) {
    if (!confirm(`Delete "${r.title}"? This cannot be undone.`)) return;
    setBusyId(r.id);
    try {
      await api.deleteReminder(r.id);
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  if (reminders.length === 0) {
    return (
      <div class="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-zinc-500 dark:border-zinc-700">
        <p class="text-sm">No reminders yet — create your first one above.</p>
      </div>
    );
  }

  return (
    <div class="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table class="w-full text-left text-sm">
        <thead class="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900">
          <tr>
            <th class="px-3 py-2 font-medium">Reminder</th>
            <th class="px-3 py-2 font-medium">Next</th>
            <th class="px-3 py-2 font-medium">Status</th>
            <th class="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
          {reminders.map((r) => (
            <tr key={r.id}>
              <td class="px-3 py-3">
                <div class="font-medium">{r.title}</div>
                <div class="text-xs text-zinc-500">{r.summary}</div>
              </td>
              <td class="px-3 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                {formatNext(r.nextFireAt, userTimezone)}
              </td>
              <td class="px-3 py-3">
                <StatusPill status={r.status} />
              </td>
              <td class="px-3 py-3 text-right">
                <div class="inline-flex gap-1">
                  <button
                    type="button"
                    disabled={
                      busyId === r.id || r.status === 'completed' || r.status === 'suspended'
                    }
                    onClick={() => void togglePause(r)}
                    class="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    {r.status === 'paused' ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onEdit(r)}
                    class="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busyId === r.id}
                    onClick={() => void remove(r)}
                    class="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
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
    <span class={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${palette[status]}`}>
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
