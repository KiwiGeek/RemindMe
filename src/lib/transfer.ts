/**
 * Full-instance export/import.
 * Plain JSON by default; optional passphrase wraps the payload (AES-GCM).
 */

import type { AppDb } from '~/db/client';
import {
  appSettings,
  auditLog,
  passkeys,
  reminderFires,
  reminders,
  suppressions,
  users,
} from '~/db/schema';
import { type AppConfig, loadConfig, writeSettings } from '~/lib/config';
import {
  type EncryptedBundle,
  unwrapWithPassphrase,
  wrapWithPassphrase,
} from '~/lib/passphraseBox';

export const TRANSFER_SCHEMA_VERSION = 2;

export interface InstancePayload {
  schemaVersion: number;
  exportedAt: string;
  settings: {
    appName: string;
    siteOrigin: string;
    mailProvider: 'mailgun' | 'smtp';
    mailgunRegion: 'us' | 'eu';
    mailgunDomain: string;
    mailgunFrom: string;
    mailgunReplyTo: string;
    mailgunApiKey: string;
    mailgunSigningKey: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    smtpPass: string;
    sessionSecret: string;
    otpPepper: string;
    actionTokenSecret: string;
    registrationMode: 'open' | 'closed';
    setupCompletedAt: string;
  };
  users: (typeof users.$inferSelect)[];
  reminders: (typeof reminders.$inferSelect)[];
  reminderFires: (typeof reminderFires.$inferSelect)[];
  suppressions: (typeof suppressions.$inferSelect)[];
  passkeys: (typeof passkeys.$inferSelect)[];
  auditLog: (typeof auditLog.$inferSelect)[];
}

export type ExportBundle = InstancePayload | EncryptedBundle;

export async function buildInstancePayload(
  db: AppDb,
  _instanceSecret: string,
  config: AppConfig,
): Promise<InstancePayload> {
  return {
    schemaVersion: TRANSFER_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: {
      appName: config.appName,
      siteOrigin: config.siteOrigin,
      mailProvider: config.mailProvider,
      mailgunRegion: config.mailgunRegion,
      mailgunDomain: config.mailgunDomain,
      mailgunFrom: config.mailgunFrom,
      mailgunReplyTo: config.mailgunReplyTo,
      mailgunApiKey: config.mailgunApiKey,
      mailgunSigningKey: config.mailgunSigningKey,
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      smtpUser: config.smtpUser,
      smtpPass: config.smtpPass,
      sessionSecret: config.sessionSecret,
      otpPepper: config.otpPepper,
      actionTokenSecret: config.actionTokenSecret,
      registrationMode: config.registrationMode,
      setupCompletedAt: config.setupCompletedAt,
    },
    users: await db.select().from(users),
    reminders: await db.select().from(reminders),
    reminderFires: await db.select().from(reminderFires),
    suppressions: await db.select().from(suppressions),
    passkeys: await db.select().from(passkeys),
    auditLog: await db.select().from(auditLog),
  };
}

function isEncryptedBundle(bundle: unknown): bundle is EncryptedBundle {
  if (!bundle || typeof bundle !== 'object') return false;
  const b = bundle as Record<string, unknown>;
  return b.v === 1 && typeof b.salt === 'string' && typeof b.ciphertext === 'string';
}

function isPlainPayload(bundle: unknown): bundle is InstancePayload {
  if (!bundle || typeof bundle !== 'object') return false;
  const b = bundle as Record<string, unknown>;
  return typeof b.schemaVersion === 'number' && typeof b.settings === 'object';
}

function normalizeSettings(
  settings: InstancePayload['settings'] & Record<string, unknown>,
  schemaVersion: number,
): InstancePayload['settings'] {
  if (schemaVersion === 1) {
    return {
      ...settings,
      mailProvider: 'mailgun',
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      smtpPass: '',
    };
  }
  return {
    ...settings,
    mailProvider: settings.mailProvider === 'smtp' ? 'smtp' : 'mailgun',
    smtpHost: typeof settings.smtpHost === 'string' ? settings.smtpHost : '',
    smtpPort: typeof settings.smtpPort === 'number' ? settings.smtpPort : 587,
    smtpSecure: Boolean(settings.smtpSecure),
    smtpUser: typeof settings.smtpUser === 'string' ? settings.smtpUser : '',
    smtpPass: typeof settings.smtpPass === 'string' ? settings.smtpPass : '',
  };
}

/**
 * Export the instance. Omit passphrase (or pass empty) for plain JSON;
 * provide a passphrase to wrap it.
 */
export async function exportInstanceBundle(
  db: AppDb,
  instanceSecret: string,
  config: AppConfig,
  passphrase?: string | null,
): Promise<ExportBundle> {
  const payload = await buildInstancePayload(db, instanceSecret, config);
  const pass = passphrase?.trim() ?? '';
  if (pass.length === 0) return payload;
  return wrapWithPassphrase(pass, JSON.stringify(payload));
}

export async function importInstanceBundle(
  db: AppDb,
  instanceSecret: string,
  bundle: unknown,
  passphrase?: string | null,
  opts?: { smtpAllowed?: boolean },
): Promise<void> {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('invalid bundle');
  }

  let payload: InstancePayload;
  if (isEncryptedBundle(bundle)) {
    const pass = passphrase?.trim() ?? '';
    if (pass.length === 0) {
      throw new Error('passphrase_required');
    }
    const json = await unwrapWithPassphrase(pass, bundle);
    payload = JSON.parse(json) as InstancePayload;
  } else if (isPlainPayload(bundle)) {
    payload = bundle;
  } else {
    throw new Error('invalid bundle');
  }

  if (payload.schemaVersion !== 1 && payload.schemaVersion !== TRANSFER_SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion ${payload.schemaVersion}`);
  }

  const settings = normalizeSettings(
    payload.settings as InstancePayload['settings'] & Record<string, unknown>,
    payload.schemaVersion,
  );

  if (settings.mailProvider === 'smtp' && opts?.smtpAllowed === false) {
    throw new Error('smtp_not_supported');
  }

  await db.delete(reminderFires);
  await db.delete(reminders);
  await db.delete(passkeys);
  await db.delete(auditLog);
  await db.delete(suppressions);
  await db.delete(users);
  await db.delete(appSettings);

  await writeSettings(db, instanceSecret, {
    ...settings,
    setupCompletedAt: settings.setupCompletedAt || new Date().toISOString(),
  });

  if (payload.users.length > 0) {
    await db.insert(users).values(payload.users);
  }
  if (payload.reminders.length > 0) {
    await db.insert(reminders).values(payload.reminders);
  }
  if (payload.reminderFires.length > 0) {
    await db.insert(reminderFires).values(payload.reminderFires);
  }
  if (payload.suppressions.length > 0) {
    await db.insert(suppressions).values(payload.suppressions);
  }
  if (payload.passkeys.length > 0) {
    await db.insert(passkeys).values(payload.passkeys);
  }
  if (payload.auditLog.length > 0) {
    await db.insert(auditLog).values(payload.auditLog);
  }

  const loaded = await loadConfig(db, instanceSecret);
  if (!loaded) throw new Error('import produced undecryptable settings');
}
