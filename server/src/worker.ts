import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { D1Store } from './store/d1.ts';
import type { D1Like } from './store/d1.ts';

/**
 * cloudflare workers entry: the same hono app and the same engine as the node server, with the database on d1.
 * configuration comes from the worker's variables (wrangler.jsonc) and secrets (`wrangler secret put`), exactly the
 * names documented in .env.example.
 */
interface Env {
  DB: D1Like;
  [key: string]: unknown;
}

let cached: { app: ReturnType<typeof createApp>; store: D1Store } | null = null;

function boot(env: Env) {
  if (cached) return cached;
  const vars: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') vars[k] = v;
  const config = loadConfig(vars);
  const store = new D1Store(env.DB);
  const app = createApp({ store, config, fetch: (...a: Parameters<typeof fetch>) => fetch(...a), now: () => new Date(), newId: () => crypto.randomUUID() });
  cached = { app, store };
  return cached;
}

export default {
  fetch(request: Request, env: Env, ctx: unknown): Response | Promise<Response> {
    return boot(env).app.fetch(request, env, ctx as never);
  },

  /** housekeeping on a schedule (see "triggers" in wrangler.jsonc): expired sessions, sign-in states and abandoned guest sandboxes. */
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const { store } = boot(env);
    const config = loadConfig(Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>);
    const now = new Date();
    await store.purgeExpiredSessions(now.toISOString());
    await store.purgeExpiredOAuthStates(now.toISOString());
    await store.purgeExpiredGuests(new Date(now.getTime() - config.guestTtlHours * 3_600_000).toISOString());
  },
};
