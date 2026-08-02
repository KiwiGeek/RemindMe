/**
 * Fail-loud bootstrap check for INSTANCE_SECRET (and optional SETUP_TOKEN note).
 */

import type { Env } from '~/env';

let checked = false;

export function checkEnv(env: Env): void {
  if (checked) return;
  checked = true;

  const problems: string[] = [];
  if (typeof env.INSTANCE_SECRET !== 'string' || env.INSTANCE_SECRET.length < 16) {
    problems.push('INSTANCE_SECRET: missing or too short (need ≥16 chars)');
  }
  if (env.INSTANCE_SECRET === 'generate-with-openssl-rand-hex-32') {
    problems.push('INSTANCE_SECRET: still the placeholder');
  }

  if (problems.length > 0) {
    console.warn(
      [
        '[remindme] bootstrap misconfigured — setup and encrypted settings will fail:',
        ...problems.map((p) => `  - ${p}`),
        '  Set INSTANCE_SECRET in .dev.vars (Workers local), wrangler secret, or Docker .env.',
      ].join('\n'),
    );
  }
}
