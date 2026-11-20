import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCalendarLink, normalizeCalendarLink, trimOldEvents } from '../src/calendar/link.ts';
import { parseIcs } from '../src/calendar/ics.ts';
import { client, makeApp } from './apiHelpers.ts';
import type { Fetcher } from '../src/auth/google.ts';

const SECRET = 'private-0123456789abcdef0123456789abcdef';
const GOOGLE = `https://calendar.google.com/calendar/ical/sam%40example.com/${SECRET}/basic.ics`;
const APPLE = 'webcal://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1NjEyMzQ1Njc4OTAxMjM0NTY';

const ymd = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
const daysFromNow = (n: number) => ymd(new Date(Date.now() + n * 86_400_000));

function ics(events: string[]): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n${events.join('')}END:VCALENDAR\r\n`;
}
const ev = (uid: string, day: string, h: number, title: string, extra = '') =>
  `BEGIN:VEVENT\r\nUID:${uid}@t\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${day}T${String(h).padStart(2, '0')}0000Z\r\nDTEND:${day}T${String(h + 1).padStart(2, '0')}0000Z\r\nSUMMARY:${title}\r\n${extra}END:VEVENT\r\n`;

/** A pretend internet that records every request. */
function fake(answer: (url: string) => Response | undefined) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: Fetcher = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    return answer(url) ?? new Response('nothing here', { status: 599 });
  };
  return { f, calls };
}
const text = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/calendar', ...headers } });

/* ───────────── the link must be a real calendar link on the provider's own host ───────────── */

test('links: webcal:// and http:// become https; google and icloud hosts are accepted', () => {
  assert.equal(normalizeCalendarLink(APPLE).protocol, 'https:');
  assert.equal(normalizeCalendarLink(APPLE).hostname, 'p12-caldav.icloud.com');
  assert.equal(normalizeCalendarLink(GOOGLE.replace('https:', 'http:')).protocol, 'https:');
  assert.equal(normalizeCalendarLink(`  <${GOOGLE}>  `).hostname, 'calendar.google.com');
  assert.equal(normalizeCalendarLink('WEBCALS://P05-CALDAV.ICLOUD.COM/published/2/abc123def456').hostname, 'p05-caldav.icloud.com');
  assert.equal(normalizeCalendarLink(APPLE, 'apple').hostname, 'p12-caldav.icloud.com');
  assert.equal(normalizeCalendarLink(GOOGLE, 'google').hostname, 'calendar.google.com');
});

test('links: look-alike hosts, IPs, ports, credentials, other schemes and the wrong provider are all refused', () => {
  const bad = [
    'https://calendar.google.com.evil.example/calendar/ical/x/private-1/basic.ics',
    'https://evilcalendar.google.com/calendar/ical/x/private-1/basic.ics',
    'https://calendar-google.com/calendar/ical/x/private-1/basic.ics',
    'https://icloud.com.evil.example/published/2/abc123def456',
    'https://evilicloud.com/published/2/abc123def456',
    'https://127.0.0.1/calendar.ics',
    'https://[::1]/calendar.ics',
    'https://localhost/calendar.ics',
    'https://169.254.169.254/latest/meta-data/',
    'https://calendar.google.com:8443/calendar/ical/x/private-1/basic.ics',
    'https://user:pass@calendar.google.com/calendar/ical/x/private-1/basic.ics',
    'ftp://calendar.google.com/calendar/ical/x/private-1/basic.ics',
    'file:///etc/passwd',
    'javascript:alert(1)//calendar.google.com',
    'not a url at all',
    '',
    'https://example.com/calendar.ics',
  ];
  for (const u of bad) assert.throws(() => normalizeCalendarLink(u), (e: Error) => /Import|link|calendar/i.test(e.name + e.message), `should refuse ${u}`);
  assert.throws(() => normalizeCalendarLink(GOOGLE, 'apple'), /Apple/);
  assert.throws(() => normalizeCalendarLink(APPLE, 'google'), /Google/);
  // the refusal never repeats the (secret) link back
  for (const u of [GOOGLE.replace('google.com', 'evil.example'), `https://example.com/${SECRET}`]) {
    try {
      normalizeCalendarLink(u);
    } catch (e) {
      assert.ok(!String((e as Error).message).includes(SECRET), 'error text must not echo the secret');
    }
  }
});

/* ───────────── fetching ───────────── */

test('fetch: GET only, no cookies or credentials, a bounded redirect chain that stays on the provider\'s hosts', async () => {
  const net = fake((u) => {
    if (u.startsWith('https://p01-caldav.icloud.com/')) return new Response(null, { status: 301, headers: { location: 'https://p12-caldav.icloud.com/published/2/final' } });
    if (u === 'https://p12-caldav.icloud.com/published/2/final') return text(ics([ev('a', daysFromNow(2), 9, 'Hello')]));
    return undefined;
  });
  const body = await fetchCalendarLink(net.f, normalizeCalendarLink('webcal://p01-caldav.icloud.com/published/2/start'), { provider: 'apple' });
  assert.match(body, /BEGIN:VCALENDAR/);
  assert.equal(net.calls.length, 2);
  for (const c of net.calls) {
    assert.equal(c.init?.method, 'GET');
    assert.equal(c.init?.redirect, 'manual');
    const h = new Headers(c.init?.headers);
    assert.equal(h.get('cookie'), null);
    assert.equal(h.get('authorization'), null);
  }
});

