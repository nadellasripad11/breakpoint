import { createLocalJWKSet, jwtVerify } from 'jose';
import type { JSONWebKeySet } from 'jose';
import { sha256Base64Url } from './crypto.ts';

export type Fetcher = typeof fetch;

export const GOOGLE_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const LOGIN_SCOPES = ['openid', 'email', 'profile'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkceFor(verifier: string): Pkce {
  return { verifier, challenge: sha256Base64Url(verifier) };
}

export function buildAuthUrl(c: GoogleClient, o: { state: string; nonce?: string; challenge: string; scopes: string[]; offline?: boolean }): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('redirect_uri', c.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', o.scopes.join(' '));
  u.searchParams.set('state', o.state);
  u.searchParams.set('code_challenge', o.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('include_granted_scopes', 'false'); // never silently widen what the user agreed to
  if (o.nonce) u.searchParams.set('nonce', o.nonce);
  if (o.offline) {
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
  } else {
    u.searchParams.set('prompt', 'select_account');
  }
  return u.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresIn: number;
  scopes: string[];
}

async function tokenCall(f: Fetcher, body: URLSearchParams): Promise<TokenResponse> {
  const res = await f(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') throw new OAuthError('token_exchange_failed', `Google rejected the request (${String(json.error ?? res.status)}).`);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    idToken: typeof json.id_token === 'string' ? json.id_token : null,
    expiresIn: Number(json.expires_in ?? 3600),
    scopes: String(json.scope ?? '').split(' ').filter(Boolean),
  };
}

export function exchangeCode(f: Fetcher, c: GoogleClient, code: string, verifier: string): Promise<TokenResponse> {
  return tokenCall(f, new URLSearchParams({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: 'authorization_code', code_verifier: verifier }));
}

export function refreshAccessToken(f: Fetcher, c: GoogleClient, refreshToken: string): Promise<TokenResponse> {
  return tokenCall(f, new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }));
}

/** Best effort: failure to revoke must not block the user from disconnecting. */
export async function revokeToken(f: Fetcher, token: string): Promise<boolean> {
  try {
    const res = await f(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
    return res.ok;
  } catch {
    return false;
  }
}

let jwksCache: { at: number; keys: JSONWebKeySet } | null = null;
async function getJwks(f: Fetcher, now: number): Promise<JSONWebKeySet> {
  if (jwksCache && now - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await f(JWKS_URL);
  if (!res.ok) throw new OAuthError('jwks_unavailable', 'Could not fetch Google signing keys.');
  const keys = (await res.json()) as JSONWebKeySet;
  jwksCache = { at: now, keys };
  return keys;
}
export function resetJwksCache(): void {
  jwksCache = null;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/** Verifies signature (Google's published keys), issuer, audience, expiry and the nonce we generated. */
export async function verifyIdToken(f: Fetcher, idToken: string, o: { clientId: string; nonce: string | null; now?: number }): Promise<GoogleIdentity> {
  const jwks = createLocalJWKSet(await getJwks(f, o.now ?? Date.now()));
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: o.clientId, ...(o.now ? { currentDate: new Date(o.now) } : {}) }));
  } catch (e) {
    throw new OAuthError('invalid_id_token', `The Google sign-in token could not be verified (${(e as Error).message}).`);
  }
  if (o.nonce && payload.nonce !== o.nonce) throw new OAuthError('nonce_mismatch', 'The sign-in response did not match this request.');
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw new OAuthError('invalid_id_token', 'The Google token is missing an account id or email.');
  if (payload.email_verified !== true) throw new OAuthError('email_unverified', 'Your Google email address is not verified.');
  return { sub: payload.sub, email: payload.email.toLowerCase(), emailVerified: true, name: typeof payload.name === 'string' ? payload.name : null, picture: typeof payload.picture === 'string' ? payload.picture : null };
}

/** The consent screen must grant EXACTLY read-only calendar access: reject anything broader. */
export function assertReadOnlyCalendarScopes(granted: string[]): void {
  if (!granted.includes(GOOGLE_READONLY_SCOPE)) throw new OAuthError('scope_missing', 'Read-only calendar access was not granted.');
  const extra = granted.filter((s) => s !== GOOGLE_READONLY_SCOPE && !LOGIN_SCOPES.includes(s) && s !== 'https://www.googleapis.com/auth/userinfo.email' && s !== 'https://www.googleapis.com/auth/userinfo.profile');
  if (extra.length) throw new OAuthError('scope_too_broad', `Google granted more access than Breakpoint asked for (${extra.join(', ')}). Nothing was saved.`);
}
