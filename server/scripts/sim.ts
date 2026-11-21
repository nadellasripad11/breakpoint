/**
 * local simulator: runs the real breakpoint api against a pretend google and a pretend notion, so the whole
 * connector flow (sign in, consent, calendar picker, imports, errors) can be tried in the browser with no credentials.
 *
 *   npm run sim            (api on http://localhost:8787, pretend google consent page at /sim/google/authorize)
 *
 * the pretend services speak the same protocol as the real ones (oauth code + pkce, rs256-signed id tokens, calendarlist,
 * events, notion search/query), so nothing about the app changes when you swap in real credentials. development only:
 * it uses an in-memory database and a fake identity (sam student, sam@example.com).
 */
import { serve } from '@hono/node-server';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { randomUUID, type KeyObject } from 'node:crypto';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { SqliteStore } from '../src/store/sqlite.ts';
import { randomToken, sha256Base64Url } from '../src/auth/crypto.ts';

const config = loadConfig({
  NODE_ENV: 'development',
  PORT: process.env.PORT ?? '8787',
  APP_ORIGINS: process.env.APP_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173',
  API_URL: process.env.API_URL ?? `http://localhost:${process.env.PORT ?? '8787'}`,
  DATABASE_PATH: ':memory:',
  GOOGLE_CLIENT_ID: 'sim-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'sim-client-secret',
  NOTION_CLIENT_ID: 'sim-notion-client',
  NOTION_CLIENT_SECRET: 'sim-notion-secret',
});

const READONLY = 'https://www.googleapis.com/auth/calendar.readonly';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const NOTION_TOKEN = 'secret_sim_notion_token_0123456789';
const PRIMARY = 'sam@example.com';
const CLASSES = 'classes@group.calendar.google.com';
const HW_DB = 'a1b2c3d4-0000-4000-8000-0000000000a1';
const READING_DB = 'a1b2c3d4-0000-4000-8000-0000000000b2';

const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: 'sim-key', alg: 'RS256', use: 'sig' };

const notionCodes = new Set<string>();
/** codes handed out by the pretend consent page, waiting to be exchanged */
const codes = new Map<string, { nonce: string | null; scope: string; challenge: string; extra: boolean }>();
const log = (who: string, msg: string) => console.log(`  [${who}] ${msg}`);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

/* ───────── pretend google ───────── */

