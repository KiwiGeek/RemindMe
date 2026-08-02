/// <reference types="@cloudflare/vitest-pool-workers" />

import type { Env } from '../env';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    DB: D1Database;
    KV: KVNamespace;
    TEST_MIGRATIONS: D1Migration[];
  }
}
