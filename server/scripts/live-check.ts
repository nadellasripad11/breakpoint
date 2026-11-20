/**
 * Checks a deployed API with the two things most likely to hit platform limits: a big .ics import (many rows, few queries)
 * and Notion's real API refusing a fake token. Uses a throwaway guest that is deleted at the end.
 *   BASE_URL=https://your-api.example.com node scripts/live-check.ts
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'x-breakpoint-client': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, json, text };
}

const g = await api('POST', '/api/auth/guest?tz=America/Chicago');
const token = g.json.token as string;
const sid = g.json.demoScheduleId as string;

// 600 events over 300 days
const day = (n: number) => new Date(Date.UTC(2027, 0, 4 + n));
const ymd = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//check//EN\r\n';
for (let i = 0; i < 600; i++) {
  const d = day(Math.floor(i / 2));
  const h = i % 2 ? 15 : 9;
  ics += `BEGIN:VEVENT\r\nUID:e${i}@check\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${ymd(d)}T${String(h).padStart(2, '0')}0000Z\r\nDTEND:${ymd(d)}T${String(h + 1).padStart(2, '0')}0000Z\r\nSUMMARY:Event ${i}\r\nEND:VEVENT\r\n`;
}
ics += 'END:VCALENDAR\r\n';

const t0 = Date.now();
const first = await api('POST', `/api/schedules/${sid}/import/ics`, token, { ics });
check('600-event .ics import', first.status === 200 && first.json.imported.created === 600, `${first.status} ${first.json?.imported ? JSON.stringify(first.json.imported) : first.text.slice(0, 120)} in ${Date.now() - t0} ms`);
const again = await api('POST', `/api/schedules/${sid}/import/ics`, token, { ics });
check('re-import is idempotent (all updated, none created)', again.status === 200 && again.json.imported.created === 0 && again.json.imported.updated === 600, again.json?.imported ? JSON.stringify(again.json.imported) : again.text.slice(0, 120));
const items = await api('GET', `/api/schedules/${sid}/items`, token);
check('items are all there', items.status === 200 && items.json.items.length >= 600, `${items.json?.items?.length} items`);

const bad = await api('POST', '/api/connections/notion', token, { acknowledge: true, token: 'secret_this_is_not_a_real_notion_token_xx' });
check('Notion refuses a fake token with a clear message', bad.status === 422 && /Notion rejected/.test(bad.json?.error?.message ?? ''), `${bad.status} ${bad.json?.error?.message ?? bad.text.slice(0, 100)}`);

const del = await api('DELETE', '/api/me', token, { confirm: 'delete my account' });
check('throwaway guest deleted', del.status === 204);
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll live checks passed.');
