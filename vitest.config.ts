import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('./migrations');

  return {
    resolve: {
      alias: {
        '~': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    test: {
      include: ['src/**/*.test.ts'],
      setupFiles: ['./src/tests/setup.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            compatibilityFlags: ['nodejs_compat'],
            bindings: {
              // Plumb migration metadata through so setup.ts can apply them
              // against the test-scoped D1 database.
              TEST_MIGRATIONS: migrations,
              // Override Mailgun + crypto config with deterministic values so
              // tests don't depend on real secrets being set in .dev.vars.
              MAILGUN_API_KEY: 'test-api-key',
              MAILGUN_SIGNING_KEY: 'test-signing-key',
              SESSION_SECRET: 'test-session-secret-aaaaaaaaaaaaaaaaaaaaaaaaaa',
              OTP_PEPPER: 'test-otp-pepper-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              ACTION_TOKEN_SECRET: 'test-action-token-secret-cccccccccccccccccc',
            },
          },
        },
      },
    },
  };
});
