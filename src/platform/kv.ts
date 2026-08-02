/**
 * Ephemeral key/value store with optional TTL.
 * Cloudflare → Workers KV; Docker/Node → SQLite `kv_entries`.
 */

export interface KvPutOptions {
  expirationTtl?: number;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KvPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /** Test/admin helper; not used on the hot path. */
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

export class WorkersKv implements KvStore {
  constructor(private readonly ns: KVNamespace) {}

  get(key: string): Promise<string | null> {
    return this.ns.get(key);
  }

  put(key: string, value: string, options?: KvPutOptions): Promise<void> {
    return this.ns.put(
      key,
      value,
      options?.expirationTtl ? { expirationTtl: options.expirationTtl } : undefined,
    );
  }

  delete(key: string): Promise<void> {
    return this.ns.delete(key);
  }

  async list(options: { prefix: string }): Promise<{ keys: { name: string }[] }> {
    const res = await this.ns.list({ prefix: options.prefix });
    return { keys: res.keys.map((k) => ({ name: k.name })) };
  }
}
