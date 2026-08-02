/**
 * Lightweight stand-in for the removed `fetchMock` export from
 * `cloudflare:test` (vitest-pool-workers ≥ 0.13). Mirrors the undici
 * MockAgent surface our tests already use: one-shot interceptors keyed by
 * origin + method + path, with `disableNetConnect()` rejecting unmatched
 * outbound calls.
 */
import { vi } from 'vitest';

type ReplyBody = string | ((opts: { body: unknown }) => string);

interface Interceptor {
  origin: string;
  method: string;
  path: string | RegExp;
  status: number;
  body: ReplyBody;
  headers?: Record<string, string>;
}

interface InterceptOptions {
  path: string | RegExp;
  method?: string;
}

interface ReplyOptions {
  headers?: Record<string, string>;
}

const interceptors: Interceptor[] = [];
let netConnectDisabled = false;
let active = false;
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function pathMatches(expected: string | RegExp, actual: string): boolean {
  return typeof expected === 'string' ? expected === actual : expected.test(actual);
}

function takeInterceptor(url: URL, method: string): Interceptor | undefined {
  // Match pathname (and optionally "?query") the way undici MockAgent did.
  const candidates = url.search ? [url.pathname + url.search, url.pathname] : [url.pathname];
  const idx = interceptors.findIndex(
    (i) =>
      i.origin === url.origin &&
      i.method === method.toUpperCase() &&
      candidates.some((p) => pathMatches(i.path, p)),
  );
  if (idx === -1) return undefined;
  return interceptors.splice(idx, 1)[0];
}

async function mockedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const matched = takeInterceptor(url, request.method);

  if (!matched) {
    if (netConnectDisabled) {
      throw new Error(
        `fetchMock: unexpected ${request.method} ${url.href} (no interceptor; net connect disabled)`,
      );
    }
    throw new Error(`fetchMock: unexpected ${request.method} ${url.href} (no interceptor)`);
  }

  const rawBody = await request.arrayBuffer();
  const bodyBytes = new Uint8Array(rawBody);
  const reply =
    typeof matched.body === 'function' ? matched.body({ body: bodyBytes }) : matched.body;

  return new Response(reply, {
    status: matched.status,
    headers: matched.headers,
  });
}

class MockPool {
  constructor(private readonly origin: string) {}

  intercept(opts: InterceptOptions) {
    return {
      reply: (status: number, body: ReplyBody, replyOpts?: ReplyOptions) => {
        interceptors.push({
          origin: this.origin,
          method: (opts.method ?? 'GET').toUpperCase(),
          path: opts.path,
          status,
          body,
          headers: replyOpts?.headers,
        });
      },
    };
  }
}

export const fetchMock = {
  get(origin: string) {
    return new MockPool(origin);
  },

  activate() {
    if (active) return;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(mockedFetch as typeof fetch);
    active = true;
  },

  deactivate() {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    active = false;
    interceptors.length = 0;
    netConnectDisabled = false;
  },

  disableNetConnect() {
    netConnectDisabled = true;
  },

  assertNoPendingInterceptors() {
    if (interceptors.length === 0) return;
    const pending = interceptors
      .map((i) => `${i.method} ${i.origin}${typeof i.path === 'string' ? i.path : i.path}`)
      .join(', ');
    throw new Error(`fetchMock: ${interceptors.length} pending interceptor(s): ${pending}`);
  },
};
