import type { AppDb } from '~/db/client';
import type { KvStore } from '~/platform/kv';

/**
 * Runtime bindings. Cloudflare injects D1/KV/ASSETS; Node sets `__db` / `__kv`
 * and leaves D1/KV undefined. Legacy fields remain optional for the env→settings
 * upgrade bridge and for local/test fixtures.
 */
export interface Env {
  /** Required bootstrap: seals encrypted settings at rest. Never exposed via API. */
  INSTANCE_SECRET: string;
  /** Required until setup/import completes; gates the wizard. */
  SETUP_TOKEN?: string;

  /** Cloudflare D1 (Workers only). */
  DB?: D1Database;
  /** Cloudflare KV (Workers only). */
  KV?: KVNamespace;
  /** Cloudflare static assets (Workers only). */
  ASSETS?: Fetcher;

  /** Node/Docker: pre-built Drizzle client. */
  __db?: AppDb;
  /** Node/Docker: SQLite KV adapter. */
  __kv?: KvStore;

  /** When true (Node), trust X-Forwarded-* for scheme / client IP. */
  TRUST_PROXY?: string;

  // ---- Legacy / bridge (optional after setup) ----
  APP_NAME?: string;
  SITE_ORIGIN?: string;
  MAILGUN_REGION?: 'us' | 'eu';
  MAILGUN_DOMAIN?: string;
  MAILGUN_FROM?: string;
  MAILGUN_REPLY_TO?: string;
  ADMIN_EMAILS?: string;
  MAILGUN_API_KEY?: string;
  MAILGUN_SIGNING_KEY?: string;
  SESSION_SECRET?: string;
  OTP_PEPPER?: string;
  ACTION_TOKEN_SECRET?: string;
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    config: import('~/lib/config').AppConfig | null;
    kv: KvStore;
  };
};
