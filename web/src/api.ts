export interface CurrentUser {
  id: number;
  email: string;
  timezone: string;
  tzConfirmed: boolean;
  status: 'active' | 'suspended';
  isAdmin: boolean;
}

/** Admin-facing view of any user. Same shape as `CurrentUser` — see `presentUser`. */
export type AdminUser = CurrentUser;

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

export interface Passkey {
  id: number;
  nickname: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  transports?: string[];
}

/**
 * Server returns the raw output of @simplewebauthn/server's
 * `generateRegistrationOptions` / `generateAuthenticationOptions` — JSON
 * shaped to match what `@simplewebauthn/browser` expects as input.
 */
export type WebAuthnOptions = Record<string, unknown>;

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

  // ---- passkeys -----------------------------------------------------------
  listPasskeys: () => call<{ passkeys: Passkey[] }>('/api/passkeys'),
  passkeyRegisterOptions: (nickname?: string) =>
    call<{ options: WebAuthnOptions }>('/api/passkeys/register/options', {
      method: 'POST',
      body: JSON.stringify({ nickname }),
    }),
  passkeyRegisterVerify: (response: unknown, nickname?: string) =>
    call<{ passkey: Passkey }>('/api/passkeys/register/verify', {
      method: 'POST',
      body: JSON.stringify({ response, nickname }),
    }),
  passkeyAuthOptions: () =>
    call<{ options: WebAuthnOptions }>('/api/passkeys/auth/options', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  passkeyAuthVerify: (response: unknown) =>
    call<{ user: CurrentUser }>('/api/passkeys/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ response }),
    }),
  passkeyRename: (id: number, nickname: string) =>
    call<{ passkey: Passkey }>(`/api/passkeys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ nickname }),
    }),
  passkeyDelete: (id: number) => call<void>(`/api/passkeys/${id}`, { method: 'DELETE' }),

  // ---- admin --------------------------------------------------------------
  adminListUsers: (q?: string) =>
    call<{ users: AdminUser[] }>(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  adminGetUser: (id: number) => call<{ user: AdminUser }>(`/api/admin/users/${id}`),
  adminCreateUser: (input: { email: string; timezone?: string }) =>
    call<{ user: AdminUser }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  adminUpdateUser: (id: number, patch: { timezone?: string }) =>
    call<{ user: AdminUser }>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  adminListReminders: (userId: number) =>
    call<{ reminders: Reminder[] }>(`/api/admin/users/${userId}/reminders`),
  adminCreateReminder: (userId: number, input: ReminderInput) =>
    call<{ reminder: Reminder }>(`/api/admin/users/${userId}/reminders`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  adminUpdateReminder: (
    userId: number,
    rid: number,
    patch: Partial<ReminderInput> & { status?: ReminderStatus },
  ) =>
    call<{ reminder: Reminder }>(`/api/admin/users/${userId}/reminders/${rid}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  adminDeleteReminder: (userId: number, rid: number) =>
    call<void>(`/api/admin/users/${userId}/reminders/${rid}`, { method: 'DELETE' }),
  adminPreviewReminder: (userId: number, input: PreviewInput) =>
    call<PreviewResult>(`/api/admin/users/${userId}/reminders/preview`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};

export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}
