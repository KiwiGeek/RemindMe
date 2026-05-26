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
};

export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}
