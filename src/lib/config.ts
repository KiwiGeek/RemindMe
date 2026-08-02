/**
 * Resolved operator configuration (decrypted). Loaded from `app_settings`
 * after setup / env bridge. Never includes INSTANCE_SECRET or SETUP_TOKEN.
 */

import { eq } from 'drizzle-orm';
import type { AppDb } from '~/db/client';
import { type MailProvider, type RegistrationMode, appSettings, users } from '~/db/schema';
import type { Env } from '~/env';
import { randomHex } from '~/lib/crypto';
import { decryptSecret, encryptSecret } from '~/lib/secretBox';

export interface AppConfig {
  setupCompletedAt: string;
  appName: string;
  siteOrigin: string;
  mailProvider: MailProvider;
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
  registrationMode: RegistrationMode;
}

export interface AppConfigPublic {
  appName: string;
  siteOrigin: string;
  mailProvider: MailProvider;
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
  registrationMode: RegistrationMode;
}

export function toPublicConfig(c: AppConfig): AppConfigPublic {
  return {
    appName: c.appName,
    siteOrigin: c.siteOrigin,
    mailProvider: c.mailProvider,
    mailgunRegion: c.mailgunRegion,
    mailgunDomain: c.mailgunDomain,
    mailgunFrom: c.mailgunFrom,
    mailgunReplyTo: c.mailgunReplyTo,
    mailgunApiKey: c.mailgunApiKey,
    mailgunSigningKey: c.mailgunSigningKey,
    smtpHost: c.smtpHost,
    smtpPort: c.smtpPort,
    smtpSecure: c.smtpSecure,
    smtpUser: c.smtpUser,
    smtpPass: c.smtpPass,
    registrationMode: c.registrationMode,
  };
}

/** Per-isolate cache — decrypting settings is PBKDF2-heavy. */
let configCache: { instanceSecret: string; config: AppConfig } | null = null;

export function invalidateConfigCache(): void {
  configCache = null;
}

async function decryptOptional(instanceSecret: string, blob: string): Promise<string> {
  if (!blob) return '';
  return decryptSecret(instanceSecret, blob);
}

async function rowToConfig(
  instanceSecret: string,
  row: typeof appSettings.$inferSelect,
): Promise<AppConfig | null> {
  if (!row.setupCompletedAt) return null;
  return {
    setupCompletedAt: row.setupCompletedAt,
    appName: row.appName,
    siteOrigin: row.siteOrigin,
    mailProvider: row.mailProvider === 'smtp' ? 'smtp' : 'mailgun',
    mailgunRegion: row.mailgunRegion === 'eu' ? 'eu' : 'us',
    mailgunDomain: row.mailgunDomain,
    mailgunFrom: row.mailgunFrom,
    mailgunReplyTo: row.mailgunReplyTo,
    mailgunApiKey: await decryptOptional(instanceSecret, row.mailgunApiKeyEnc),
    mailgunSigningKey: await decryptOptional(instanceSecret, row.mailgunSigningKeyEnc),
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure === 1,
    smtpUser: row.smtpUser,
    smtpPass: await decryptOptional(instanceSecret, row.smtpPassEnc),
    sessionSecret: await decryptSecret(instanceSecret, row.sessionSecretEnc),
    otpPepper: await decryptSecret(instanceSecret, row.otpPepperEnc),
    actionTokenSecret: await decryptSecret(instanceSecret, row.actionTokenSecretEnc),
    registrationMode: row.registrationMode === 'closed' ? 'closed' : 'open',
  };
}

export async function loadConfig(db: AppDb, instanceSecret: string): Promise<AppConfig | null> {
  if (configCache && configCache.instanceSecret === instanceSecret) {
    return configCache.config;
  }
  const rows = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    const config = await rowToConfig(instanceSecret, row);
    if (config) configCache = { instanceSecret, config };
    return config;
  } catch (err) {
    console.error('failed to decrypt app_settings', err);
    return null;
  }
}

export async function isSetupComplete(db: AppDb): Promise<boolean> {
  const rows = await db
    .select({ at: appSettings.setupCompletedAt })
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);
  return Boolean(rows[0]?.at);
}

export interface WriteSettingsInput {
  appName: string;
  siteOrigin: string;
  mailProvider: MailProvider;
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
  registrationMode: RegistrationMode;
  setupCompletedAt: string;
}

