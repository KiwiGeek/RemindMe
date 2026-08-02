import { useEffect, useState } from 'preact/hooks';
import { ApiError, type SetupInput, api, detectBrowserTimezone } from '../api';

interface Props {
  onCompleted: () => void;
}

export function SetupWizard({ onCompleted }: Props) {
  const [mode, setMode] = useState<'wizard' | 'import'>('wizard');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [smtpAllowed, setSmtpAllowed] = useState(false);
  const [form, setForm] = useState<SetupInput>({
    setupToken: '',
    adminEmail: '',
    timezone: detectBrowserTimezone(),
    appName: 'Remind Me',
    siteOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    mailProvider: 'mailgun',
    mailgunRegion: 'us',
    mailgunDomain: '',
    mailgunFrom: '',
    mailgunReplyTo: '',
    mailgunApiKey: '',
    mailgunSigningKey: '',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpPass: '',
    registrationMode: 'open',
  });
  const [passphrase, setPassphrase] = useState('');
  const [bundleText, setBundleText] = useState('');

  useEffect(() => {
    void api
      .setupStatus()
      .then((r) => setSmtpAllowed(r.smtpAllowed))
      .catch(() => setSmtpAllowed(false));
  }, []);

  function set<K extends keyof SetupInput>(key: K, value: SetupInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submitWizard(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setupComplete(form);
      onCompleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitImport(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bundle = JSON.parse(bundleText) as unknown;
      const pass = passphrase.trim();
      await api.setupImport({
        setupToken: form.setupToken,
        bundle,
        ...(pass ? { passphrase: pass } : {}),
      });
      onCompleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-6 py-12">
      <header>
        <h1 class="text-3xl font-semibold tracking-tight">Set up Remind Me</h1>
        <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Enter your setup token and mail details, or import an export from another instance (plain
          JSON or passphrase-wrapped).
        </p>
      </header>

      <div class="flex gap-2 text-sm">
        <button
          type="button"
          class={`rounded-md px-3 py-1 ${mode === 'wizard' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'border border-zinc-300 dark:border-zinc-700'}`}
          onClick={() => setMode('wizard')}
        >
          Fresh setup
        </button>
        <button
          type="button"
          class={`rounded-md px-3 py-1 ${mode === 'import' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'border border-zinc-300 dark:border-zinc-700'}`}
          onClick={() => setMode('import')}
        >
          Import backup
        </button>
      </div>

      {error && (
        <p
          role="alert"
          class="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {mode === 'wizard' ? (
        <form class="flex flex-col gap-3" onSubmit={(e) => void submitWizard(e)}>
          <Field
            label="Setup token"
            value={form.setupToken}
            onInput={(v) => set('setupToken', v)}
            required
          />
          <Field
            label="Admin email"
            type="email"
            value={form.adminEmail}
            onInput={(v) => set('adminEmail', v)}
            required
          />
          <Field
            label="App name"
            value={form.appName}
            onInput={(v) => set('appName', v)}
            required
          />
          <Field
            label="Public site origin"
            value={form.siteOrigin}
            onInput={(v) => set('siteOrigin', v)}
            required
          />
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Registration</span>
            <select
              class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
              value={form.registrationMode}
              onChange={(e) =>
                set('registrationMode', (e.target as HTMLSelectElement).value as 'open' | 'closed')
              }
            >
              <option value="open">Open — anyone can self-register</option>
              <option value="closed">Closed — only existing users</option>
            </select>
          </label>

          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Mail provider</span>
            <select
              class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
              value={form.mailProvider}
              onChange={(e) =>
                set('mailProvider', (e.target as HTMLSelectElement).value as 'mailgun' | 'smtp')
              }
            >
              <option value="mailgun">Mailgun</option>
              <option value="smtp" disabled={!smtpAllowed}>
                SMTP{smtpAllowed ? '' : ' (Docker/Node only)'}
              </option>
            </select>
          </label>

          <Field
            label="From"
            value={form.mailgunFrom}
            onInput={(v) => set('mailgunFrom', v)}
            required
          />
          <Field
            label="Reply-To"
            value={form.mailgunReplyTo}
            onInput={(v) => set('mailgunReplyTo', v)}
            required
          />

          {form.mailProvider === 'mailgun' ? (
            <>
              <label class="flex flex-col gap-1 text-sm">
                <span class="font-medium">Mailgun region</span>
                <select
                  class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
                  value={form.mailgunRegion}
                  onChange={(e) =>
                    set('mailgunRegion', (e.target as HTMLSelectElement).value as 'us' | 'eu')
                  }
                >
                  <option value="us">US</option>
                  <option value="eu">EU</option>
                </select>
              </label>
              <Field
                label="Mailgun domain"
                value={form.mailgunDomain}
                onInput={(v) => set('mailgunDomain', v)}
                required
              />
              <Field
                label="Mailgun API key"
                value={form.mailgunApiKey}
                onInput={(v) => set('mailgunApiKey', v)}
                required
              />
              <Field
                label="Mailgun signing key"
                value={form.mailgunSigningKey}
                onInput={(v) => set('mailgunSigningKey', v)}
                required
              />
            </>
          ) : (
            <>
              <Field
                label="SMTP host"
                value={form.smtpHost}
                onInput={(v) => set('smtpHost', v)}
                required
              />
              <label class="flex flex-col gap-1 text-sm">
                <span class="font-medium">SMTP port</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
                  value={form.smtpPort}
                  onInput={(e) =>
                    set('smtpPort', Number((e.target as HTMLInputElement).value) || 587)
                  }
                />
              </label>
              <label class="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.smtpSecure}
                  onChange={(e) => set('smtpSecure', (e.target as HTMLInputElement).checked)}
                />
                <span>TLS/SSL (secure)</span>
              </label>
              <Field label="SMTP user" value={form.smtpUser} onInput={(v) => set('smtpUser', v)} />
              <Field
                label="SMTP password"
                type="password"
                value={form.smtpPass}
                onInput={(v) => set('smtpPass', v)}
              />
            </>
          )}

          <button
            type="submit"
            disabled={busy}
            class="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy ? 'Saving…' : 'Complete setup'}
          </button>
        </form>
      ) : (
        <form class="flex flex-col gap-3" onSubmit={(e) => void submitImport(e)}>
          <Field
            label="Setup token"
            value={form.setupToken}
            onInput={(v) => set('setupToken', v)}
            required
          />
          <Field
            label="Export passphrase (if encrypted)"
            type="password"
            value={passphrase}
            onInput={setPassphrase}
          />
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Export JSON</span>
            <textarea
              class="min-h-40 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
              value={bundleText}
              onInput={(e) => setBundleText((e.target as HTMLTextAreaElement).value)}
              required
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            class="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        </form>
      )}
    </main>
  );
}

function Field(props: {
  label: string;
  value: string;
  onInput: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">{props.label}</span>
      <input
        type={props.type ?? 'text'}
        class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
        value={props.value}
        required={props.required}
        onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
      />
    </label>
  );
}