test('fetch: a redirect to a host that is not on the allow-list is refused BEFORE anything is requested there', async () => {
  for (const target of ['https://evil.example/steal', 'http://169.254.169.254/latest/meta-data/', 'https://calendar.google.com.evil.example/x', 'https://127.0.0.1/x']) {
    const net = fake((u) => (u.startsWith('https://calendar.google.com/') ? new Response(null, { status: 302, headers: { location: target } }) : text('SHOULD NEVER BE REACHED')));
    await assert.rejects(fetchCalendarLink(net.f, normalizeCalendarLink(GOOGLE), { provider: 'google' }), (e: Error) => !e.message.includes(SECRET));
    assert.equal(net.calls.length, 1, `only the original request was made (target ${target})`);
  }
});

test('fetch: a redirect loop stops after 3 hops', async () => {
  const net = fake(() => new Response(null, { status: 302, headers: { location: 'https://calendar.google.com/calendar/ical/loop/private-1/basic.ics' } }));
  await assert.rejects(fetchCalendarLink(net.f, normalizeCalendarLink(GOOGLE)), /redirected too many times/);
  assert.equal(net.calls.length, 4);
});

test('fetch: provider errors become plain-English messages that never contain the link', async () => {
  const cases: [number, RegExp][] = [
    [404, /doesn’t exist/],
    [410, /doesn’t exist/],
    [403, /isn’t shared/],
    [401, /isn’t shared/],
    [400, /didn’t recognise/],
    [429, /limiting/],
    [500, /error \(500\)/],
  ];
  for (const [status, re] of cases) {
    const net = fake(() => new Response('nope', { status }));
    await assert.rejects(fetchCalendarLink(net.f, normalizeCalendarLink(GOOGLE)), (e: Error) => re.test(e.message) && !e.message.includes(SECRET) && !e.message.includes('calendar.google.com'));
  }
  const down: Fetcher = async () => {
    throw new TypeError('network down');
  };
  await assert.rejects(fetchCalendarLink(down, normalizeCalendarLink(GOOGLE)), (e: Error) => /Couldn’t reach/.test(e.message) && !e.message.includes(SECRET));
});

test('fetch: a slow server is cut off by the timeout', async () => {
  const slow: Fetcher = (_i, init) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
  const t0 = Date.now();
  await assert.rejects(fetchCalendarLink(slow, normalizeCalendarLink(GOOGLE), { timeoutMs: 80 }), /Couldn’t reach/);
  assert.ok(Date.now() - t0 < 2000);
});

test('fetch: an oversized download is stopped, whether or not the server declares its size', async () => {
  const big = 'x'.repeat(3000);
  const declared = fake(() => text('BEGIN:VCALENDAR', 200, { 'content-length': '999999999' }));
  await assert.rejects(fetchCalendarLink(declared.f, normalizeCalendarLink(GOOGLE), { maxBytes: 1000 }), /too large/);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new TextEncoder().encode(big));
    },
  });
  const endless = fake(() => new Response(stream, { status: 200 }));
  await assert.rejects(fetchCalendarLink(endless.f, normalizeCalendarLink(GOOGLE), { maxBytes: 10_000 }), /too large/);
  assert.ok(pulled < 10, `the endless stream was abandoned after ${pulled} chunks`);
});

/* ───────────── trimming a calendar's whole history ───────────── */

test('trimOldEvents: drops finished single events, keeps recurring series, recent, multi-day and unreadable ones', () => {
  const cutoff = daysFromNow(-30);
  const src = ics([
    ev('old', daysFromNow(-400), 9, 'Ancient'),
    ev('edge', daysFromNow(-29), 9, 'Just inside'),
    ev('recent', daysFromNow(-3), 9, 'Recent'),
    ev('future', daysFromNow(5), 9, 'Future'),
    ev('series', daysFromNow(-500), 9, 'Old weekly', 'RRULE:FREQ=WEEKLY\r\n'),
    `BEGIN:VEVENT\r\nUID:multi@t\r\nDTSTART;VALUE=DATE:${daysFromNow(-40)}\r\nDTEND;VALUE=DATE:${daysFromNow(-10)}\r\nSUMMARY:Long trip\r\nEND:VEVENT\r\n`,
    `BEGIN:VEVENT\r\nUID:weird@t\r\nSUMMARY:No start\r\nEND:VEVENT\r\n`,
  ]);
  const { text: out, dropped } = trimOldEvents(src, cutoff);
  assert.equal(dropped, 1);
  const titles = parseIcs(out).items.map((i) => i.title).sort();
  assert.deepEqual(titles, ['Future', 'Just inside', 'Long trip', 'Old weekly', 'Recent'].sort());
  assert.match(out, /SUMMARY:No start/, 'an event the trimmer cannot read is left for the parser to judge (the parser then skips it)');
  assert.match(out, /BEGIN:VCALENDAR/);
});

