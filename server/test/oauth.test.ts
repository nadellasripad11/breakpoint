import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { KeyObject } from 'node:crypto';
import { client, cookiePair, makeApp, makeUser } from './apiHelpers.ts';
import type { TestApp } from './apiHelpers.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { decryptSecret, encryptSecret } from '../src/auth/crypto.ts';
import type { Fetcher } from '../src/auth/google.ts';

type Call = { method: string; url: string; body: string; auth: string | null };

/** a pretend internet: records every request and answers from a handler. */
function fake(handler: (c: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  const f: Fetcher = async (input, init) => {
    const url = String(input);
    const call: Call = { method: (init?.method ?? 'GET').toUpperCase(), url, body: init?.body ? String(init.body) : '', auth: new Headers(init?.headers).get('authorization') };
    calls.push(call);
    return (await handler(call)) ?? new Response(`unexpected request: ${call.method} ${url}`, { status: 599 });
  };
  return { f, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

const READONLY = 'https://www.googleapis.com/auth/calendar.readonly';

async function googleKeys() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  return { privateKey: privateKey as unknown as KeyObject, jwk };
}

function idToken(key: KeyObject, o: { nonce?: string; email?: string; verified?: boolean; sub?: string; aud?: string; kid?: string }) {
  return new SignJWT({ email: o.email ?? 'sam@example.com', email_verified: o.verified ?? true, name: 'Sam Student', picture: 'https://example.com/p.png', ...(o.nonce ? { nonce: o.nonce } : {}) })
    .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? 'k1' })
    .setIssuer('https://accounts.google.com')
    .setAudience(o.aud ?? 'test-client-id')
    .setSubject(o.sub ?? 'google-sub-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

const q = (url: string) => new URL(url).searchParams;

/* ───────────── google sign-in ───────────── */

test('Google sign-in: PKCE + state + nonce, verified ID token, session cookie; replay, bad nonce, bad signature and unverified email are refused', async () => {
  const { privateKey, jwk } = await googleKeys();
  const wrong = await generateKeyPair('RS256', { extractable: true });
  let nextToken: () => Promise<string> = async () => '';
  const net = fake((c) => {
    if (c.url === 'https://www.googleapis.com/oauth3/v3/certs'.replace('oauth3', 'oauth2')) return json({ keys: [jwk] });
    if (c.url === 'https://oauth2.googleapis.com/token') return nextToken().then((t) => json({ access_token: 'at-login', id_token: t, expires_in: 3600, scope: 'openid email profile' }));
    return undefined;
  });
  const t = await makeApp({ fetch: net.f });
  const call = client(t);

  const start = async (headers?: { token?: string }) => {
    const r = await call('GET', '/api/auth/google/start?redirect=/app', headers?.token ? { token: headers.token } : {});
    assert.equal(r.status, 200, r.text);
    const p = q(r.json.url);
    return { state: p.get('state')!, nonce: p.get('nonce')!, url: r.json.url as string, p };
  };

  const s1 = await start();
  assert.equal(s1.p.get('client_id'), 'test-client-id');
  assert.equal(s1.p.get('redirect_uri'), 'http://api.test/api/auth/google/callback');
  assert.equal(s1.p.get('code_challenge_method'), 'S256');
  assert.ok(s1.p.get('code_challenge')!.length >= 40);
  assert.equal(s1.p.get('scope'), 'openid email profile'); // sign-in asks for identity only, never calendar access
  assert.equal(s1.p.get('response_type'), 'code');

  nextToken = () => idToken(privateKey, { nonce: s1.nonce });
  const ok = await call('GET', `/api/auth/google/callback?code=authcode-123456&state=${s1.state}`);
  assert.equal(ok.status, 302);
  const loc = ok.headers.get('location')!;
  assert.match(loc, /^http:\/\/localhost:5173\/app#bp_code=[A-Za-z0-9_-]{30,}$/); // single-use handoff code in the fragment
  const handoff = loc.split('#bp_code=')[1]!;
  const cookie = cookiePair(ok);
  assert.match(cookie, /bp_session=/);
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.json.user.email, 'sam@example.com');
  assert.equal(me.json.user.isGuest, false);
  // the token request carried the pkce verifier, and we kept nothing but the identity
  const tokenReq = new URLSearchParams(net.calls.find((c) => c.url.endsWith('/token'))!.body);
  assert.ok(tokenReq.get('code_verifier')!.length >= 43);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS c FROM connections').get()!.c, 0);

  // cross-site frontends exchange the code for a session token (once)
  const ex = await call('POST', '/api/auth/exchange', { body: { code: handoff } });
  assert.equal(ex.status, 200, ex.text);
  assert.equal((await call('GET', '/api/me', { token: ex.json.token })).json.user.email, 'sam@example.com');
  assert.equal((await call('POST', '/api/auth/exchange', { body: { code: handoff } })).json.error.code, 'invalid_code'); // single use
  assert.equal((await call('POST', '/api/auth/exchange', { body: { code: 'x'.repeat(43) } })).status, 400);

  // replaying the same state fails (single use)
  const replay = await call('GET', `/api/auth/google/callback?code=authcode-123456&state=${s1.state}`);
  assert.equal(replay.headers.get('location'), 'http://localhost:5173/?auth_error=invalid_state');

  // wrong nonce
  const s2 = await start();
  nextToken = () => idToken(privateKey, { nonce: 'not-the-nonce' });
  assert.match((await call('GET', `/api/auth/google/callback?code=authcode-123456&state=${s2.state}`)).headers.get('location')!, /auth_error=nonce_mismatch/);
  // forged signature
  const s3 = await start();
  nextToken = () => idToken(wrong.privateKey as unknown as KeyObject, { nonce: s3.nonce });
  assert.match((await call('GET', `/api/auth/google/callback?code=authcode-123456&state=${s3.state}`)).headers.get('location')!, /auth_error=invalid_id_token/);
  // wrong audience
  const s4 = await start();
  nextToken = () => idToken(privateKey, { nonce: s4.nonce, aud: 'someone-elses-client' });
  assert.match((await call('GET', `/api/auth/google/callback?code=authcode-123456&state=${s4.state}`)).headers.get('location')!, /auth_error=invalid_id_token/);
  // unverified email
  const s5 = await start();
  nextToken = () => idToken(privateKey, { nonce: s5.nonce, verified: false });
  assert.match((await call('GET', `/api/auth/google/callback?code=authcode-123456&state=${s5.state}`)).headers.get('location')!, /auth_error=email_unverified/);
  // user denied consent
  assert.match((await call('GET', '/api/auth/google/callback?error=access_denied')).headers.get('location')!, /auth_error=access_denied/);
  // no open redirects
  assert.equal((await call('GET', '/api/auth/google/start?redirect=//evil.example')).status, 400);
  assert.equal((await call('GET', '/api/auth/google/start?redirect=https://evil.example')).status, 400);
  // logout kills the session
  assert.equal((await call('POST', '/api/auth/logout', { cookie, headers: { origin: 'http://localhost:5173' } })).status, 204);
  assert.equal((await call('GET', '/api/me', { cookie })).status, 401);
});

test('a guest who signs in with Google keeps their schedules; the sandbox account disappears', async () => {
  const { privateKey, jwk } = await googleKeys();
  let nonce = '';
  const net = fake((c) => {
    if (c.url.includes('/oauth2/v3/certs')) return json({ keys: [jwk] });
    if (c.url.endsWith('/token')) return idToken(privateKey, { nonce, email: 'merge@example.com', sub: 'sub-merge' }).then((t) => json({ access_token: 'x', id_token: t, expires_in: 3600, scope: 'openid email profile' }));
    return undefined;
  });
  const t = await makeApp({ fetch: net.f });
  const call = client(t);
  const g = await call('POST', '/api/auth/guest?tz=America/Chicago');
  const guestId = g.json.user.id as string;
  const start = await call('GET', '/api/auth/google/start', { token: g.json.token });
  nonce = q(start.json.url).get('nonce')!;
  const cb = await call('GET', `/api/auth/google/callback?code=authcode-123456&state=${q(start.json.url).get('state')}`);
  assert.equal(cb.status, 302);
  const list = await call('GET', '/api/schedules', { cookie: cookiePair(cb) });
  assert.equal(list.json.schedules.length, 1);
  assert.equal(list.json.schedules[0].id, g.json.demoScheduleId);
  assert.equal(await t.store.getUser(guestId), null);
  assert.equal((await call('GET', '/api/me', { token: g.json.token })).status, 401); // the guest session is gone
});

test('Google sign-in reports clearly when it is not configured', async () => {
  const t = await makeApp({ env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } });
  const r = await client(t)('GET', '/api/auth/google/start');
  assert.equal(r.status, 501);
  assert.equal(r.json.error.code, 'google_not_configured');
});

/* ───────────── google calendar connection: explicit consent, read-only ───────────── */

async function connectGoogle(t: TestApp, userToken: string, net: ReturnType<typeof fake>, grant: { scope: string; refresh?: boolean } = { scope: READONLY }) {
  const call = client(t);
  const start = await call('POST', '/api/connections/google/start', { token: userToken, body: { acknowledge: true, scopes: [READONLY] } });
  assert.equal(start.status, 200, start.text);
  return { start, call, finish: () => call('GET', `/api/connections/google/callback?code=authcode-123456&state=${q(start.json.url).get('state')}`), net, grant };
}

test('connecting Google: needs explicit acknowledgement of the read-only scope; anything broader is refused and revoked', async () => {
  let grant = { scope: READONLY, refresh: true };
  const net = fake((c) => {
    if (c.url.endsWith('/token')) return json({ access_token: 'ACCESS-TOKEN-XYZ', ...(grant.refresh ? { refresh_token: 'REFRESH-TOKEN-XYZ' } : {}), expires_in: 3600, scope: grant.scope });
    if (c.url.includes('/calendarList')) return json({ items: [{ id: 'primary@example.com', summary: 'Sam Student', primary: true, timeZone: 'America/Chicago' }] });
    if (c.url.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
    return undefined;
  });
  const t = await makeApp({ fetch: net.f });
  const call = client(t);
  const u = await makeUser(t);

  // consent must be explicit and name exactly the read-only scope
  assert.equal((await call('POST', '/api/connections/google/start', { token: u.token, body: {} })).status, 400);
  assert.equal((await call('POST', '/api/connections/google/start', { token: u.token, body: { acknowledge: false, scopes: [READONLY] } })).status, 400);
  assert.equal((await call('POST', '/api/connections/google/start', { token: u.token, body: { acknowledge: true, scopes: ['https://www.googleapis.com/auth/calendar'] } })).status, 400);
  assert.equal((await call('POST', '/api/connections/google/start', { token: u.token, body: { acknowledge: true, scopes: [READONLY, 'https://www.googleapis.com/auth/calendar'] } })).status, 400);
  assert.equal((await call('POST', '/api/connections/google/start')).status, 401);
  assert.equal(net.calls.length, 0, 'nothing is requested from Google before consent');

  const s = await connectGoogle(t, u.token, net);
  const p = q(s.start.json.url);
  assert.equal(p.get('scope'), READONLY);
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('include_granted_scopes'), 'false');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(s.start.json.access, 'read-only');

  // google granted more than we asked for: nothing is stored and the grant is revoked
  grant = { scope: `${READONLY} https://www.googleapis.com/auth/calendar`, refresh: true };
  const broad = await s.finish();
  assert.match(broad.headers.get('location')!, /connect_error=scope_too_broad/);
  assert.equal((await call('GET', '/api/connections', { token: u.token })).json.connections.length, 0);
  assert.ok(net.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke') && c.body.includes('ACCESS-TOKEN-XYZ')));

  // no ongoing (refresh) access
  grant = { scope: READONLY, refresh: false };
  const s2 = await connectGoogle(t, u.token, net);
  assert.match((await s2.finish()).headers.get('location')!, /connect_error=no_refresh_token/);

  // the real thing
  grant = { scope: READONLY, refresh: true };
  const s3 = await connectGoogle(t, u.token, net);
  const done = await s3.finish();
  assert.match(done.headers.get('location')!, /connected=google/);
  const list = await call('GET', '/api/connections', { token: u.token });
  assert.equal(list.json.connections.length, 1);
  const conn = list.json.connections[0];
  assert.equal(conn.provider, 'google');
  assert.equal(conn.access, 'read-only');
  assert.deepEqual(conn.scopes, [READONLY]);
  assert.equal(conn.accountLabel, 'Sam Student');
  assert.ok(!('accessTokenEnc' in conn) && !JSON.stringify(list.json).includes('TOKEN')); // tokens never leave the server
  // tokens are encrypted at rest (aes-256-gcm), and decrypt with the server key only
  const row = t.store.db.prepare('SELECT access_token_enc, refresh_token_enc FROM connections').get() as { access_token_enc: string; refresh_token_enc: string };
  assert.match(row.access_token_enc, /^v1\./);
  assert.ok(!row.access_token_enc.includes('ACCESS-TOKEN-XYZ') && !row.refresh_token_enc.includes('REFRESH-TOKEN-XYZ'));
  assert.equal(decryptSecret(row.refresh_token_enc, t.config.tokenEncKey), 'REFRESH-TOKEN-XYZ');
  assert.throws(() => decryptSecret(row.refresh_token_enc, Buffer.alloc(32, 9)));
});

test('importing from Google Calendar: needs per-import confirmation, performs only GET requests, never writes back', async () => {
  const net = fake((c) => {
    if (c.url.endsWith('/token')) return json({ access_token: 'ACCESS-TOKEN-XYZ', refresh_token: 'REFRESH-TOKEN-XYZ', expires_in: 3600, scope: READONLY });
    if (c.url.includes('/calendarList')) return json({ items: [{ id: 'primary@example.com', summary: 'Sam', primary: true, timeZone: 'America/Chicago' }] });
    if (c.url.includes('/calendars/primary%40example.com/events')) {
      return json({
        items: [
          { id: 'g1', summary: 'Calculus', status: 'confirmed', start: { dateTime: '2026-11-20T09:00:00-06:00', timeZone: 'America/Chicago' }, end: { dateTime: '2026-11-20T10:30:00-06:00' } },
          { id: 'g2', summary: 'Thanksgiving', status: 'confirmed', start: { date: '2026-11-26' }, end: { date: '2026-11-27' } },
          { id: 'g3', summary: 'Cancelled', status: 'cancelled', start: { dateTime: '2026-11-20T12:00:00-06:00' }, end: { dateTime: '2026-11-20T13:00:00-06:00' } },
          { id: 'g4', summary: 'Free slot', transparency: 'transparent', start: { dateTime: '2026-11-20T14:00:00-06:00' }, end: { dateTime: '2026-11-20T15:00:00-06:00' } },
        ],
      });
    }
    if (c.url.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
    return undefined;
  });
  const t = await makeApp({ fetch: net.f });
  const call = client(t);
  const u = await makeUser(t);
  await (await connectGoogle(t, u.token, net)).finish();
  const conn = (await call('GET', '/api/connections', { token: u.token })).json.connections[0];
  const sched = (await call('POST', '/api/schedules', { token: u.token, body: { name: 'School', timezone: 'America/Chicago' } })).json.schedule.id as string;

  const cals = await call('GET', `/api/connections/${conn.id}/google/calendars`, { token: u.token });
  assert.equal(cals.json.calendars[0].primary, true);

  const body = { connectionId: conn.id, calendarId: 'primary@example.com', from: '2026-11-01T00:00:00-06:00', to: '2026-12-01T00:00:00-06:00' };
  assert.equal((await call('POST', `/api/schedules/${sched}/import/google`, { token: u.token, body })).status, 400); // confirm is required
  assert.equal((await call('POST', `/api/schedules/${sched}/import/google`, { token: u.token, body: { ...body, confirm: false } })).status, 400);
  const dry = await call('POST', `/api/schedules/${sched}/import/google`, { token: u.token, body: { ...body, confirm: true, dryRun: true } });
  assert.equal(dry.json.wouldImport, 3);
  assert.equal((await call('GET', `/api/schedules/${sched}/items`, { token: u.token })).json.items.length, 0);

  const res = await call('POST', `/api/schedules/${sched}/import/google`, { token: u.token, body: { ...body, confirm: true } });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.imported, { created: 3, updated: 0 });
  assert.equal(res.json.skipped, 1); // the cancelled event
  const items = (await call('GET', `/api/schedules/${sched}/items`, { token: u.token })).json.items as { title: string; allDay: boolean; blocking: boolean; source: string }[];
  assert.equal(items.find((i) => i.title === 'Thanksgiving')!.blocking, false);
  assert.equal(items.find((i) => i.title === 'Free slot')!.blocking, false);
  assert.ok(items.every((i) => i.source === 'google'));
  assert.deepEqual((await call('POST', `/api/schedules/${sched}/import/google`, { token: u.token, body: { ...body, confirm: true } })).json.imported, { created: 0, updated: 3 });

  // read-only, proven: every request to the calendar api was a get, and only the read-only scope was ever requested
  const calendarCalls = net.calls.filter((c) => c.url.startsWith('https://www.googleapis.com/calendar/'));
  assert.ok(calendarCalls.length >= 3);
  assert.ok(calendarCalls.every((c) => c.method === 'GET'), 'Breakpoint must never write to Google Calendar');
  assert.ok(calendarCalls.every((c) => c.auth === 'Bearer ACCESS-TOKEN-XYZ'));
  const eventsUrl = new URL(calendarCalls.find((c) => c.url.includes('/events'))!.url);
  assert.ok(!eventsUrl.searchParams.get('fields')!.match(/description|attendees|location|htmlLink/)); // private details are not even requested
  assert.ok(net.calls.filter((c) => c.method !== 'GET').every((c) => c.url.endsWith('/token') || c.url.includes('/revoke')));

  // another user cannot use this connection
  const other = await makeUser(t);
  const otherSched = (await call('POST', '/api/schedules', { token: other.token, body: { name: 'x', timezone: 'UTC' } })).json.schedule.id;
  assert.equal((await call('POST', `/api/schedules/${otherSched}/import/google`, { token: other.token, body: { ...body, confirm: true } })).status, 404);

  // disconnecting revokes at google and deletes the stored tokens
  const del = await call('DELETE', `/api/connections/${conn.id}`, { token: u.token });
  assert.equal(del.json.revokedAtProvider, true);
  assert.ok(net.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke') && c.body.includes('REFRESH-TOKEN-XYZ')));
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS c FROM connections').get()!.c, 0);
});

test('expired Google access tokens are refreshed transparently', async () => {
  const net = fake((c) => {
    if (c.url.endsWith('/token')) {
      const form = new URLSearchParams(c.body);
      return json({ access_token: form.get('grant_type') === 'refresh_token' ? 'FRESH-TOKEN' : 'ACCESS-TOKEN-XYZ', ...(form.get('grant_type') === 'authorization_code' ? { refresh_token: 'REFRESH-TOKEN-XYZ' } : {}), expires_in: 3600, scope: READONLY });
    }
    if (c.url.includes('/calendarList')) return json({ items: [] });
    return undefined;
  });
  const t = await makeApp({ fetch: net.f });
  const call = client(t);
  const u = await makeUser(t);
  await (await connectGoogle(t, u.token, net)).finish();
  const conn = (await call('GET', '/api/connections', { token: u.token })).json.connections[0];
  t.store.db.prepare('UPDATE connections SET token_expires_at = ?').run(new Date(Date.now() - 60_000).toISOString());
  const r = await call('GET', `/api/connections/${conn.id}/google/calendars`, { token: u.token });
  assert.equal(r.status, 200, r.text);
  assert.ok(net.calls.some((c) => c.url.endsWith('/token') && c.body.includes('grant_type=refresh_token')));
  assert.equal(net.calls.at(-1)!.auth, 'Bearer FRESH-TOKEN');
});

test('Notion works for a guest with no login: encrypted token, read-only import, and everything is erased with the guest', async () => {
  const DB = '0123456789abcdef0123456789abcdef';
  const net = fake((c) => {
    if (c.url === 'https://api.notion.com/v1/users/me') return json({ bot: { workspace_name: 'Guest WS' } });
    if (c.url === 'https://api.notion.com/v1/search') return json({ results: [{ id: DB, title: [{ plain_text: 'Homework' }], properties: { Name: { type: 'title' }, Due: { type: 'date' } } }] });
    if (c.url === `https://api.notion.com/v1/databases/${DB}/query`) return json({ results: [{ id: 'p1', archived: false, properties: { Name: { type: 'title', title: [{ plain_text: 'Essay' }] }, Due: { type: 'date', date: { start: '2026-11-25' } } } }], has_more: false });
    return undefined;
  });
  const t = await makeApp({ fetch: net.f });
  const call = client(t);
  const g = await call('POST', '/api/auth/guest?tz=America/Chicago');
  const token = g.json.token as string;
  const conn = await call('POST', '/api/connections/notion', { token, body: { acknowledge: true, token: 'secret_notion_token_value_123' } });
  assert.equal(conn.status, 201, conn.text);
  const stored = t.store.db.prepare('SELECT access_token_enc FROM connections').get() as { access_token_enc: string };
  assert.ok(!stored.access_token_enc.includes('secret_notion'), 'stored encrypted');
  assert.equal((await call('GET', `/api/connections/${conn.json.connection.id}/notion/databases`, { token })).json.databases[0].title, 'Homework');
  const res = await call('POST', `/api/schedules/${g.json.demoScheduleId}/import/notion`, { token, body: { connectionId: conn.json.connection.id, databaseId: DB, mapping: {}, confirm: true } });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.imported, { created: 1, updated: 0 });
  // google still needs a real sign-in
  assert.equal((await call('POST', '/api/connections/google/start', { token, body: { acknowledge: true, scopes: ['https://www.googleapis.com/auth/calendar.readonly'] } })).json.error.code, 'guest_not_allowed');
  // when the guest sandbox expires, the encrypted token goes with it
  const future = new Date(Date.now() + 48 * 3_600_000).toISOString();
  assert.ok((await t.store.purgeExpiredGuests(future)) >= 1);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS c FROM connections').get()!.c, 0);
});

/* ───────────── notion ───────────── */

test('Notion: explicit acknowledgement, encrypted token, read-only calls only, tasks with deadlines imported', async () => {
  const DB = '0123456789abcdef0123456789abcdef';
  const net = fake((c) => {
    if (c.url === 'https://api.notion.com/v1/users/me') return c.auth === 'Bearer secret_notion_token_value_123' ? json({ bot: { workspace_name: 'School WS' } }) : json({}, 401);
    if (c.url === 'https://api.notion.com/v1/search') return json({ results: [{ id: DB, title: [{ plain_text: 'Homework' }], properties: { Name: { type: 'title' }, Due: { type: 'date' } } }] });
    if (c.url === `https://api.notion.com/v1/databases/${DB}/query`) {
      const page = (id: string, name: string, extra: Record<string, unknown>) => ({ id, archived: false, properties: { Name: { type: 'title', title: [{ plain_text: name }] }, ...extra } });
      return json({
        results: [
          page('p1', 'Essay draft', { Due: { type: 'date', date: { start: '2026-11-25' } }, Minutes: { type: 'number', number: 120 }, Priority: { type: 'select', select: { name: 'High' } }, Status: { type: 'status', status: { name: 'In progress' } }, Subject: { type: 'select', select: { name: 'English' } } }),
          page('p2', 'Old task', { Status: { type: 'status', status: { name: 'Done' } } }),
          page('p3', 'Timed task', { Due: { type: 'date', date: { start: '2026-11-24T15:00:00-06:00' } } }),
        ],
        has_more: false,
      });
    }
    return undefined;
  });
  const t = await makeApp({ fetch: net.f });
  const call = client(t);
  const u = await makeUser(t);
  assert.equal((await call('POST', '/api/connections/notion', { token: u.token, body: { token: 'secret_notion_token_value_123' } })).status, 400); // no acknowledgement
  assert.equal((await call('POST', '/api/connections/notion', { token: u.token, body: { acknowledge: true, token: 'wrong_token_wrong_token_xx' } })).status, 422);
  const c = await call('POST', '/api/connections/notion', { token: u.token, body: { acknowledge: true, token: 'secret_notion_token_value_123' } });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.json.connection.accountLabel, 'School WS');
  assert.ok(!c.text.includes('secret_notion_token_value_123'));
  const stored = t.store.db.prepare('SELECT access_token_enc FROM connections').get() as { access_token_enc: string };
  assert.ok(!stored.access_token_enc.includes('secret_notion'));
  assert.equal(decryptSecret(stored.access_token_enc, t.config.tokenEncKey), 'secret_notion_token_value_123');

  const dbs = await call('GET', `/api/connections/${c.json.connection.id}/notion/databases`, { token: u.token });
  assert.equal(dbs.json.databases[0].title, 'Homework');
  const sched = (await call('POST', '/api/schedules', { token: u.token, body: { name: 'School', timezone: 'America/Chicago' } })).json.schedule.id as string;
  const body = { connectionId: c.json.connection.id, databaseId: DB, mapping: { duration: 'Minutes', priority: 'Priority', category: 'Subject' } };
  assert.equal((await call('POST', `/api/schedules/${sched}/import/notion`, { token: u.token, body })).status, 400); // confirm required
  const res = await call('POST', `/api/schedules/${sched}/import/notion`, { token: u.token, body: { ...body, confirm: true } });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.imported, { created: 2, updated: 0 });
  assert.equal(res.json.skipped, 1); // the done task
  const items = (await call('GET', `/api/schedules/${sched}/items`, { token: u.token })).json.items as { title: string; kind: string; start: string | null; durationMin: number; deadline: string | null; priority: number | null; category: string | null }[];
  const essay = items.find((i) => i.title === 'Essay draft')!;
  assert.equal(essay.kind, 'task');
  assert.equal(essay.start, null);
  assert.equal(essay.durationMin, 120);
  assert.equal(essay.priority, 4);
  assert.equal(essay.category, 'English');
  assert.match(essay.deadline!, /^2026-11-25T23:59:00-06:00$/); // a date-only due date means "by the end of that day"
  assert.equal(items.find((i) => i.title === 'Timed task')!.deadline, '2026-11-24T15:00:00-06:00');

  // read-only, proven: the only non-get calls are notion's /search and database /query (both reads)
  for (const call2 of net.calls) {
    if (call2.method !== 'GET') assert.match(call2.url, /\/v1\/(search|databases\/[0-9a-f]+\/query)$/, `unexpected write-capable call: ${call2.method} ${call2.url}`);
  }
  assert.ok(!net.calls.some((c2) => /pages|blocks/.test(c2.url) && c2.method !== 'GET'));
});

