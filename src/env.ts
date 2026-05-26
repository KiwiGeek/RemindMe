export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  KV: KVNamespace;

  APP_NAME: string;
  SITE_ORIGIN: string;
  MAILGUN_REGION: 'us' | 'eu';
  MAILGUN_DOMAIN: string;
  MAILGUN_FROM: string;
  MAILGUN_REPLY_TO: string;
  /**
   * Comma-separated list of email addresses (case-insensitive) that get
   * access to the `/api/admin/*` namespace. Source of truth lives in
   * `wrangler.toml`. Escalation requires a redeploy by someone who already
   * controls the Worker — there is no DB-stored admin flag on purpose.
   */
  ADMIN_EMAILS: string;

  MAILGUN_API_KEY: string;
  MAILGUN_SIGNING_KEY: string;
  SESSION_SECRET: string;
  OTP_PEPPER: string;
  ACTION_TOKEN_SECRET: string;
}

export type AppBindings = {
  Bindings: Env;
};
