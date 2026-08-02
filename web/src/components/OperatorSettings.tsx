import { useEffect, useState } from 'preact/hooks';
import { ApiError, type AppSettings, api } from '../api';

export function OperatorSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [smtpAllowed, setSmtpAllowed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportPass, setExportPass] = useState('');
  const [importPass, setImportPass] = useState('');
  const [importText, setImportText] = useState('');

  useEffect(() => {
    void api
      .adminGetSettings()
      .then((r) => {
        setSettings(r.settings);
        setSmtpAllowed(r.smtpAllowed);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)));
  }, []);

  if (!settings) {
    return <p class="text-sm text-zinc-500">{error ?? 'Loading settings…'}</p>;
  }

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((s) => (s ? { ...s, [key]: value } : s));
  }

  async function save() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      if (!settings) return;
      const res = await api.adminUpdateSettings(settings);
      setSettings(res.settings);
      setSmtpAllowed(res.smtpAllowed);
      setMsg('Settings saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function testEmail() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await api.adminTestEmail();
      setMsg(`Test email sent to ${res.to}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doExport() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const pass = exportPass.trim();
      if (pass.length > 0 && pass.length < 8) {
        setError('Passphrase must be at least 8 characters, or leave blank for plain JSON.');
        return;
      }
      const res = await api.adminExport(pass || undefined);
      const blob = new Blob([JSON.stringify(res.bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'remindme-export.json';
      a.click();
      URL.revokeObjectURL(url);
      setMsg(pass ? 'Encrypted export downloaded.' : 'Plain JSON export downloaded.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!confirm('Replace ALL data on this instance with the import? This cannot be undone.')) {
      return;
    }
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const bundle = JSON.parse(importText) as unknown;
      await api.adminImport(bundle, importPass.trim() || undefined);
      setMsg('Import complete. Reload the page.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const provider = settings.mailProvider;

  return (
    <section class="flex flex-col gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 class="text-lg font-semibold">Instance configuration</h2>
      <p class="text-xs text-zinc-500">
        Secrets are stored encrypted and are readable here by admins (not write-only).
      </p>
      {error && (
        <p role="alert" class="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {msg && <p class="text-sm text-green-700 dark:text-green-400">{msg}</p>}

      <Field label="App name" value={settings.appName} onInput={(v) => set('appName', v)} />
      <Field
        label="Site origin"
        value={settings.siteOrigin}
        onInput={(v) => set('siteOrigin', v)}
      />
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Registration</span>
        <select
          class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
          value={settings.registrationMode}
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
          value={provider}
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

      <Field label="From" value={settings.mailgunFrom} onInput={(v) => set('mailgunFrom', v)} />
      <Field
        label="Reply-To"
        value={settings.mailgunReplyTo}
        onInput={(v) => set('mailgunReplyTo', v)}
      />

      {provider === 'mailgun' ? (
        <>
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Mailgun region</span>
            <select
              class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
              value={settings.mailgunRegion}
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
            value={settings.mailgunDomain}
            onInput={(v) => set('mailgunDomain', v)}
          />
          <Field
            label="Mailgun API key"
            value={settings.mailgunApiKey}
            onInput={(v) => set('mailgunApiKey', v)}
          />
          <Field
            label="Mailgun signing key"
            value={settings.mailgunSigningKey}
            onInput={(v) => set('mailgunSigningKey', v)}
          />
          <MailgunWebhookHelp siteOrigin={settings.siteOrigin} />
        </>
      ) : (
        <>
          <Field label="SMTP host" value={settings.smtpHost} onInput={(v) => set('smtpHost', v)} />
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">SMTP port</span>
            <input
              type="number"
              min={1}
              max={65535}
              class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
              value={settings.smtpPort}
              onInput={(e) => set('smtpPort', Number((e.target as HTMLInputElement).value) || 587)}
            />
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.smtpSecure}
              onChange={(e) => set('smtpSecure', (e.target as HTMLInputElement).checked)}
            />
            <span>TLS/SSL (secure)</span>
          </label>
          <Field label="SMTP user" value={settings.smtpUser} onInput={(v) => set('smtpUser', v)} />
          <Field
            label="SMTP password"
            type="password"
            value={settings.smtpPass}
            onInput={(v) => set('smtpPass', v)}
          />
          <p class="text-xs text-zinc-500">
            SMTP has no bounce webhooks; suppressions are manual / local only.
          </p>
        </>
      )}

      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          class="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void testEmail()}
          class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
        >
          Send test email
        </button>
      </div>

      <hr class="border-zinc-200 dark:border-zinc-800" />

      <h3 class="font-medium">Export / import</h3>
      <p class="text-xs text-zinc-500">
        Leave the passphrase blank for plain JSON (includes secrets). Set one (≥8 chars) to encrypt
        the file.
      </p>
      <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field
          label="Export passphrase (optional)"
          type="password"
          value={exportPass}
          onInput={setExportPass}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void doExport()}
          class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
        >
          Download export
        </button>
      </div>
      <Field
        label="Import passphrase (if encrypted)"
        type="password"
        value={importPass}
        onInput={setImportPass}
      />
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Import JSON</span>
        <textarea
          class="min-h-28 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
          value={importText}
          onInput={(e) => setImportText((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || !importText}
        onClick={() => void doImport()}
        class="w-fit rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-300"
      >
        Replace instance from import
      </button>
    </section>
  );
}

function mailgunWebhookUrl(siteOrigin: string): string {
  const origin = siteOrigin.replace(/\/$/, '');
  return origin ? `${origin}/webhooks/mailgun` : 'https://your-origin/webhooks/mailgun';
}

function MailgunWebhookHelp(props: { siteOrigin: string }) {
  const url = mailgunWebhookUrl(props.siteOrigin);
  const [copied, setCopied] = useState(false);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div class="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/50">
      <p class="font-medium">Mailgun webhooks</p>
      <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        In the Mailgun dashboard → Sending → Webhooks (for this domain), add an HTTP webhook
        pointing at:
      </p>
      <div class="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code class="block flex-1 break-all rounded border border-zinc-200 bg-white px-2 py-1.5 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950">
          {url}
        </code>
        <button
          type="button"
          onClick={() => void copyUrl()}
          class="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <ul class="mt-2 list-inside list-disc text-xs text-zinc-600 dark:text-zinc-400">
        <li>
          Enable events: <strong class="font-medium">Permanent Failure</strong>,{' '}
          <strong class="font-medium">Spam Complaints</strong>, and{' '}
          <strong class="font-medium">Unsubscribes</strong> (temporary failures are audited only).
        </li>
        <li>
          Paste Mailgun’s <strong class="font-medium">HTTP webhook signing key</strong> into the
          signing key field above (not the API key).
        </li>
        <li>Site origin must be the public HTTPS URL Mailgun can reach.</li>
      </ul>
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onInput: (v: string) => void;
  type?: string;
}) {
  return (
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">{props.label}</span>
      <input
        type={props.type ?? 'text'}
        class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
        value={props.value}
        onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
      />
    </label>
  );
}
