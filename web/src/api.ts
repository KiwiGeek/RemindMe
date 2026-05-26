export interface CurrentUser {
  id: number;
  email: string;
  timezone: string;
  tzConfirmed: boolean;
  status: 'active' | 'suspended';
}

interface ErrorBody {
  error?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 204) {
    return undefined as T;
  }
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T & ErrorBody) : ({} as T & ErrorBody);
  if (!res.ok) {
    throw new ApiError(body.error ?? `request_failed_${res.status}`, res.status);
  }
  return body;
}

export type ReminderStatus = 'active' | 'paused' | 'completed' | 'suspended' | 'deleted';

export interface Reminder {
  id: number;
  title: string;
  bodyMd: string;
  rrule: string;
  summary: string;
  dtstart: string;
  timezone: string;
  nextFireAt: string | null;
  remainingCount: number | null;
  status: ReminderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReminderEnds {
  kind: 'never' | 'after_count';
  afterCount?: number;
}

export interface ReminderInput {
  title: string;
  bodyMd: string;
  rrule: string;
  dtstart: string;
  timezone?: string;
  ends: ReminderEnds;
}

export interface PreviewInput {
  title?: string;
  bodyMd?: string;
  rrule: string;
  dtstart: string;
  timezone: string;
  count?: number;
}

export interface PreviewResult {
  fires: string[];
  summary: string;
  sample: {
    subject: string;
    textBody: string;
    htmlBody: string;
  } | null;
}

export interface TemplateVariable {
  name: string;
  description: string;
}

export const api = {
  me: () => call<{ user: CurrentUser }>('/api/me'),
  requestCode: (email: string) =>
    call<void>('/api/auth/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  verifyCode: (email: string, code: string) =>
    call<{ user: CurrentUser }>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),
  logout: () => call<void>('/api/auth/logout', { method: 'POST' }),
  updateMe: (patch: { timezone?: string; tzConfirmed?: boolean }) =>
    call<{ user: CurrentUser }>('/api/me', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  listReminders: () => call<{ reminders: Reminder[] }>('/api/reminders'),
  getReminder: (id: number) => call<{ reminder: Reminder }>(`/api/reminders/${id}`),
  createReminder: (input: ReminderInput) =>
    call<{ reminder: Reminder }>('/api/reminders', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateReminder: (id: number, patch: Partial<ReminderInput> & { status?: ReminderStatus }) =>
    call<{ reminder: Reminder }>(`/api/reminders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteReminder: (id: number) => call<void>(`/api/reminders/${id}`, { method: 'DELETE' }),
  previewReminder: (input: PreviewInput) =>
    call<PreviewResult>('/api/reminders/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  templateVariables: () =>
    call<{ variables: TemplateVariable[] }>('/api/reminders/template-variables'),
};

export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}
