import { Hono } from 'hono';
import type { AppEnv, Deps } from '../context.ts';
import { HttpError, notFound } from '../errors.ts';
import { rateLimit, requireAccount } from '../middleware.ts';
import { googleConnectBody, notionConnectBody } from '../schemas.ts';
import { currentUser } from './shared.ts';
import { decryptSecret, encryptSecret, randomToken, sha256Base64Url, sha256Hex } from '../../auth/crypto.ts';
import { GOOGLE_READONLY_SCOPE, OAuthError, assertReadOnlyCalendarScopes, buildAuthUrl, exchangeCode, refreshAccessToken, revokeToken } from '../../auth/google.ts';
import { listCalendars } from '../../integrations/googleCalendar.ts';
import { listDatabases, verifyToken } from '../../integrations/notion.ts';
import type { Connection } from '../../store/types.ts';

const connDto = (c: Connection) => ({ id: c.id, provider: c.provider, accountLabel: c.accountLabel, scopes: c.scopes, consentAt: c.consentAt, createdAt: c.createdAt, access: 'read-only' as const });

function googleClient(deps: Deps) {
  const g = deps.config.google;
  if (!g) throw new HttpError(501, 'google_not_configured', 'Google is not configured on this server (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).');
  return { clientId: g.clientId, clientSecret: g.clientSecret, redirectUri: `${deps.config.apiUrl}/api/connections/google/callback` };
}

/** Decrypts (and refreshes if needed) the Google access token for a stored connection. */
export async function googleAccessToken(deps: Deps, conn: Connection): Promise<string> {
  const now = deps.now().getTime();
  if (conn.accessTokenEnc && conn.tokenExpiresAt && new Date(conn.tokenExpiresAt).getTime() - now > 60_000) return decryptSecret(conn.accessTokenEnc, deps.config.tokenEncKey);
  if (!conn.refreshTokenEnc) throw new HttpError(409, 'reconnect_required', 'This Google connection expired. Reconnect Google Calendar.');
  let t;
  try {
    t = await refreshAccessToken(deps.fetch, googleClient(deps), decryptSecret(conn.refreshTokenEnc, deps.config.tokenEncKey));
  } catch {
    throw new HttpError(409, 'reconnect_required', 'Google no longer accepts this connection. Reconnect Google Calendar.');
  }
  await deps.store.updateConnectionTokens(conn.id, { accessTokenEnc: encryptSecret(t.accessToken, deps.config.tokenEncKey), tokenExpiresAt: new Date(now + t.expiresIn * 1000).toISOString() });
  return t.accessToken;
}

export function notionToken(deps: Deps, conn: Connection): string {
  if (!conn.accessTokenEnc) throw new HttpError(409, 'reconnect_required', 'This Notion connection has no token. Reconnect Notion.');
  return decryptSecret(conn.accessTokenEnc, deps.config.tokenEncKey);
}

async function revokeConnection(deps: Deps, conn: Connection): Promise<boolean> {
  if (conn.provider !== 'google') return true; // Notion tokens are revoked by removing the integration in Notion
  const tok = conn.refreshTokenEnc ?? conn.accessTokenEnc;
  if (!tok) return true;
  try {
    return await revokeToken(deps.fetch, decryptSecret(tok, deps.config.tokenEncKey));
  } catch {
    return false;
  }
}

