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

  MAILGUN_API_KEY: string;
  MAILGUN_SIGNING_KEY: string;
  SESSION_SECRET: string;
  OTP_PEPPER: string;
  ACTION_TOKEN_SECRET: string;
}

export type AppBindings = {
  Bindings: Env;
};