export async function writeSettings(
  db: AppDb,
  instanceSecret: string,
  input: WriteSettingsInput,
): Promise<void> {
  const values = {
    id: 1 as const,
    setupCompletedAt: input.setupCompletedAt,
    appName: input.appName,
    siteOrigin: input.siteOrigin.replace(/\/$/, ''),
    mailProvider: input.mailProvider,
    mailgunRegion: input.mailgunRegion,
    mailgunDomain: input.mailgunDomain,
    mailgunFrom: input.mailgunFrom,
    mailgunReplyTo: input.mailgunReplyTo,
    mailgunApiKeyEnc: await encryptSecret(instanceSecret, input.mailgunApiKey),
    mailgunSigningKeyEnc: await encryptSecret(instanceSecret, input.mailgunSigningKey),
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure ? 1 : 0,
    smtpUser: input.smtpUser,
    smtpPassEnc: await encryptSecret(instanceSecret, input.smtpPass),
    sessionSecretEnc: await encryptSecret(instanceSecret, input.sessionSecret),
    otpPepperEnc: await encryptSecret(instanceSecret, input.otpPepper),
    actionTokenSecretEnc: await encryptSecret(instanceSecret, input.actionTokenSecret),
    registrationMode: input.registrationMode,
    updatedAt: new Date().toISOString(),
  };
  await db.insert(appSettings).values(values).onConflictDoUpdate({
    target: appSettings.id,
    set: values,
  });
  invalidateConfigCache();
}

function legacyReady(env: Env): boolean {
  return Boolean(
    env.MAILGUN_API_KEY &&
      env.MAILGUN_SIGNING_KEY &&
      env.SESSION_SECRET &&
      env.OTP_PEPPER &&
      env.ACTION_TOKEN_SECRET &&
      env.SITE_ORIGIN &&
      env.MAILGUN_DOMAIN &&
      env.MAILGUN_FROM &&
      env.MAILGUN_REPLY_TO,
  );
}

/**
 * One-shot upgrade: if settings are empty but legacy Worker secrets exist,
 * import them and promote ADMIN_EMAILS users so the live instance keeps working.
 */
export async function maybeBridgeFromEnv(env: Env, db: AppDb): Promise<AppConfig | null> {
  if (await isSetupComplete(db)) {
    return loadConfig(db, env.INSTANCE_SECRET);
  }
  if (!legacyReady(env)) return null;

  const siteOrigin = env.SITE_ORIGIN;
  const mailgunDomain = env.MAILGUN_DOMAIN;
  const mailgunFrom = env.MAILGUN_FROM;
  const mailgunReplyTo = env.MAILGUN_REPLY_TO;
  const mailgunApiKey = env.MAILGUN_API_KEY;
  const mailgunSigningKey = env.MAILGUN_SIGNING_KEY;
  const sessionSecret = env.SESSION_SECRET;
  const otpPepper = env.OTP_PEPPER;
  const actionTokenSecret = env.ACTION_TOKEN_SECRET;
  if (
    !siteOrigin ||
    !mailgunDomain ||
    !mailgunFrom ||
    !mailgunReplyTo ||
    !mailgunApiKey ||
    !mailgunSigningKey ||
    !sessionSecret ||
    !otpPepper ||
    !actionTokenSecret
  ) {
    return null;
  }

  const now = new Date().toISOString();
  await writeSettings(db, env.INSTANCE_SECRET, {
    appName: env.APP_NAME ?? 'Remind Me',
    siteOrigin,
    mailProvider: 'mailgun',
    mailgunRegion: env.MAILGUN_REGION === 'eu' ? 'eu' : 'us',
    mailgunDomain,
    mailgunFrom,
    mailgunReplyTo,
    mailgunApiKey,
    mailgunSigningKey,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpPass: '',
    sessionSecret,
    otpPepper,
    actionTokenSecret,
    registrationMode: 'open',
    setupCompletedAt: now,
  });

  const adminList = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@'));

  for (const email of adminList) {
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing[0]) {
      await db.update(users).set({ isAdmin: 1 }).where(eq(users.id, existing[0].id));
    } else {
      await db.insert(users).values({ email, isAdmin: 1, tzConfirmed: 0 });
    }
  }

  console.log('[remindme] bridged legacy env secrets into app_settings');
  return loadConfig(db, env.INSTANCE_SECRET);
}

/** Keep promoting emails listed in legacy ADMIN_EMAILS while that secret remains set. */
export async function syncLegacyAdmins(env: Env, db: AppDb): Promise<void> {
  const adminList = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@'));
  if (adminList.length === 0) return;
  for (const email of adminList) {
    await db.update(users).set({ isAdmin: 1 }).where(eq(users.email, email));
  }
}

export function newCryptoSecrets(): Pick<
  WriteSettingsInput,
  'sessionSecret' | 'otpPepper' | 'actionTokenSecret'
> {
  return {
    sessionSecret: randomHex(32),
    otpPepper: randomHex(32),
    actionTokenSecret: randomHex(32),
  };
}

/** True when running under the Node/Docker entry (not Cloudflare Workers). */
export function isNodeRuntime(env: Env): boolean {
  return Boolean(env.__db);
}

export function smtpAllowed(env: Env): boolean {
  return isNodeRuntime(env);
}

/** Domain used in Message-Id / similar metadata. */
export function mailMessageDomain(config: AppConfig): string {
  if (config.mailProvider === 'mailgun' && config.mailgunDomain) {
    return config.mailgunDomain;
  }
  const from = config.mailgunFrom;
  const at = from.lastIndexOf('@');
  if (at >= 0 && at < from.length - 1) {
    return from.slice(at + 1).replace(/>$/, '');
  }
  return 'localhost';
}