function dayAt(offsetDays: number, h: number, m = 0): Date {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function googleEvents(calendarId: string, from: Date, to: Date) {
  const items: Record<string, unknown>[] = [];
  const timed = (id: string, summary: string, s: Date, e: Date) => ({ id, status: 'confirmed', summary, start: { dateTime: s.toISOString() }, end: { dateTime: e.toISOString() } });
  for (let d = 0; d < 100; d++) {
    const dow = dayAt(d, 0).getDay();
    if (calendarId === PRIMARY) {
      if (dow >= 1 && dow <= 5) items.push(timed(`calc-${d}`, 'Calculus lecture', dayAt(d, 9), dayAt(d, 10, 15)));
      if (dow === 2 || dow === 4) items.push(timed(`lab-${d}`, 'Chemistry lab', dayAt(d, 13), dayAt(d, 15, 30)));
      if (dow === 3) items.push(timed(`study-${d}`, 'Study group', dayAt(d, 16), dayAt(d, 17, 30)));
    } else if (calendarId === CLASSES) {
      if (dow === 1 || dow === 3) items.push(timed(`soc-${d}`, 'Soccer practice', dayAt(d, 18), dayAt(d, 19, 30)));
    }
  }
  if (calendarId === PRIMARY) {
    const f = dayAt(5, 0);
    const next = dayAt(6, 0);
    const ymd = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    items.push({ id: 'formal', status: 'confirmed', summary: 'Spring formal', start: { date: ymd(f) }, end: { date: ymd(next) } });
    items.push({ id: 'cancelled', status: 'cancelled', summary: 'Cancelled meeting', start: { dateTime: dayAt(2, 11).toISOString() }, end: { dateTime: dayAt(2, 12).toISOString() } });
  }
  return items.filter((e) => {
    const s = new Date(String((e.start as { dateTime?: string; date?: string }).dateTime ?? `${(e.start as { date?: string }).date}T00:00:00`));
    return s >= from && s < to;
  });
}

async function idToken(nonce: string | null): Promise<string> {
  return new SignJWT({ email: 'sam@example.com', email_verified: true, name: 'Sam Student', picture: 'https://example.com/sam.png', ...(nonce ? { nonce } : {}) })
    .setProtectedHeader({ alg: 'RS256', kid: 'sim-key' })
    .setIssuer('https://accounts.google.com')
    .setAudience(config.google!.clientId)
    .setSubject('sim-google-sub-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey as unknown as KeyObject);
}

/* ───────── pretend notion ───────── */

const ymdOffset = (days: number) => dayAt(days, 0).toISOString().slice(0, 10);
const notionPage = (n: number, title: string, due: number | null, minutes: number, priority: string, status: string, subject: string) => ({
  id: `c0ffee00-0000-4000-8000-${String(n).padStart(12, '0')}`,
  archived: false,
  properties: {
    Name: { type: 'title', title: [{ plain_text: title }] },
    ...(due === null ? {} : { Due: { type: 'date', date: { start: ymdOffset(due) } } }),
    Minutes: { type: 'number', number: minutes },
    Priority: { type: 'select', select: { name: priority } },
    Status: { type: 'status', status: { name: status } },
    Subject: { type: 'select', select: { name: subject } },
  },
});

const homework = () => [
  notionPage(1, 'Problem set 7', 2, 120, 'High', 'Not started', 'Math'),
  notionPage(2, 'Lab report: titration', 3, 90, 'High', 'In progress', 'Chemistry'),
  notionPage(3, 'Read chapter 12', 4, 60, 'Medium', 'Not started', 'History'),
  notionPage(4, 'Essay outline', 6, 45, 'Medium', 'Not started', 'English'),
  notionPage(5, 'Flashcards review', 1, 30, 'Low', 'Not started', 'Spanish'),
  notionPage(6, 'Already finished worksheet', -1, 30, 'Low', 'Done', 'Math'),
];

/* ───────── pretend calendar links (google secret ical address, icloud public calendar) ───────── */

const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function vevent(uid: string, title: string, s: Date, e: Date, extra = ''): string {
  return `BEGIN:VEVENT\r\nUID:${uid}@sim\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${icsStamp(s)}\r\nDTEND:${icsStamp(e)}\r\nSUMMARY:${title}\r\n${extra}END:VEVENT\r\n`;
}
const wrapIcs = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//breakpoint-sim//EN\r\n${body}END:VCALENDAR\r\n`;

function googleLinkIcs(): string {
  let out = vevent('g-ancient', 'Orientation (years ago)', dayAt(-700, 9), dayAt(-700, 10)); // old history: the importer leaves it out
  for (let d = 0; d < 21; d++) {
    const dow = dayAt(d, 0).getDay();
    if (dow >= 1 && dow <= 5) out += vevent(`g-calc-${d}`, 'Calculus lecture', dayAt(d, 9), dayAt(d, 10, 15));
    if (dow === 2 || dow === 4) out += vevent(`g-lab-${d}`, 'Chemistry lab', dayAt(d, 13), dayAt(d, 15, 30));
  }
  out += vevent('g-series', 'Study group (weekly)', dayAt(1, 16), dayAt(1, 17, 30), 'RRULE:FREQ=WEEKLY;COUNT=6\r\n');
  return wrapIcs(out);
}
function appleLinkIcs(): string {
  let out = vevent('a-old', 'Last year’s recital', dayAt(-300, 18), dayAt(-300, 19));
  out += vevent('a-dentist', 'Dentist', dayAt(2, 11), dayAt(2, 12));
  out += vevent('a-piano', 'Piano lesson (weekly)', dayAt(3, 17), dayAt(3, 18), 'RRULE:FREQ=WEEKLY;COUNT=8\r\n');
  out += vevent('a-dinner', 'Family dinner', dayAt(4, 19), dayAt(4, 21));
  return wrapIcs(out);
}
const icsResponse = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8' } });

/* ───────── the pretend internet ───────── */

const simFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  const where = `${url.host}${url.pathname}`;

  if (where === 'www.googleapis.com/oauth2/v3/certs') return json({ keys: [jwk] });

  if (where === 'oauth2.googleapis.com/token' && method === 'POST') {
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (form.get('grant_type') === 'refresh_token') {
      log('google', 'refreshed an access token');
      return json({ access_token: `sim-at-${randomToken(8)}`, expires_in: 3600, scope: READONLY });
    }
    const code = codes.get(form.get('code') ?? '');
    codes.delete(form.get('code') ?? '');
    if (!code) return json({ error: 'invalid_grant' }, 400);
    if (sha256Base64Url(form.get('code_verifier') ?? '') !== code.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verifier does not match' }, 400);
    if (code.scope.includes('openid')) {
      log('google', 'signed Sam Student in (identity only, no calendar access)');
      return json({ access_token: `sim-login-${randomToken(8)}`, id_token: await idToken(code.nonce), expires_in: 3600, scope: 'openid email profile' });
    }
    log('google', `granted ${code.extra ? 'calendar.readonly AND gmail.readonly (too much!)' : 'calendar.readonly'}`);
    return json({ access_token: `sim-at-${randomToken(8)}`, refresh_token: `sim-rt-${randomToken(12)}`, expires_in: 3600, scope: code.extra ? `${READONLY} ${GMAIL}` : READONLY });
  }

  if (where === 'oauth2.googleapis.com/revoke') {
    log('google', 'a grant was revoked');
    return new Response('{}', { status: 200 });
  }

  if (url.host === 'www.googleapis.com' && url.pathname.startsWith('/calendar/v3/')) {
    if (method !== 'GET') return json({ error: 'Breakpoint must only read' }, 405); // the real connector only ever gets
    if (!auth.startsWith('Bearer sim-at-')) return json({}, 401);
    if (url.pathname === '/calendar/v3/users/me/calendarList') {
      log('google', 'listed calendars');
      return json({ items: [{ id: PRIMARY, summary: 'Sam Student', primary: true, timeZone: 'America/Chicago' }, { id: CLASSES, summary: 'Soccer & clubs', timeZone: 'America/Chicago' }] });
    }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const items = googleEvents(id, new Date(url.searchParams.get('timeMin') ?? Date.now()), new Date(url.searchParams.get('timeMax') ?? Date.now() + 30 * 86_400_000));
      log('google', `read ${items.length} events from ${id}`);
      return json({ items });
    }
  }

  // calendar links: any path containing /dead/ is a link that was reset (404), anything else is a working calendar
  if (url.host === 'calendar.google.com' && url.pathname.startsWith('/calendar/ical/')) {
    if (url.pathname.includes('/dead/')) return new Response('Not Found', { status: 404 });
    log('google', 'served a secret iCal address (read once)');
    return icsResponse(googleLinkIcs());
  }
  if (url.host.endsWith('.icloud.com') && url.pathname.startsWith('/published/')) {
    if (url.pathname.includes('/dead/')) return new Response('Not Found', { status: 404 });
    log('apple', 'served a public iCloud calendar (read once)');
    return icsResponse(appleLinkIcs());
  }

  if (where === 'api.notion.com/v1/oauth/token' && method === 'POST') {
    const sent = JSON.parse(String(init?.body ?? '{}')) as { code?: string };
    if (!sent.code || !notionCodes.delete(sent.code)) return json({ error: 'invalid_grant' }, 400);
    log('notion', 'logged in (workspace shared with Breakpoint, read-only)');
    return json({ access_token: NOTION_TOKEN, token_type: 'bearer', workspace_name: 'Sam’s school workspace', bot_id: 'sim-bot' });
  }
  if (url.host === 'api.notion.com' && url.pathname.startsWith('/v1/')) {
    if (auth !== `Bearer ${NOTION_TOKEN}`) return json({ object: 'error', code: 'unauthorized' }, 401);
    if (url.pathname === '/v1/users/me') return json({ bot: { workspace_name: 'Sam’s school workspace' } });
    if (url.pathname === '/v1/search') {
      log('notion', 'listed databases');
      return json({
        results: [
          { id: HW_DB, title: [{ plain_text: 'Homework' }], properties: { Name: { type: 'title' }, Due: { type: 'date' }, Minutes: { type: 'number' }, Priority: { type: 'select' }, Status: { type: 'status' }, Subject: { type: 'select' } } },
          { id: READING_DB, title: [{ plain_text: 'Reading list' }], properties: { Name: { type: 'title' }, Started: { type: 'date' }, 'Finish by': { type: 'date' } } },
        ],
      });
    }
    if (url.pathname === `/v1/databases/${HW_DB}/query`) {
      log('notion', 'read the Homework database');
      return json({ results: homework(), has_more: false });
    }
    if (url.pathname === `/v1/databases/${READING_DB}/query`) return json({ results: [], has_more: false });
  }
  return new Response(`the simulator does not know ${method} ${where}`, { status: 599 });
};

/* ───────── the pretend consent page ───────── */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function consentPage(u: URL): Response {
  const p = u.searchParams;
  const scopes = (p.get('scope') ?? '').split(' ').filter(Boolean);
  const calendar = scopes.includes(READONLY);
  const hidden = ['redirect_uri', 'state', 'scope', 'nonce', 'code_challenge'].map((k) => `<input type="hidden" name="${k}" value="${esc(p.get(k) ?? '')}">`).join('');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated Google</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#f1f3f4;color:#202124;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border-radius:12px;padding:32px;width:min(420px,92vw);box-shadow:0 2px 12px #0002}h1{font-size:20px;margin:0 0 4px}
.who{display:flex;gap:10px;align-items:center;margin:14px 0;padding:10px;border:1px solid #dadce0;border-radius:8px}.av{width:34px;height:34px;border-radius:50%;background:#1a73e8;color:#fff;display:grid;place-items:center;font-weight:700}
li{margin:6px 0}.sim{background:#fef7e0;border:1px solid #f9ab00;border-radius:8px;padding:8px 10px;font-size:13px;margin-bottom:16px}
button{font:inherit;border-radius:20px;padding:9px 22px;border:1px solid #dadce0;background:#fff;cursor:pointer}button.go{background:#1a73e8;color:#fff;border-color:#1a73e8}
.row{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}label.x{display:block;margin-top:14px;font-size:13px;color:#5f6368}</style>
<main><div class="sim"><b>Simulated Google.</b> This is the Breakpoint simulator, not Google. No real account is used.</div>
<h1>${calendar ? 'Breakpoint wants to access your Google Account' : 'Sign in to Breakpoint'}</h1>
<div class="who"><span class="av">S</span><span>Sam Student<br><small>sam@example.com</small></span></div>
<p>${calendar ? 'This will allow Breakpoint to:' : 'Breakpoint will see your:'}</p>
<ul>${calendar ? '<li>See and download any calendar you can access using your Google Calendar</li>' : '<li>Name, email address and profile picture</li>'}</ul>
<form method="get" action="/sim/google/decide">${hidden}
${calendar ? '<label class="x"><input type="checkbox" name="extra" value="1"> Also grant Gmail access (simulates Google granting more than asked, which Breakpoint must refuse)</label>' : ''}
<div class="row"><button name="allow" value="0" type="submit">Cancel</button><button class="go" name="allow" value="1" type="submit">Allow</button></div></form></main>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function notionConsentPage(u: URL): Response {
  const p = u.searchParams;
  const hidden = ['redirect_uri', 'state'].map((k) => `<input type="hidden" name="${k}" value="${esc(p.get(k) ?? '')}">`).join('');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated Notion</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#f7f6f3;color:#37352f;margin:0;display:grid;place-items:center;min-height:100vh}main{background:#fff;border-radius:10px;padding:32px;width:min(430px,92vw);box-shadow:0 2px 14px #0002}
h1{font-size:19px;margin:0 0 6px}.sim{background:#fbf3db;border:1px solid #e9c46a;border-radius:8px;padding:8px 10px;font-size:13px;margin-bottom:16px}label.r{display:flex;gap:10px;padding:9px 0;border-top:1px solid #eee}
.row{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}button{font:inherit;border-radius:6px;padding:8px 18px;border:1px solid #ddd;background:#fff;cursor:pointer}button.go{background:#2383e2;color:#fff;border-color:#2383e2}</style>
<main><div class="sim"><b>Simulated Notion.</b> This is the Breakpoint simulator, not Notion.</div>
<h1>Breakpoint would like to access Sam’s school workspace</h1><p>Select the pages and databases to share. Breakpoint can only <b>read</b> them.</p>
<form method="get" action="/sim/notion/decide">${hidden}<label class="r"><input type="checkbox" checked disabled> Homework (database)</label><label class="r"><input type="checkbox" checked disabled> Reading list (database)</label>
<div class="row"><button name="allow" value="0" type="submit">Cancel</button><button class="go" name="allow" value="1" type="submit">Allow access</button></div></form></main>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function notionDecide(u: URL): Response {
  const p = u.searchParams;
  const back = new URL(p.get('redirect_uri') ?? '');
  if (back.origin !== new URL(config.apiUrl).origin) return new Response('redirect_uri must point at this API', { status: 400 });
  if (p.get('state')) back.searchParams.set('state', p.get('state')!);
  if (p.get('allow') !== '1') {
    back.searchParams.set('error', 'access_denied');
    log('notion', 'the user pressed Cancel');
    return Response.redirect(back.toString(), 302);
  }
  const code = `sim_notion_${randomToken(12)}`;
  notionCodes.add(code);
  back.searchParams.set('code', code);
  return Response.redirect(back.toString(), 302);
}

function decide(u: URL): Response {
  const p = u.searchParams;
  const back = new URL(p.get('redirect_uri') ?? '');
  if (back.origin !== new URL(config.apiUrl).origin) return new Response('redirect_uri must point at this API', { status: 400 });
  if (p.get('state')) back.searchParams.set('state', p.get('state')!);
  if (p.get('allow') !== '1') {
    back.searchParams.set('error', 'access_denied');
    log('google', 'the user pressed Cancel');
    return Response.redirect(back.toString(), 302);
  }
  const code = `sim_code_${randomToken(16)}`;
  codes.set(code, { nonce: p.get('nonce') || null, scope: p.get('scope') ?? '', challenge: p.get('code_challenge') ?? '', extra: p.get('extra') === '1' });
  back.searchParams.set('code', code);
  return Response.redirect(back.toString(), 302);
}

/* ───────── serve ───────── */

const store = new SqliteStore(':memory:');
await store.migrate();
const app = createApp({ store, config, fetch: simFetch, now: () => new Date(), newId: () => randomUUID() });
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';

serve(
  {
    port: config.port,
    hostname: config.host,
    fetch: async (req: Request) => {
      const u = new URL(req.url);
      if (u.pathname === '/sim/google/authorize') return consentPage(u);
      if (u.pathname === '/sim/google/decide') return decide(u);
      if (u.pathname === '/sim/notion/authorize') return notionConsentPage(u);
      if (u.pathname === '/sim/notion/decide') return notionDecide(u);
      const res = await app.fetch(req);
      // the real api returns google's consent url; point it at the pretend consent page instead
      if (res.ok && req.method !== 'OPTIONS' && /\/google\/start$/.test(u.pathname) && res.headers.get('content-type')?.includes('json')) {
        const body = (await res.json()) as { url?: string };
        if (body.url?.startsWith(GOOGLE_AUTH)) body.url = body.url.replace(GOOGLE_AUTH, `${config.apiUrl}/sim/google/authorize`);
        const headers = new Headers(res.headers);
        headers.delete('content-length');
        return new Response(JSON.stringify(body), { status: res.status, headers });
      }
      if (res.ok && req.method !== 'OPTIONS' && /\/notion\/start$/.test(u.pathname) && res.headers.get('content-type')?.includes('json')) {
        const body = (await res.json()) as { url?: string };
        if (body.url?.startsWith('https://api.notion.com/v1/oauth/authorize')) body.url = body.url.replace('https://api.notion.com/v1/oauth/authorize', `${config.apiUrl}/sim/notion/authorize`);
        const headers = new Headers(res.headers);
        headers.delete('content-length');
        return new Response(JSON.stringify(body), { status: res.status, headers });
      }
      return res;
    },
  },
  (info) => {
    console.log(`Breakpoint SIMULATOR on http://${info.address}:${info.port}  (pretend Google + pretend Notion, in-memory database)`);
    console.log(`  CORS:    ${config.appOrigins.join(', ')}`);
    console.log(`  Google:  sign in as Sam Student on the simulated consent page`);
    console.log(`  Notion:  "Log in with Notion" opens a pretend consent page (or paste this token -> ${NOTION_TOKEN})`);
    console.log('  Google link: paste https://calendar.google.com/calendar/ical/sam/private-demo/basic.ics   (…/dead/… gives the "link was reset" error)');
    console.log('  Apple link:  paste webcal://p12-caldav.icloud.com/published/2/demo');
    console.log('  Start the site with: npm run dev   (in the project root)');
  },
);
