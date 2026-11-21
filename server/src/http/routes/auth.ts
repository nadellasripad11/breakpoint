import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.ts';
import { HttpError, unauthorized } from '../errors.ts';
import { clearSessionCookie, rateLimit, startSession } from '../middleware.ts';
import { randomToken, sha256Base64Url, sha256Hex } from '../../auth/crypto.ts';
import { LOGIN_SCOPES, OAuthError, buildAuthUrl, exchangeCode, revokeToken, verifyIdToken } from '../../auth/google.ts';
import { decryptSecret } from '../../auth/crypto.ts';
import { deleteAccountBody } from '../schemas.ts';
import { seedDemoSchedule } from './demoSeed.ts';
import type { User } from '../../store/types.ts';

export const userDto = (u: User) => ({ id: u.id, email: u.email, name: u.name, picture: u.picture, isGuest: u.isGuest, createdAt: u.createdAt });

/** only same-site relative paths: no open redirects. */
const safePath = z.string().max(200).regex(/^\/(?!\/)[A-Za-z0-9_\-./?=&%#]*$/).default('/');

export function authRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /* guest demo: no login, no personal data. sandbox account that expires and is purged automatically. */
  r.post('/guest', rateLimit('guest', 10, 3_600_000), async (c) => {
    const deps = c.get('deps');
    const existing = c.get('user');
    if (existing) return c.json({ user: userDto(existing), reused: true });
    const user = await deps.store.createUser({ id: deps.newId(), email: null, name: 'Guest', picture: null, googleSub: null, isGuest: true });
    const { token, expiresAt } = await startSession(c, user, deps.config.guestTtlHours * 3_600_000);
    const demoScheduleId = await seedDemoSchedule(deps, user.id, c.req.query('tz'));
    await deps.store.audit(user.id, 'guest.create', {}, deps.newId(), deps.now().toISOString());
    return c.json({ user: userDto(user), token, expiresAt, demoScheduleId, note: 'Guest data is deleted after 24 hours of inactivity. Sign in with Google to keep your schedules.' }, 201);
  });

  /* google sign-in (openid connect, authorization-code flow with pkce, state and nonce). */
  r.get('/google/start', rateLimit('auth', 20, 60_000), async (c) => {
    const deps = c.get('deps');
    const g = deps.config.google;
    if (!g) throw new HttpError(501, 'google_not_configured', 'Google sign-in is not configured on this server (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).');
    const redirectPath = safePath.parse(c.req.query('redirect') ?? '/');
    const verifier = randomToken(48);
    const state = randomToken(32);
    const nonce = randomToken(16);
    const now = deps.now();
    const guest = c.get('user')?.isGuest ? c.get('user')!.id : null; // a guest who signs in keeps their schedules
    await deps.store.saveOAuthState({ stateHash: sha256Hex(state), purpose: 'login', codeVerifier: verifier, nonce, userId: guest, redirectPath, expiresAt: new Date(now.getTime() + 600_000).toISOString() });
    const url = buildAuthUrl({ clientId: g.clientId, clientSecret: g.clientSecret, redirectUri: `${deps.config.apiUrl}/api/auth/google/callback` }, { state, nonce, challenge: sha256Base64Url(verifier), scopes: LOGIN_SCOPES });
    return c.req.query('mode') === 'redirect' ? c.redirect(url, 302) : c.json({ url });
  });

  r.get('/google/callback', rateLimit('auth', 30, 60_000), async (c) => {
    const deps = c.get('deps');
    const g = deps.config.google;
    const fail = (code: string) => c.redirect(`${deps.config.appUrl}/?auth_error=${encodeURIComponent(code)}`, 302);
    if (!g) return fail('google_not_configured');
    if (c.req.query('error')) return fail('access_denied');
    const code = c.req.query('code') ?? '';
    const state = c.req.query('state') ?? '';
    if (code.length < 10 || code.length > 2048 || state.length < 20 || state.length > 200) return fail('invalid_request');
    const st = await deps.store.consumeOAuthState(sha256Hex(state), deps.now().toISOString());
    if (!st || st.purpose !== 'login') return fail('invalid_state');
    let identity;
    try {
      const tokens = await exchangeCode(deps.fetch, { clientId: g.clientId, clientSecret: g.clientSecret, redirectUri: `${deps.config.apiUrl}/api/auth/google/callback` }, code, st.codeVerifier);
      if (!tokens.idToken) throw new OAuthError('invalid_id_token', 'Google did not return an identity token.');
      identity = await verifyIdToken(deps.fetch, tokens.idToken, { clientId: g.clientId, nonce: st.nonce, now: deps.now().getTime() });
      // sign-in only: we never keep the access token we just received
    } catch (e) {
      return fail(e instanceof OAuthError ? e.code : 'sign_in_failed');
    }
    let user = await deps.store.findUserByGoogleSub(identity.sub);
    if (!user) {
      const byEmail = await deps.store.findUserByEmail(identity.email);
      if (byEmail && !byEmail.googleSub && !byEmail.isGuest) {
        await deps.store.updateUserProfile(byEmail.id, { googleSub: identity.sub });
        user = (await deps.store.getUser(byEmail.id))!;
      }
    }
    if (!user) user = await deps.store.createUser({ id: deps.newId(), email: identity.email, name: identity.name, picture: identity.picture, googleSub: identity.sub, isGuest: false });
    else await deps.store.updateUserProfile(user.id, { name: identity.name, picture: identity.picture, email: identity.email });
    // a guest who signed in brings their schedules along; the sandbox account is then removed
    if (st.userId && st.userId !== user.id) {
      const guest = await deps.store.getUser(st.userId);
      if (guest?.isGuest) {
        await deps.store.moveSchedules(guest.id, user.id);
        await deps.store.deleteUser(guest.id);
      }
    }
    await startSession(c, user, deps.config.sessionTtlDays * 86_400_000);
    await deps.store.audit(user.id, 'login.google', {}, deps.newId(), deps.now().toISOString());
    // cross-site frontends cannot read our cookie: hand them a single-use code in the url fragment (fragments are never sent to a server)
    const handoff = randomToken(32);
    await deps.store.saveLoginCode(sha256Hex(handoff), user.id, new Date(deps.now().getTime() + 120_000).toISOString());
    return c.redirect(`${deps.config.appUrl}${st.redirectPath.split('#')[0]}#bp_code=${handoff}`, 302);
  });

  /** trades the single-use code from the sign-in redirect for a session token (token mode / cross-site frontends). */
  r.post('/exchange', rateLimit('auth', 20, 60_000), async (c) => {
    const deps = c.get('deps');
    const { code } = z.object({ code: z.string().min(20).max(200) }).strict().parse(await c.req.json());
    const userId = await deps.store.consumeLoginCode(sha256Hex(code), deps.now().toISOString());
    const user = userId ? await deps.store.getUser(userId) : null;
    if (!user) throw new HttpError(400, 'invalid_code', 'This sign-in code is invalid, expired or already used. Sign in again.');
    const { token, expiresAt } = await startSession(c, user, deps.config.sessionTtlDays * 86_400_000);
    return c.json({ user: userDto(user), token, expiresAt });
  });

  r.post('/logout', async (c) => {
    const s = c.get('session');
    if (s) await c.get('deps').store.deleteSession(s.tokenHash);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  return r;
}

export function meRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/', (c) => {
    const u = c.get('user');
    if (!u) throw unauthorized();
    return c.json({ user: userDto(u), sessionExpiresAt: c.get('session')!.expiresAt });
  });

  /** gdpr-style erase: revokes google access, deletes the account and, by cascade, every schedule, item, connection and run. */
  r.delete('/', async (c) => {
    const deps = c.get('deps');
    const u = c.get('user');
    if (!u) throw unauthorized();
    deleteAccountBody.parse(await c.req.json().catch(() => ({})));
    for (const conn of await deps.store.listConnections(u.id)) {
      if (conn.provider === 'google' && conn.refreshTokenEnc) {
        try {
          await revokeToken(deps.fetch, decryptSecret(conn.refreshTokenEnc, deps.config.tokenEncKey));
        } catch {
          /* best effort */
        }
      }
    }
    await deps.store.deleteUser(u.id);
    clearSessionCookie(c);
    return c.body(null, 204);
  });
  return r;
}
