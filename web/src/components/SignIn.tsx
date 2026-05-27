import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useEffect, useState } from 'preact/hooks';
import { ApiError, type CurrentUser, api } from '../api';
import { SHORT_SHA, commitUrl, formatBuildTimestamp } from '../buildInfo';
import { ThemeToggle } from './ThemeToggle';

type Stage = 'email' | 'code';

interface Props {
  onSignedIn: (user: CurrentUser) => void;
}

export function SignIn({ onSignedIn }: Props) {
  const [stage, setStage] = useState<Stage>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeySupported, setPasskeySupported] = useState(false);

  useEffect(() => {
    setPasskeySupported(browserSupportsWebAuthn());
  }, []);

  async function signInWithPasskey() {
    setError(null);
    setPasskeyBusy(true);
    try {
      const { options } = await api.passkeyAuthOptions();
      const response = await startAuthentication({
        optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'],
      });
      const { user } = await api.passkeyAuthVerify(response);
      onSignedIn(user);
    } catch (err) {
      // User cancellation is benign — silently bail without showing an error.
      if (
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'AbortError')
      ) {
        return;
      }
      setError(humaniseError(err, "Couldn't sign in with a passkey. Try the email code instead."));
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function submitEmail(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.requestCode(email);
      setStage('code');
    } catch (err) {
      setError(humaniseError(err, 'Could not send code. Try again?'));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { user } = await api.verifyCode(email, code);
      onSignedIn(user);
    } catch (err) {
      setError(humaniseError(err, 'That code did not work. Try again?'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="mx-auto flex min-h-screen max-w-md flex-col px-6 py-12">
      {/* Centered sign-in column. `flex-1` pushes the footer to the
          page bottom while keeping the form vertically centred. */}
      <div class="flex flex-1 flex-col justify-center gap-8">
        <div class="ui-card shadow-xl shadow-zinc-950/10 dark:shadow-black/50">
          <header class="flex items-start justify-between gap-3 border-b border-zinc-200/80 pb-5 dark:border-zinc-800/90">
            <div class="space-y-2">
              <h1 class="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                Remind Me
              </h1>
              <p class="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                Sign in with your email. We&apos;ll send you a one-time code — no password needed.
              </p>
            </div>
            <ThemeToggle />
          </header>

          <div class="space-y-6 pt-6">
            {stage === 'email' && (
              <div class="space-y-4">
                {passkeySupported && (
                  <>
                    <button
                      type="button"
                      onClick={() => void signInWithPasskey()}
                      disabled={passkeyBusy}
                      class="w-full rounded-lg border border-zinc-300/90 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 shadow-sm transition hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/80"
                    >
                      {passkeyBusy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
                    </button>
                    <div class="flex items-center gap-3 text-xs font-medium text-zinc-400">
                      <span class="h-px flex-1 bg-gradient-to-r from-transparent via-zinc-200 to-transparent dark:via-zinc-700" />
                      <span class="text-zinc-400">or</span>
                      <span class="h-px flex-1 bg-gradient-to-r from-transparent via-zinc-200 to-transparent dark:via-zinc-700" />
                    </div>
                  </>
                )}
                <form onSubmit={submitEmail} class="space-y-3">
                  <label class="block text-sm font-semibold text-zinc-700 dark:text-zinc-300" for="email-input">
                    Email
                  </label>
                  <input
                    id="email-input"
                    type="email"
                    required
                    autoComplete="email webauthn"
                    value={email}
                    onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)}
                    class="w-full rounded-xl border border-zinc-300/90 bg-white px-3 py-2.5 text-base shadow-inner shadow-zinc-900/5 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400/40 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-400 dark:focus:ring-zinc-600/35"
                    placeholder="you@example.com"
                  />
                  <button type="submit" disabled={busy || !email} class="ui-btn-primary w-full py-2.5 disabled:pointer-events-none">
                    {busy ? 'Sending…' : 'Send me a code'}
                  </button>
                </form>
              </div>
            )}

            {stage === 'code' && (
              <form onSubmit={submitCode} class="space-y-3">
                <p class="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  We sent a 6-digit code to <span class="font-semibold text-zinc-800 dark:text-zinc-200">{email}</span>.
                  Check your inbox (and spam folder).
                </p>
                <label class="block text-sm font-semibold text-zinc-700 dark:text-zinc-300" for="code-input">
                  Code
                </label>
                <input
                  id="code-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onInput={(e) =>
                    setCode((e.currentTarget as HTMLInputElement).value.replace(/\D/g, ''))
                  }
                  class="w-full rounded-xl border border-zinc-300/90 bg-white px-3 py-2.5 text-center font-mono text-2xl tracking-[0.4em] shadow-inner shadow-zinc-900/5 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400/40 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-400 dark:focus:ring-zinc-600/35"
                  placeholder="000000"
                />
                <div class="flex gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setStage('email');
                      setCode('');
                      setError(null);
                    }}
                    class="ui-btn-secondary flex-1 py-2.5"
                  >
                    Use a different email
                  </button>
                  <button
                    type="submit"
                    disabled={busy || code.length !== 6}
                    class="ui-btn-primary flex-1 py-2.5 disabled:pointer-events-none"
                  >
                    {busy ? 'Checking…' : 'Sign in'}
                  </button>
                </div>
              </form>
            )}

            {error && (
              <p
                role="alert"
                class="rounded-xl border border-red-200/90 bg-red-50 px-3 py-2.5 text-sm text-red-800 dark:border-red-900/70 dark:bg-red-950/70 dark:text-red-200"
              >
                {error}
              </p>
            )}
          </div>
        </div>
      </div>

      <footer class="pt-12 text-center text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-600">
        <p>
          Build <BuildSha /> · {formatBuildTimestamp()}
        </p>
        <p class="mt-1">No warranties implied. Use at your own risk.</p>
      </footer>
    </section>
  );
}

/**
 * The short build SHA. Linked to its GitHub commit page when the build
 * came from a real commit; rendered as plain text for local "dev"
 * builds where no public URL exists. The link will 404 until the repo
 * is made public, but it's wired up so we don't have to remember
 * later — externalising is just a `gh repo edit --visibility public`
 * away.
 */
function BuildSha() {
  const url = commitUrl();
  if (!url) {
    return <code class="font-mono">{SHORT_SHA}</code>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      class="font-mono underline-offset-2 hover:underline focus:underline focus:outline-none"
    >
      {SHORT_SHA}
    </a>
  );
}

function humaniseError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    switch (err.message) {
      case 'too_many_attempts':
        return 'Too many wrong codes. Request a new one.';
      case 'invalid_or_expired':
        return 'That code is wrong or has expired.';
      default:
        return fallback;
    }
  }
  return fallback;
}
