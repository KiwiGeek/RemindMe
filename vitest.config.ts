import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

// Wrangler validates `wrangler.toml`'s `[assets] directory` at config-load
// time and refuses to start the test pool if it's missing. The SPA build
// output (`web/dist/`) is git-ignored, so on a fresh checkout — CI or a
// teammate after `git clean -fdx` — the directory simply doesn't exist
// and tests fail before they even start with a confusing
// "directory specified by assets.directory does not exist" error.
//
// We don't actually need the real SPA bundle to run worker tests (none
// of them hit static assets), so populate a no-op placeholder if it's
// not already there. `npm run build:web` will overwrite it the moment
// anyone runs a real build.
const ASSETS_DIR = fileURLToPath(new URL('./web/dist', import.meta.url));
if (!existsSync(ASSETS_DIR)) {
  mkdirSync(ASSETS_DIR, { recursive: true });
  writeFileSync(
    `${ASSETS_DIR}/index.html`,
    '<!doctype html><meta charset="utf-8"><title>test-stub</title>',
  );
}

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
          // singleWorker forces all test files into one Miniflare instance.
          // Without this on Windows, workerd's localhost fallback module
          // service occasionally has its loopback connections refused
          // (Win32 #52 / #1225) when multiple Miniflare instances spin up
          // in parallel, causing flakes like
          // "No such module .../tsyringe/.../singleton". Tests run a touch
          // slower in single-worker mode but are deterministic.
          singleWorker: true,
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            compatibilityFlags: ['nodejs_compat'],
            bindings: {
              // Plumb migration metadata through so setup.ts can apply them
              // against the test-scoped D1 database.
              TEST_MIGRATIONS: migrations,
              // Deterministic per-deploy config. These used to live in
              // wrangler.toml's [vars] but were moved to Cloudflare secrets
              // for production, so we have to re-provide them here for the
              // test pool (which would otherwise see them as undefined).
              SITE_ORIGIN: 'http://localhost:8787',
              MAILGUN_DOMAIN: 'example.com',
              MAILGUN_FROM: 'Remind Me <reminders@example.com>',
              MAILGUN_REPLY_TO: 'no-reply@example.com',
              ADMIN_EMAILS: 'admin@example.com,super@example.com',
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