/* ───────────── through the API ───────────── */

async function guest(t: Awaited<ReturnType<typeof makeApp>>) {
  const call = client(t);
  const g = await call('POST', '/api/auth/guest?tz=America/Chicago');
  return { call, token: g.json.token as string, id: g.json.demoScheduleId as string };
}

test('API: a Google link imports, previews first, re-imports idempotently, drops old history, and the link is never stored or echoed', async () => {
  const body = ics([
    ev('l1', daysFromNow(2), 15, 'Lecture'),
    ev('l2', daysFromNow(3), 15, 'Seminar'),
    ev('old1', daysFromNow(-300), 15, 'Years ago'),
    ev('old2', daysFromNow(-100), 15, 'Months ago'),
  ]);
  const net = fake((u) => (u.startsWith('https://calendar.google.com/calendar/ical/') ? text(body) : undefined));
  const t = await makeApp({ fetch: net.f });
  const { call, token, id } = await guest(t);

  const dry = await call('POST', `/api/schedules/${id}/import/link`, { token, body: { url: GOOGLE, provider: 'google', dryRun: true } });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.wouldImport, 2);
  assert.ok(dry.json.warnings.some((w: string) => /2 events from before the last 30 days/.test(w)));
  assert.equal(dry.json.preview[0].title, 'Lecture');
  const before = (await call('GET', `/api/schedules/${id}/items`, { token })).json.items.length;

  const real = await call('POST', `/api/schedules/${id}/import/link`, { token, body: { url: GOOGLE, provider: 'google' } });
  assert.equal(real.status, 200, real.text);
  assert.deepEqual(real.json.imported, { created: 2, updated: 0 });
  const again = await call('POST', `/api/schedules/${id}/import/link`, { token, body: { url: GOOGLE, provider: 'google' } });
  assert.deepEqual(again.json.imported, { created: 0, updated: 2 });
  const after = (await call('GET', `/api/schedules/${id}/items`, { token })).json.items as { title: string }[];
  assert.equal(after.length, before + 2);
  assert.ok(!after.some((i) => /Years ago|Months ago/.test(i.title)));

  // the link is a secret: it appears in no response and in no table
  for (const r of [dry, real, again]) assert.ok(!r.text.includes(SECRET) && !r.text.includes('calendar.google.com'), 'the response never echoes the link');
  const raw = t.store.db;
  for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    for (const row of raw.prepare(`SELECT * FROM "${name}"`).all()) assert.ok(!JSON.stringify(row).includes(SECRET), `the secret is not stored in ${name}`);
  }
  assert.ok(net.calls.every((c) => c.init?.method === 'GET'), 'read-only: only GET requests');
});

test('API: an Apple (webcal://) link works, the wrong provider or a foreign host is refused without fetching anything', async () => {
  const net = fake((u) => (u.includes('icloud.com') ? text(ics([ev('a1', daysFromNow(1), 10, 'Dentist')])) : undefined));
  const t = await makeApp({ fetch: net.f });
  const { call, token, id } = await guest(t);
  const ok = await call('POST', `/api/schedules/${id}/import/link`, { token, body: { url: APPLE, provider: 'apple' } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.imported, { created: 1, updated: 0 });
  const callsBefore = net.calls.length;

  const wrong = await call('POST', `/api/schedules/${id}/import/link`, { token, body: { url: APPLE, provider: 'google' } });
  assert.equal(wrong.status, 422);
  assert.match(wrong.json.error.message, /Google Calendar link/);
  const evil = await call('POST', `/api/schedules/${id}/import/link`, { token, body: { url: 'https://evil.example/cal.ics' } });
  assert.equal(evil.status, 422);
  assert.equal(evil.json.error.code, 'link_not_allowed');
  const meta = await call('POST', `/api/schedules/${id}/import/link`, { token, body: { url: 'http://169.254.169.254/latest/meta-data/' } });
  assert.equal(meta.status, 422);
  assert.equal(net.calls.length, callsBefore, 'nothing was fetched for refused links');
});

test('API: a dead link, a link that is not a calendar, and a missing session each give a clear answer', async () => {
  const net = fake((u) => (u.includes('/dead/') ? new Response('', { status: 404 }) : text('<html>sign in to continue</html>')));
  const t = await makeApp({ fetch: net.f });
  const { call, token, id } = await guest(t);
  const dead = await call('POST', `/api/schedules/${id}/import/link`, { token, body: { url: 'https://calendar.google.com/calendar/ical/x/dead/basic.ics' } });
  assert.equal(dead.status, 422);
  assert.equal(dead.json.error.code, 'link_not_found');
  const html = await call('POST', `/api/schedules/${id}/import/link`, { token, body: { url: GOOGLE } });
  assert.equal(html.status, 422);
  assert.equal(html.json.error.code, 'not_ics');
  assert.equal((await call('POST', `/api/schedules/${id}/import/link`, { body: { url: GOOGLE } })).status, 401);
  // strict body: no surprise fields
  assert.equal((await call('POST', `/api/schedules/${id}/import/link`, { token, body: { url: GOOGLE, headers: { cookie: 'x' } } })).status, 400);
});
