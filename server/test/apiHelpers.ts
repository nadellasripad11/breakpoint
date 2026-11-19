import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { SqliteStore } from '../src/store/sqlite.ts';
import { sha256Hex, randomToken } from '../src/auth/crypto.ts';
import type { Fetcher } from '../src/auth/google.ts';
import type { Deps } from '../src/http/context.ts';
import { resetRateLimits } from '../src/http/middleware.ts';
import { resetJwksCache } from '../src/auth/google.ts';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  store: SqliteStore;
  deps: Deps;
  config: Config;
}

export const noNetwork: Fetcher = async (url) => new Response(`no network in tests (${String(url)})`, { status: 599 });

export async function makeApp(opts: { fetch?: Fetcher; env?: Record<string, string> } = {}): Promise<TestApp> {
  resetRateLimits();
  resetJwksCache();
  const store = new SqliteStore(':memory:');
  await store.migrate();
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_ORIGINS: 'http://localhost:5173',
    API_URL: 'http://api.test',
    TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ...opts.env,
  });
  const deps: Deps = { store, config, fetch: opts.fetch ?? noNetwork, now: () => new Date(), newId: () => crypto.randomUUID() };
  return { app: createApp(deps), store, deps, config };
}

export interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  headers: Headers;
  text: string;
}

export function client(t: TestApp) {
  return async function call(method: string, path: string, o: { body?: unknown; token?: string; cookie?: string; headers?: Record<string, string> } = {}): Promise<Res> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.cookie) headers.cookie = o.cookie;
    const res = await t.app.request(path, { method, headers, ...(o.body !== undefined ? { body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body) } : {}) });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, headers: res.headers, text };
  };
}

/** A real (non-guest) signed-in user without going through Google. Returns a bearer token. */
export async function makeUser(t: TestApp, email = `u${Math.random().toString(36).slice(2)}@example.com`, isGuest = false): Promise<{ id: string; token: string }> {
  const user = await t.store.createUser({ id: crypto.randomUUID(), email: isGuest ? null : email, name: isGuest ? 'Guest' : 'Test User', picture: null, googleSub: isGuest ? null : `sub-${email}`, isGuest });
  const token = randomToken(32);
  const now = new Date();
  await t.store.createSession({ tokenHash: sha256Hex(token), userId: user.id, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), userAgent: 'test' });
  return { id: user.id, token };
}

export const setCookies = (res: Res): string[] => (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
export const cookiePair = (res: Res): string => setCookies(res).map((c) => c.split(';')[0]).join('; ');
