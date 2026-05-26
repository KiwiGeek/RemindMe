import { applyD1Migrations, env, fetchMock } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

afterAll(() => {
  fetchMock.deactivate();
});
