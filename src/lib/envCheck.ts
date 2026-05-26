/**
 * One-shot, fail-loud-but-don't-crash startup check. Run once per isolate
 * (cheap — we cache the result) and log a single warning line listing every
 * secret that's missing or still set to the `.dev.vars.example` placeholder.
 *
 * Designed for the developer footgun where `wrangler secret put` was used
 * but `.dev.vars` wasn't touched — Mailgun calls 401 with no context.
 */

import type { Env } from '~/env';

const PLACEHOLDERS: Record<string, string> = {
  MAILGUN_API_KEY: 'key-replace-me',
  MAILGUN_SIGNING_KEY: 'replace-me',
  SESSION_SECRET: 'generate-with-openssl-rand-hex-32',
  OTP_PEPPER: 'generate-with-openssl-rand-hex-32',
  ACTION_TOKEN_SECRET: 'generate-with-openssl-rand-hex-32',
};

let checked = false;

export function checkEnv(env: Env): void {
  if (checked) return;
  checked = true;

  const problems: string[] = [];
  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
    const value = env[key as keyof Env];
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`${key}: missing`);
    } else if (value === placeholder) {
      problems.push(`${key}: still the .dev.vars.example placeholder`);
    }
  }

  if (problems.length > 0) {
    console.warn(
      [
        '[remindme] one or more secrets are misconfigured — Mailgun + session features will fail:',
        ...problems.map((p) => `  - ${p}`),
        '  Set them in .dev.vars (for `wrangler dev`) and/or via `wrangler secret put <NAME>` (for production).',
      ].join('\n'),
    );
  }
}
