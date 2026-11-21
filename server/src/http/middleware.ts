import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { AppEnv, Deps } from './context.ts';
import { forbidden, HttpError, unauthorized } from './errors.ts';
import { randomToken, sha256Hex } from '../auth/crypto.ts';
import type { User } from '../store/types.ts';

export const requestId = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
};

export function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    // behind cloudflare (workers or a proxied host) this header is set by cloudflare itself and cannot be forged by the client
    const cf = c.req.header('cf-connecting-ip');
    if (cf) return cf.trim().slice(0, 64);
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0]!.trim().slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'local';
  }
}

/* ───────────── rate limiting (in-memory, fixed window) ─────────────
   good for a single instance. for several instances or workers, back this with kv / a durable object. */
interface Counter {
  count: number;
  resetAt: number;
}
const counters = new Map<string, Counter>();

export function rateLimit(bucket: string, limit: number, windowMs: number, by: 'ip' | 'user' = 'ip'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    if (deps.config.env === 'test' && !c.req.header('x-test-ratelimit')) return next();
    const now = deps.now().getTime();
    const who = by === 'user' && c.get('user') ? `u:${c.get('user')!.id}` : `ip:${clientIp(c, deps.config.trustProxy)}`;
    const key = `${bucket}:${who}`;
    let k = counters.get(key);
    if (!k || k.resetAt <= now) {
      k = { count: 0, resetAt: now + windowMs };
      counters.set(key, k);
      if (counters.size > 20000) for (const [kk, v] of counters) if (v.resetAt <= now) counters.delete(kk);
    }
    k.count++;
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - k.count)));
    if (k.count > limit) {
      const retry = Math.max(1, Math.ceil((k.resetAt - now) / 1000));
      c.header('Retry-After', String(retry));
      throw new HttpError(429, 'rate_limited', `Too many requests. Try again in ${retry} seconds.`);
    }
    await next();
  };
}
export function resetRateLimits(): void {
  counters.clear();
}

/* ───────────── sessions ───────────── */

export const cookieName = (d: Deps) => (d.config.cookie.secure && !d.config.cookie.domain ? '__Host-bp_session' : 'bp_session');

export async function startSession(c: Context<AppEnv>, user: User, ttlMs: number): Promise<{ token: string; expiresAt: string }> {
  const deps = c.get('deps');
  const token = randomToken(32);
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  await deps.store.createSession({ tokenHash: sha256Hex(token), userId: user.id, createdAt: now.toISOString(), expiresAt, userAgent: (c.req.header('user-agent') ?? '').slice(0, 200) || null });
  setCookie(c, cookieName(deps), token, {
    httpOnly: true,
    secure: deps.config.cookie.secure,
    sameSite: deps.config.cookie.sameSite,
    path: '/',
    maxAge: Math.floor(ttlMs / 1000),
    ...(deps.config.cookie.domain ? { domain: deps.config.cookie.domain } : {}),
  });
  return { token, expiresAt };
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  const deps = c.get('deps');
  deleteCookie(c, cookieName(deps), { path: '/', secure: deps.config.cookie.secure, ...(deps.config.cookie.domain ? { domain: deps.config.cookie.domain } : {}) });
}

/** resolves the caller (cookie or bearer token). never fails: use requireuser to enforce. */
export const authenticate = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const deps = c.get('deps');
  const auth = c.req.header('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
  const cookie = getCookie(c, cookieName(deps));
  const token = bearer || cookie;
  if (token && token.length >= 20 && token.length <= 200) {
    const found = await deps.store.getSession(sha256Hex(token));
    const now = deps.now();
    if (found && new Date(found.session.expiresAt) > now) {
      c.set('user', found.user);
      c.set('session', found.session);
      c.set('viaCookie', !bearer);
      // sliding expiry: renew once half the lifetime is gone
      const ttl = found.user.isGuest ? deps.config.guestTtlHours * 3_600_000 : deps.config.sessionTtlDays * 86_400_000;
      const remaining = new Date(found.session.expiresAt).getTime() - now.getTime();
      if (remaining < ttl / 2) {
        await deps.store.extendSession(found.session.tokenHash, new Date(now.getTime() + ttl).toISOString());
        await deps.store.touchUser(found.user.id, now.toISOString());
      }
    }
  }
  await next();
};

export const requireUser = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!c.get('user')) throw unauthorized();
  await next();
};

/** real (non-guest) accounts only: used for connecting external services. */
export const requireAccount = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const u = c.get('user');
  if (!u) throw unauthorized();
  if (u.isGuest) throw forbidden('guest_not_allowed', 'Sign in with Google to connect external accounts. Guests can still import .ics files and try everything else.');
  await next();
};

/**
 * csrf defence for cookie sessions. browsers always attach origin to cross-site post/put/patch/delete, so a request
 * from an origin we do not allow is refused; requests without origin must carry our custom header (which forces a cors preflight).
 * bearer-token requests carry no ambient credentials and are exempt.
 */
export const csrfGuard = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const m = c.req.method;
  if ((m === 'GET' || m === 'HEAD' || m === 'OPTIONS') || !c.get('viaCookie')) return next();
  const deps = c.get('deps');
  const origin = c.req.header('origin');
  if (origin) {
    if (!deps.config.appOrigins.includes(origin)) throw forbidden('csrf_blocked', 'This origin is not allowed to make changes.');
  } else if (!c.req.header('x-breakpoint-client')) {
    throw forbidden('csrf_blocked', 'Missing X-Breakpoint-Client header.');
  }
  await next();
};
