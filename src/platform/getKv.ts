import type { Env } from '~/env';
import { type KvStore, WorkersKv } from '~/platform/kv';

export function getKv(env: Env): KvStore {
  if (env.__kv) return env.__kv;
  if (!env.KV) {
    throw new Error('KV binding missing — set env.KV (Workers) or env.__kv (Node)');
  }
  return new WorkersKv(env.KV);
}
