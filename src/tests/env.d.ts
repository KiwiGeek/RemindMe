/// <reference types="@cloudflare/vitest-pool-workers/types" />

type _WorkerEnv = import('../env').Env;

declare namespace Cloudflare {
  interface Env extends _WorkerEnv {
    DB: D1Database;
    KV: KVNamespace;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
