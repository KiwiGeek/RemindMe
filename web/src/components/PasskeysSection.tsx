/**
 * Manage the signed-in user's passkeys (list, add, rename, remove).
 *
 * Passkeys are an opt-in convenience on top of email OTP. We deliberately
 * never gate any feature behind "must have a passkey" — the user can always
 * fall back to OTP, so deleting their last passkey is not destructive.
 */

import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startRegistration,
} from '@simplewebauthn/browser';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { ApiError, type Passkey, api } from '../api';

export function PasskeysSection() {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  const [platformAvailable, setPlatformAvailable] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listPasskeys();
      setPasskeys(res.passkeys);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    }
  }, []);

  useEffect(() => {
    if (!browserSupportsWebAuthn()) {
      setSupported(false);
      setPasskeys([]);
      return;
    }
    platformAuthenticatorIsAvailable()
      .then((ok) => setPlatformAvailable(ok))
      .catch(() => setPlatformAvailable(false));
    void refresh();
  }, [refresh]);

  async function addPasskey() {
    setError(null);
    setBusy(true);
    try {
      const { options } = await api.passkeyRegisterOptions();
      const response = await startRegistration({
        optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'],
      });
      await api.passkeyRegisterVerify(response);
      await refresh();
    } catch (err) {
      setError(humanizeError(err, 'register'));
    } finally {
      setBusy(false);
    }
  }

  async function rename(p: Passkey) {
    const next = prompt('New nickname for this passkey', p.nickname ?? '');
    if (next === null) return;
    setBusy(true);
    try {
      await api.passkeyRename(p.id, next);
      await refresh();
    } catch (err) {
      setError(humanizeError(err, 'rename'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Passkey) {
    if (
      !confirm(`Remove passkey "${p.nickname ?? 'unnamed'}"? You can still sign in with email.`)
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.passkeyDelete(p.id);
      await refresh();
    } catch (err) {
      setError(humanizeError(err, 'delete'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="ui-card">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 class="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Passkeys</h2>
          <p class="mt-1 text-xs text-zinc-500">
            Optional. Email sign-in keeps working even if you remove all passkeys.
          </p>
        </div>
        {supported && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void addPasskey()}
            class="ui-btn-primary w-full shrink-0 sm:w-auto disabled:pointer-events-none"
          >
            + Add a passkey
          </button>
        )}
      </div>

      {!supported && (
        <p class="mt-4 text-sm text-zinc-500">
          This browser doesn't support passkeys. You can still sign in with an email code.
        </p>
      )}

      {supported && platformAvailable === false && passkeys && passkeys.length === 0 && (
        <p class="mt-4 text-xs text-zinc-500">
          No platform authenticator detected. You can still register a security key (USB or NFC).
        </p>
      )}

      {error && (
        <p
          role="alert"
          class="mt-4 rounded-xl border border-red-200/90 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/70 dark:bg-red-950/70 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {supported && passkeys !== null && passkeys.length > 0 && (
        <ul class="mt-4 divide-y divide-zinc-200 dark:divide-zinc-800">
          {passkeys.map((p) => (
            <li key={p.id} class="flex items-center justify-between gap-3 py-3">
              <div>
                <p class="text-sm font-medium">{p.nickname || '(unnamed)'}</p>
                <p class="text-xs text-zinc-500">
                  Added {formatDate(p.createdAt)}
                  {p.lastUsedAt && <span> · last used {formatDate(p.lastUsedAt)}</span>}
                  {p.transports && p.transports.length > 0 && (
                    <span> · {p.transports.join(', ')}</span>
                  )}
                </p>
              </div>
              <div class="flex gap-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void rename(p)}
                  class="ui-btn-secondary-sm"
                >
                  Rename
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(p)}
                  class="inline-flex items-center justify-center rounded-lg border border-red-400/35 bg-white px-2 py-1 text-xs font-medium text-red-700 shadow-sm transition hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950/50"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {supported && passkeys !== null && passkeys.length === 0 && (
        <p class="mt-4 rounded-xl border border-dashed border-zinc-300/90 bg-zinc-50/50 p-4 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/30 dark:text-zinc-400">
          No passkeys yet. Add one to sign in with Touch ID, Windows Hello, or your password
          manager.
        </p>
      )}
    </section>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function humanizeError(err: unknown, op: 'register' | 'rename' | 'delete'): string {
  // The browser API surfaces user cancellation as a DOMException; treat it
  // as benign — don't make a "failed!" toast for a deliberate cancel.
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      return 'Cancelled.';
    }
    return `${err.name}: ${err.message}`;
  }
  if (err instanceof ApiError) {
    switch (err.message) {
      case 'limit_reached':
        return 'You already have the maximum number of passkeys.';
      case 'already_registered':
        return 'That passkey is already registered.';
      case 'challenge_expired':
        return 'Took too long — please try again.';
      case 'verification_failed':
        return 'The browser response failed verification. Please try again.';
      default:
        return `Couldn't ${op}: ${err.message}`;
    }
  }
  return `Couldn't ${op} the passkey.`;
}
