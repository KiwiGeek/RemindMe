import { applyD1Migrations, env } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { fetchMock } from './fetch-mock';

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
