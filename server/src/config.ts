import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  databasePath: string;
  /** Browser origins allowed to call the API (CORS) and to receive redirects after sign-in. */
  appOrigins: string[];
  /** Where the user lands after OAuth completes (first allowed origin by default). */
  appUrl: string;
  /** Public base URL of THIS API; used to build OAuth redirect URIs. */
  apiUrl: string;
  cookie: { secure: boolean; sameSite: 'Lax' | 'Strict' | 'None'; domain?: string };
  /** Trust X-Forwarded-For for rate limiting (only behind a proxy you control). */
  trustProxy: boolean;
  /** 32-byte AES-256-GCM key for stored OAuth tokens. */
  tokenEncKey: Buffer;
  google: { clientId: string; clientSecret: string } | null;
  sessionTtlDays: number;
  guestTtlHours: number;
  limits: {
    maxSchedulesUser: number;
    maxSchedulesGuest: number;
    maxItemsPerSchedule: number;
    maxRunsPerSchedule: number;
    maxInlineItems: number;
  };
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_PATH: z.string().default('./data/breakpoint.db'),
  APP_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  API_URL: z.string().optional(),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  COOKIE_SAMESITE: z.enum(['Lax', 'Strict', 'None']).optional(),
  COOKIE_DOMAIN: z.string().optional(),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  TOKEN_ENC_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  GUEST_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
});

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const e = parsed.data;
  const prod = e.NODE_ENV === 'production';

  const origins = e.APP_ORIGINS.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  for (const o of origins) {
    try {
      const u = new URL(o);
      if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
      if (prod && u.protocol !== 'https:' && u.hostname !== 'localhost') throw new Error('production origins must use https');
    } catch (err) {
      throw new ConfigError(`APP_ORIGINS contains an invalid origin "${o}": ${(err as Error).message}`);
    }
  }
  if (origins.length === 0) throw new ConfigError('APP_ORIGINS must list at least one origin.');

  let key: Buffer;
  if (e.TOKEN_ENC_KEY) {
    key = Buffer.from(e.TOKEN_ENC_KEY, 'base64');
    if (key.length !== 32) throw new ConfigError('TOKEN_ENC_KEY must be 32 bytes, base64 encoded (generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))").');
  } else if (prod) {
    throw new ConfigError('TOKEN_ENC_KEY is required in production.');
  } else {
    key = randomBytes(32); // dev only: stored tokens become unreadable after a restart, which is fine locally
  }

  const secure = e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : prod;
  const sameSite = e.COOKIE_SAMESITE ?? 'Lax';
  if (sameSite === 'None' && !secure) throw new ConfigError('COOKIE_SAMESITE=None requires COOKIE_SECURE=true.');
  if (prod && !secure) throw new ConfigError('COOKIE_SECURE must be true in production.');

  const google = e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET } : null;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    databasePath: e.DATABASE_PATH,
    appOrigins: origins,
    appUrl: origins[0]!,
    apiUrl: (e.API_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, ''),
    cookie: { secure, sameSite, ...(e.COOKIE_DOMAIN ? { domain: e.COOKIE_DOMAIN } : {}) },
    trustProxy: e.TRUST_PROXY === 'true',
    tokenEncKey: key,
    google,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    guestTtlHours: e.GUEST_TTL_HOURS,
    limits: { maxSchedulesUser: 50, maxSchedulesGuest: 3, maxItemsPerSchedule: 2000, maxRunsPerSchedule: 100, maxInlineItems: 300 },
  };
}