export function connectionRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const u = currentUser(c);
    return c.json({ connections: (await c.get('deps').store.listConnections(u.id)).map(connDto) });
  });

  /**
   * Step 1: the user explicitly agrees (acknowledge + the exact read-only scope they were shown).
   * Nothing is requested from Google without it, and only calendar.readonly is ever requested.
   */
  r.post('/google/start', requireAccount(), rateLimit('connect', 10, 60_000, 'user'), async (c) => {
    const deps = c.get('deps');
    const u = currentUser(c);
    const body = googleConnectBody.parse(await c.req.json());
    const client = googleClient(deps);
    const redirectPath = /^\/(?!\/)[A-Za-z0-9_\-./?=&%#]*$/.test(body.redirect ?? '/') ? (body.redirect ?? '/') : '/';
    const verifier = randomToken(48);
    const state = randomToken(32);
    await deps.store.saveOAuthState({ stateHash: sha256Hex(state), purpose: 'connect_google', codeVerifier: verifier, nonce: null, userId: u.id, redirectPath, expiresAt: new Date(deps.now().getTime() + 600_000).toISOString() });
    await deps.store.audit(u.id, 'connection.google.consent_requested', { scopes: body.scopes }, deps.newId(), deps.now().toISOString());
    return c.json({ url: buildAuthUrl(client, { state, challenge: sha256Base64Url(verifier), scopes: [GOOGLE_READONLY_SCOPE], offline: true }), scopes: [GOOGLE_READONLY_SCOPE], access: 'read-only' });
  });

  /** Step 2: Google redirects the browser here. The single-use state ties it to the user who consented. */
  r.get('/google/callback', rateLimit('auth', 30, 60_000), async (c) => {
    const deps = c.get('deps');
    const fail = (code: string) => c.redirect(`${deps.config.appUrl}/?connect_error=${encodeURIComponent(code)}`, 302);
    if (c.req.query('error')) return fail('access_denied');
    const code = c.req.query('code') ?? '';
    const state = c.req.query('state') ?? '';
    if (code.length < 10 || code.length > 2048 || state.length < 20 || state.length > 200) return fail('invalid_request');
    const st = await deps.store.consumeOAuthState(sha256Hex(state), deps.now().toISOString());
    if (!st || st.purpose !== 'connect_google' || !st.userId) return fail('invalid_state');
    let client;
    try {
      client = googleClient(deps);
    } catch {
      return fail('google_not_configured');
    }
    let tokens;
    try {
      tokens = await exchangeCode(deps.fetch, client, code, st.codeVerifier);
      assertReadOnlyCalendarScopes(tokens.scopes);
      if (!tokens.refreshToken) throw new OAuthError('no_refresh_token', 'Google did not allow ongoing read access.');
    } catch (e) {
      // refuse and clean up: if Google granted more than we asked for, nothing is stored and the grant is revoked
      const anyToken = (tokens as { accessToken?: string } | undefined)?.accessToken;
      if (anyToken) await revokeToken(deps.fetch, anyToken);
      return fail(e instanceof OAuthError ? e.code : 'connect_failed');
    }
    let label: string | null = null;
    try {
      const cals = await listCalendars(deps.fetch, tokens.accessToken);
      label = cals.find((x) => x.primary)?.name ?? cals[0]?.name ?? null;
    } catch {
      /* label is cosmetic */
    }
    for (const old of (await deps.store.listConnections(st.userId)).filter((x) => x.provider === 'google')) {
      await revokeConnection(deps, old);
      await deps.store.deleteConnection(st.userId, old.id);
    }
    const now = deps.now();
    await deps.store.createConnection({
      id: deps.newId(),
      userId: st.userId,
      provider: 'google',
      accountLabel: label,
      scopes: [GOOGLE_READONLY_SCOPE],
      accessTokenEnc: encryptSecret(tokens.accessToken, deps.config.tokenEncKey),
      refreshTokenEnc: encryptSecret(tokens.refreshToken, deps.config.tokenEncKey),
      tokenExpiresAt: new Date(now.getTime() + tokens.expiresIn * 1000).toISOString(),
      consentAt: now.toISOString(),
      createdAt: now.toISOString(),
    });
    await deps.store.audit(st.userId, 'connection.google.connected', { scopes: [GOOGLE_READONLY_SCOPE] }, deps.newId(), now.toISOString());
    return c.redirect(`${deps.config.appUrl}${st.redirectPath}${st.redirectPath.includes('?') ? '&' : '?'}connected=google`, 302);
  });

  /** Notion: the user creates a read-only internal integration and pastes its token, after explicitly acknowledging. */
  r.post('/notion', requireAccount(), rateLimit('connect', 10, 60_000, 'user'), async (c) => {
    const deps = c.get('deps');
    const u = currentUser(c);
    const body = notionConnectBody.parse(await c.req.json());
    const who = await verifyToken(deps.fetch, body.token);
    for (const old of (await deps.store.listConnections(u.id)).filter((x) => x.provider === 'notion')) await deps.store.deleteConnection(u.id, old.id);
    const now = deps.now().toISOString();
    const conn: Connection = {
      id: deps.newId(),
      userId: u.id,
      provider: 'notion',
      accountLabel: who.label,
      scopes: ['read_content'],
      accessTokenEnc: encryptSecret(body.token, deps.config.tokenEncKey),
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      consentAt: now,
      createdAt: now,
    };
    await deps.store.createConnection(conn);
    await deps.store.audit(u.id, 'connection.notion.connected', {}, deps.newId(), now);
    return c.json({ connection: connDto(conn) }, 201);
  });

  r.delete('/:id', async (c) => {
    const deps = c.get('deps');
    const u = currentUser(c);
    const conn = await deps.store.getConnection(u.id, c.req.param('id'));
    if (!conn) throw notFound('Connection');
    const revoked = await revokeConnection(deps, conn);
    await deps.store.deleteConnection(u.id, conn.id);
    await deps.store.audit(u.id, `connection.${conn.provider}.disconnected`, { revoked }, deps.newId(), deps.now().toISOString());
    return c.json({ disconnected: true, revokedAtProvider: revoked, note: conn.provider === 'notion' ? 'Remove the integration in Notion to revoke the token there as well.' : undefined });
  });

  r.get('/:id/google/calendars', requireAccount(), rateLimit('provider', 30, 60_000, 'user'), async (c) => {
    const deps = c.get('deps');
    const conn = await deps.store.getConnection(currentUser(c).id, c.req.param('id'));
    if (!conn || conn.provider !== 'google') throw notFound('Connection');
    return c.json({ calendars: await listCalendars(deps.fetch, await googleAccessToken(deps, conn)) });
  });

  r.get('/:id/notion/databases', requireAccount(), rateLimit('provider', 30, 60_000, 'user'), async (c) => {
    const deps = c.get('deps');
    const conn = await deps.store.getConnection(currentUser(c).id, c.req.param('id'));
    if (!conn || conn.provider !== 'notion') throw notFound('Connection');
    return c.json({ databases: await listDatabases(deps.fetch, notionToken(deps, conn)) });
  });

  return r;
}