/* ───────────── crypto + config ───────────── */

test('secret encryption is authenticated: tampering and wrong keys are detected', () => {
  const key = Buffer.alloc(32, 1);
  const blob = encryptSecret('top-secret', key);
  assert.equal(decryptSecret(blob, key), 'top-secret');
  assert.notEqual(encryptSecret('top-secret', key), blob); // random iv
  const parts = blob.split('.');
  const tampered = [parts[0], parts[1], parts[2], Buffer.from('xxxxxxxxxx').toString('base64url')].join('.');
  assert.throws(() => decryptSecret(tampered, key));
  assert.throws(() => decryptSecret(blob, Buffer.alloc(32, 2)));
  assert.throws(() => decryptSecret('garbage', key));
});

test('configuration is validated and production refuses unsafe settings', () => {
  const base = { NODE_ENV: 'production', APP_ORIGINS: 'https://app.example.com', TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64') };
  assert.doesNotThrow(() => loadConfig(base));
  assert.throws(() => loadConfig({ ...base, TOKEN_ENC_KEY: undefined }), ConfigError);
  assert.throws(() => loadConfig({ ...base, TOKEN_ENC_KEY: 'c2hvcnQ=' }), /32 bytes/);
  assert.throws(() => loadConfig({ ...base, APP_ORIGINS: 'http://app.example.com' }), /https/);
  assert.throws(() => loadConfig({ ...base, COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
  assert.throws(() => loadConfig({ ...base, APP_ORIGINS: 'not a url' }), /invalid origin/);
  assert.throws(() => loadConfig({ NODE_ENV: 'development', COOKIE_SAMESITE: 'None', COOKIE_SECURE: 'false' }), /SECURE/);
  const dev = loadConfig({});
  assert.equal(dev.env, 'development');
  assert.equal(dev.cookie.secure, false);
  assert.equal(dev.tokenEncKey.length, 32);
  assert.equal(loadConfig(base).cookie.secure, true);
});

/* ───────────── "log in with notion" ───────────── */

test('Log in with Notion: consent -> workspace token, stored encrypted; denial, replay, bad state and missing setup are all handled; works for a guest', async () => {
  const DB = '0123456789abcdef0123456789abcdef';
  const net = fake((c) => {
    if (c.url === 'https://api.notion.com/v1/oauth/token') {
      const sent = JSON.parse(c.body) as { grant_type: string; code: string; redirect_uri: string };
      if (sent.code !== 'notion-code-123456') return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'secret_oauth_workspace_token_abcdefghij', token_type: 'bearer', workspace_name: 'Sam’s School', bot_id: 'b1' });
    }
    if (c.url === 'https://api.notion.com/v1/search') return json({ results: [{ id: DB, title: [{ plain_text: 'Homework' }], properties: { Name: { type: 'title' }, Due: { type: 'date' } } }] });
    return undefined;
  });
  const t = await makeApp({ fetch: net.f });
  const call = client(t);
  const g = await call('POST', '/api/auth/guest?tz=America/Chicago');
  const token = g.json.token as string;
  assert.equal((await call('GET', '/api/capabilities')).json.notionLogin, true);

  assert.equal((await call('POST', '/api/connections/notion/start', { token, body: {} })).status, 400, 'explicit acknowledgement required');
  const start = await call('POST', '/api/connections/notion/start', { token, body: { acknowledge: true, redirect: '/?ob=notion' } });
  assert.equal(start.status, 200, start.text);
  const u = new URL(start.json.url as string);
  assert.equal(u.origin + u.pathname, 'https://api.notion.com/v1/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'test-notion-client');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('owner'), 'user');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://api.test/api/connections/notion/callback');
  const state = u.searchParams.get('state')!;

  // the user pressed cancel at notion
  assert.equal((await call('GET', `/api/connections/notion/callback?error=access_denied&state=${state}`)).headers.get('location'), 'http://localhost:5173/?ob=notion&connect_error=access_denied');
  // a made-up state is refused
  assert.match((await call('GET', `/api/connections/notion/callback?code=notion-code-123456&state=${'x'.repeat(43)}`)).headers.get('location')!, /connect_error=invalid_state/);
  // a google connect state cannot be replayed into the notion callback
  const gs = await call('POST', '/api/connections/google/start', { token: (await makeUser(t)).token, body: { acknowledge: true, scopes: ['https://www.googleapis.com/auth/calendar.readonly'] } });
  const gstate = new URL(gs.json.url as string).searchParams.get('state')!;
  assert.match((await call('GET', `/api/connections/notion/callback?code=notion-code-123456&state=${gstate}`)).headers.get('location')!, /connect_error=invalid_state/);

  // the real thing (the cancelled attempt consumed its state, so start again)
  const state2 = new URL((await call('POST', '/api/connections/notion/start', { token, body: { acknowledge: true, redirect: '/?ob=notion' } })).json.url as string).searchParams.get('state')!;
  const ok = await call('GET', `/api/connections/notion/callback?code=notion-code-123456&state=${state2}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), 'http://localhost:5173/?ob=notion&connected=notion');
  const tokenReq = net.calls.find((c) => c.url.endsWith('/oauth/token'))!;
  assert.equal(tokenReq.auth, `Basic ${Buffer.from('test-notion-client:test-notion-secret').toString('base64')}`);
  assert.equal(JSON.parse(tokenReq.body).grant_type, 'authorization_code');

  const conns = (await call('GET', '/api/connections', { token })).json.connections as { provider: string; accountLabel: string; access: string }[];
  assert.equal(conns.length, 1);
  assert.deepEqual([conns[0]!.provider, conns[0]!.accountLabel, conns[0]!.access], ['notion', 'Sam’s School', 'read-only']);
  const stored = t.store.db.prepare('SELECT access_token_enc FROM connections').get() as { access_token_enc: string };
  assert.ok(!stored.access_token_enc.includes('secret_oauth_workspace'), 'token is encrypted at rest');
  assert.equal(decryptSecret(stored.access_token_enc, t.config.tokenEncKey), 'secret_oauth_workspace_token_abcdefghij');
  // replaying the same state does nothing
  assert.match((await call('GET', `/api/connections/notion/callback?code=notion-code-123456&state=${state2}`)).headers.get('location')!, /connect_error=invalid_state/);

  // the stored workspace token works for reading databases
  const dbs = await call('GET', `/api/connections/${conns[0] && (await call('GET', '/api/connections', { token })).json.connections[0].id}/notion/databases`, { token });
  assert.equal(dbs.json.databases[0].title, 'Homework');

  // notion refusing the code is reported without storing anything
  const state3 = new URL((await call('POST', '/api/connections/notion/start', { token, body: { acknowledge: true } })).json.url as string).searchParams.get('state')!;
  assert.match((await call('GET', `/api/connections/notion/callback?code=wrong-code-wrong&state=${state3}`)).headers.get('location')!, /ob=notion&connect_error=connect_failed/);
  assert.equal((await call('GET', '/api/connections', { token })).json.connections.length, 1);

  // never used for anything but reading, plus the one token exchange
  for (const c2 of net.calls) if (c2.method !== 'GET') assert.match(c2.url, /\/v1\/(oauth\/token|search|databases\/[0-9a-f]+\/query)$/);

  // not configured on the server: clear message, nothing started
  const bare = await makeApp({ fetch: net.f, env: { NOTION_CLIENT_ID: '', NOTION_CLIENT_SECRET: '' } });
  const bg = (await client(bare)('POST', '/api/auth/guest')).json.token as string;
  assert.equal((await client(bare)('GET', '/api/capabilities')).json.notionLogin, false);
  const nope = await client(bare)('POST', '/api/connections/notion/start', { token: bg, body: { acknowledge: true } });
  assert.equal(nope.status, 501);
  assert.equal(nope.json.error.code, 'notion_not_configured');
});
