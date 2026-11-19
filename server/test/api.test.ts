import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, cookiePair, makeApp, makeUser, setCookies } from './apiHelpers.ts';
import type { TestApp } from './apiHelpers.ts';

const ISO_OFFSET = /\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/** A guest session with the seeded landing-page demo schedule. */
async function guest(t: TestApp) {
  const call = client(t);
  const res = await call('POST', '/api/auth/guest?tz=America/Chicago');
  assert.equal(res.status, 201);
  return { call, token: res.json.token as string, scheduleId: res.json.demoScheduleId as string, res };
}

async function idsByTitle(call: ReturnType<typeof client>, token: string, scheduleId: string, date: string) {
  const plan = await call('POST', `/api/schedules/${scheduleId}/plan`, { token, body: { window: { date } } });
  assert.equal(plan.status, 200, plan.text);
  return { plan, id: Object.fromEntries(plan.json.items.map((i: { title: string; id: string }) => [i.title, i.id])) as Record<string, string> };
}

async function demoDate(t: TestApp): Promise<string> {
  const d = await client(t)('GET', '/api/demo/schedule?tz=America/Chicago');
  return d.json.date as string;
}

/* ───────────── basics + security headers ───────────── */

test('health, security headers, CORS allow-list, JSON errors with request ids', async () => {
  const t = await makeApp();
  const call = client(t);
  const h = await call('GET', '/health');
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(h.headers.get('x-frame-options'), 'DENY');
  assert.match(h.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.ok(h.headers.get('x-request-id'));
  const ok = await call('GET', '/api/health', { headers: { origin: 'http://localhost:5173' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  const evil = await call('GET', '/api/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const pre = await call('OPTIONS', '/api/schedules', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
  assert.equal(h.headers.get('cache-control') ?? '', ''); // only /api is no-store
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const nf = await call('GET', '/api/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error.code, 'not_found');
  assert.ok(nf.json.error.requestId);
});

/* ───────────── guest demo ───────────── */

test('guest demo: no login, a sandbox session, cookie flags, demo schedule seeded', async () => {
  const t = await makeApp();
  const { call, token, scheduleId, res } = await guest(t);
  const cookie = setCookies(res)[0]!;
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//);
  assert.equal(res.json.user.isGuest, true);
  const me = await call('GET', '/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.isGuest, true);
  const list = await call('GET', '/api/schedules', { token });
  assert.equal(list.json.schedules.length, 1);
  assert.equal(list.json.schedules[0].id, scheduleId);
  assert.equal(list.json.schedules[0].itemCount, 4);
  // the raw token is never stored, only its hash
  const row = t.store.db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash.length, 64);
  // a second call with the session reuses it
  const again = await call('POST', '/api/auth/guest', { token });
  assert.equal(again.status, 200);
  assert.equal(again.json.reused, true);
});

test('guest limits: at most 3 schedules, and no external connections', async () => {
  const t = await makeApp();
  const { call, token } = await guest(t);
  for (let i = 0; i < 2; i++) assert.equal((await call('POST', '/api/schedules', { token, body: { name: `s${i}`, timezone: 'UTC' } })).status, 201);
  const over = await call('POST', '/api/schedules', { token, body: { name: 'too many', timezone: 'UTC' } });
  assert.equal(over.status, 409);
  assert.equal(over.json.error.code, 'limit_exceeded');
  const g = await call('POST', '/api/connections/google/start', { token, body: { acknowledge: true, scopes: ['https://www.googleapis.com/auth/calendar.readonly'] } });
  assert.equal(g.status, 403);
  assert.equal(g.json.error.code, 'guest_not_allowed');
});

/* ───────────── the engine through the API ───────────── */

test('saved schedule: plan, simulate (Butterfly Effect), breaking point, futures, chaos, fortify. ISO times, nothing modified', async () => {
  const t = await makeApp();
  const { call, token, scheduleId } = await guest(t);
  const date = await demoDate(t);
  const { plan, id } = await idsByTitle(call, token, scheduleId, date);
  assert.ok(plan.json.items.every((i: { start: string }) => ISO_OFFSET.test(i.start)));
  assert.deepEqual(plan.json.issues, []);
  assert.equal(plan.json.items.length, 4);
  const before = await call('GET', `/api/schedules/${scheduleId}/items`, { token });

  const sim = await call('POST', `/api/schedules/${scheduleId}/simulate`, { token, body: { window: { date }, disruptions: [{ type: 'overrun', targetId: id.Practice, minutes: 45 }] } });
  assert.equal(sim.status, 200, sim.text);
  assert.equal(sim.json.result.summary.survives, false);
  const miss = sim.json.result.conflicts.find((c: { code: string }) => c.code === 'deadline_missed');
  assert.equal(miss.severity, 'critical');
  assert.match(miss.message, /Project/);
  assert.ok(ISO_OFFSET.test(sim.json.result.outcomes[0].simulated.start));
  assert.ok(sim.json.disruptions[0].includes('Practice'));

  const bp = await call('POST', `/api/schedules/${scheduleId}/breaking-point`, { token, body: { window: { date }, probe: { type: 'overrun', targetId: id.Practice }, mode: 'both', weakLinks: true } });
  assert.equal(bp.status, 200, bp.text);
  assert.equal(bp.json.result.cascade.tolerableMinutes, 30);
  assert.equal(bp.json.result.cascade.breakingMinutes, 31);
  assert.ok(bp.json.result.recover.tolerableMinutes > 30);
  assert.equal(bp.json.weakLinks.minTolerance, 30);

  const fut = await call('POST', `/api/schedules/${scheduleId}/futures`, { token, body: { window: { date }, disruptions: [{ type: 'overrun', targetId: id.Practice, minutes: 45 }] } });
  assert.equal(fut.status, 200, fut.text);
  assert.equal(fut.json.result.futures.length, 3);
  assert.ok(fut.json.result.futures.every((f: { feasible: boolean }) => f.feasible));
  assert.equal(fut.json.result.recommended, 'minimize_changes');
  const protect = fut.json.result.futures.find((f: { strategy: string }) => f.strategy === 'protect_priorities');
  assert.equal(protect.deferred.length, 1);
  assert.match(protect.deferred[0].message, /not been deleted/);

  const chaos = await call('POST', `/api/schedules/${scheduleId}/chaos`, { token, body: { window: { date }, scenarios: 100, seed: 5 } });
  const chaos2 = await call('POST', `/api/schedules/${scheduleId}/chaos`, { token, body: { window: { date }, scenarios: 100, seed: 5 } });
  assert.equal(chaos.status, 200, chaos.text);
  assert.deepEqual(chaos.json, chaos2.json); // deterministic
  assert.ok(chaos.json.result.survivalRate >= 0 && chaos.json.result.survivalRate <= 1);

  const fort = await call('POST', `/api/schedules/${scheduleId}/fortify`, { token, body: { window: { date } } });
  assert.equal(fort.status, 200, fort.text);
  assert.match(fort.json.result.explanation.at(-1), /proposal only/);

  // non-destructive: not one stored row changed
  const after = await call('GET', `/api/schedules/${scheduleId}/items`, { token });
  assert.deepEqual(after.json, before.json);
});

test('stateless guest endpoints work with no account at all (landing-page demo)', async () => {
  const t = await makeApp();
  const call = client(t);
  const demo = await call('GET', '/api/demo/schedule?tz=America/Chicago');
  assert.equal(demo.status, 200);
  const bp = await call('POST', '/api/engine/breaking-point', { body: demo.json.try.breakingPoint });
  assert.equal(bp.status, 200, bp.text);
  assert.equal(bp.json.result.cascade.tolerableMinutes, 30);
  const sim = await call('POST', '/api/engine/simulate', { body: demo.json.try.simulate });
  assert.equal(sim.json.result.summary.survives, false);
  const fut = await call('POST', '/api/engine/futures', { body: demo.json.try.futures });
  assert.equal(fut.json.result.futures.length, 3);
  assert.equal((await call('POST', '/api/engine/chaos', { body: demo.json.try.chaos })).status, 200);
  assert.equal((await call('POST', '/api/engine/fortify', { body: demo.json.try.fortify })).status, 200);
});

test('infeasible days return a clear explanation, not a made-up schedule', async () => {
  const t = await makeApp();
  const call = client(t);
  const res = await call('POST', '/api/engine/futures', {
    body: {
      schedule: {
        preferences: { timezone: 'America/Chicago', workingHours: { start: '15:00', end: '21:00' } },
        items: [
          { id: 'essay', kind: 'task', title: 'Essay', start: '2026-11-20T15:00:00-06:00', durationMin: 180, priority: 5, deadline: '2026-11-20T17:00:00-06:00' },
          { id: 'gym', kind: 'task', title: 'Gym', start: '2026-11-20T18:00:00-06:00', durationMin: 30, priority: 4 },
        ],
      },
      window: { date: '2026-11-20' },
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.unscheduled?.length ?? 0, 0); // start times were given, so nothing is "unscheduled"
  assert.equal(res.json.result.recommended, null);
  for (const f of res.json.result.futures) {
    assert.equal(f.feasible, false);
    assert.deepEqual(f.diagnosis.conflictSet, ['essay']);
    assert.ok(f.diagnosis.suggestions.some((s: { action: string }) => s.action === 'extend_deadline'));
    assert.deepEqual(f.items, []); // no half-plan is offered
  }
});

test('a task that cannot be placed is reported as unscheduled and kept, never silently dropped', async () => {
  const t = await makeApp();
  const call = client(t);
  const res = await call('POST', '/api/engine/plan', {
    body: {
      schedule: { preferences: { timezone: 'UTC', workingHours: { start: '09:00', end: '12:00' } }, items: [{ id: 'huge', kind: 'task', title: 'Huge', durationMin: 600, priority: 5 }] },
      window: { date: '2026-11-20' },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.unscheduled.length, 1);
  assert.match(res.json.unscheduled[0].message, /NOT removed/);
  assert.ok(res.json.items.some((i: { id: string; start: string | null }) => i.id === 'huge' && i.start === null));
});

test('validation: clear 400s with field paths; unknown targets and absurd windows are rejected', async () => {
  const t = await makeApp();
  const { call, token, scheduleId } = await guest(t);
  const bad = await call('POST', `/api/schedules/${scheduleId}/simulate`, { token, body: { window: { date: 'tomorrow' }, disruptions: [] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'validation_error');
  assert.ok(Array.isArray(bad.json.error.details) && bad.json.error.details.length > 0);
  const date = await demoDate(t);
  const unknown = await call('POST', `/api/schedules/${scheduleId}/simulate`, { token, body: { window: { date }, disruptions: [{ type: 'overrun', targetId: 'nope', minutes: 10 }] } });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.json.error.code, 'unknown_target');
  const wide = await call('POST', `/api/schedules/${scheduleId}/plan`, { token, body: { window: { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' } } });
  assert.equal(wide.status, 422);
  assert.equal(wide.json.error.code, 'horizon_too_long');
  const junk = await call('POST', `/api/schedules/${scheduleId}/simulate`, { token, body: '{not json' });
  assert.equal(junk.status, 400);
  assert.equal(junk.json.error.code, 'invalid_json');
  const extra = await call('POST', `/api/schedules/${scheduleId}/plan`, { token, body: { window: { date }, hack: true } });
  assert.equal(extra.status, 400); // strict schemas: unknown fields are refused
});

/* ───────────── authorization ───────────── */

test('authorization: no token = 401; another user cannot see, change or run anything on your schedule', async () => {
  const t = await makeApp();
  const call = client(t);
  const a = await makeUser(t, 'a@example.com');
  const b = await makeUser(t, 'b@example.com');
  const created = await call('POST', '/api/schedules', { token: a.token, body: { name: 'Mine', timezone: 'UTC' } });
  const id = created.json.schedule.id as string;
  assert.equal((await call('GET', '/api/schedules')).status, 401);
  assert.equal((await call('GET', `/api/schedules/${id}`)).status, 401);
  for (const [m, p, body] of [
    ['GET', `/api/schedules/${id}`, undefined],
    ['GET', `/api/schedules/${id}/items`, undefined],
    ['PATCH', `/api/schedules/${id}`, { name: 'hacked' }],
    ['DELETE', `/api/schedules/${id}`, undefined],
    ['POST', `/api/schedules/${id}/items`, { kind: 'event', title: 'x', start: '2026-11-20T10:00:00Z', durationMin: 30 }],
    ['POST', `/api/schedules/${id}/plan`, { window: { date: '2026-11-20' } }],
    ['POST', `/api/schedules/${id}/chaos`, { window: { date: '2026-11-20' } }],
    ['POST', `/api/schedules/${id}/import/ics`, { ics: 'BEGIN:VCALENDAR\nEND:VCALENDAR' }],
  ] as const) {
    const r = await call(m, p, { token: b.token, ...(body ? { body } : {}) });
    assert.equal(r.status, 404, `${m} ${p} leaked (status ${r.status})`);
  }
  assert.equal((await call('GET', `/api/schedules/${id}`, { token: a.token })).status, 200);
  assert.equal((await call('GET', '/api/schedules/not-a-uuid', { token: a.token })).status, 404);
  assert.equal((await call('GET', '/api/me', { token: 'x'.repeat(40) })).status, 401);
});

test('CSRF: cookie sessions must send an allowed Origin or the custom header; bearer tokens are exempt', async () => {
  const t = await makeApp();
  const call = client(t);
  const g = await call('POST', '/api/auth/guest');
  const cookie = cookiePair(g);
  const body = { name: 'x', timezone: 'UTC' };
  assert.equal((await call('POST', '/api/schedules', { cookie, body })).status, 403); // no Origin, no header
  assert.equal((await call('POST', '/api/schedules', { cookie, body, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('POST', '/api/schedules', { cookie, body, headers: { origin: 'http://localhost:5173' } })).status, 201);
  assert.equal((await call('POST', '/api/schedules', { cookie, body, headers: { 'x-breakpoint-client': '1' } })).status, 201);
  assert.equal((await call('GET', '/api/schedules', { cookie })).status, 200); // reads need nothing
  assert.equal((await call('POST', '/api/schedules', { token: g.json.token, body })).status, 409); // bearer: no CSRF check (this one hits the 3-schedule guest cap)
});

test('rate limiting returns 429 with Retry-After', async () => {
  const t = await makeApp();
  const call = client(t);
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const r = await call('POST', '/api/auth/guest', { headers: { 'x-test-ratelimit': '1' } });
    last = r.status;
    if (r.status === 429) {
      assert.ok(r.headers.get('retry-after'));
      assert.equal(r.json.error.code, 'rate_limited');
      break;
    }
  }
  assert.equal(last, 429);
});

/* ───────────── items, preferences, imports ───────────── */

test('items: validation, create, patch, delete; preferences drive priority and protected breaks', async () => {
  const t = await makeApp();
  const call = client(t);
  const u = await makeUser(t);
  const s = await call('POST', '/api/schedules', { token: u.token, body: { name: 'School', timezone: 'America/Chicago', preferences: { workingHours: { start: '08:00', end: '22:00' }, categoryPriority: { school: 5 } } } });
  const id = s.json.schedule.id as string;
  const noStart = await call('POST', `/api/schedules/${id}/items`, { token: u.token, body: { kind: 'event', title: 'Exam', durationMin: 60 } });
  assert.equal(noStart.status, 400);
  const created = await call('POST', `/api/schedules/${id}/items`, {
    token: u.token,
    body: [
      { kind: 'event', title: 'Exam', start: '2026-11-20T09:00:00-06:00', durationMin: 90, category: 'School' },
      { kind: 'task', title: 'Essay', durationMin: 120, deadline: '2026-11-20T17:00:00-06:00' },
    ],
  });
  assert.equal(created.status, 201);
  const exam = created.json.items[0];
  const patched = await call('PATCH', `/api/schedules/${id}/items/${exam.id}`, { token: u.token, body: { title: 'Final exam', priority: 5 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.item.title, 'Final exam');
  assert.equal((await call('PATCH', `/api/schedules/${id}/items/${exam.id}`, { token: u.token, body: { kind: 'event', start: null } })).status, 400);

  await call('PUT', `/api/schedules/${id}/preferences`, { token: u.token, body: { workingHours: { start: '08:00', end: '22:00' }, categoryPriority: { school: 5 }, protectedBreaks: [{ id: 'lunch', title: 'Lunch', durationMin: 45, windowStart: '12:00', windowEnd: '14:00' }], mobility: 'balanced' } });
  const plan = await call('POST', `/api/schedules/${id}/plan`, { token: u.token, body: { window: { date: '2026-11-20' } } });
  assert.equal(plan.status, 200, plan.text);
  const byTitle = Object.fromEntries(plan.json.items.map((i: { title: string }) => [i.title, i]));
  assert.equal(byTitle['Final exam'].locked, true);
  assert.equal(byTitle['Final exam'].priority, 5);
  assert.ok(byTitle.Essay.start && byTitle.Essay.end <= '2026-11-20T17:00:00-06:00');
  assert.equal(byTitle.Lunch.kind, 'break');
  assert.ok(byTitle.Lunch.start >= '2026-11-20T12:00:00-06:00' && byTitle.Lunch.end <= '2026-11-20T14:00:00-06:00');
  assert.equal((await call('DELETE', `/api/schedules/${id}/items/${exam.id}`, { token: u.token })).status, 204);
  assert.equal((await call('DELETE', `/api/schedules/${id}/items/${exam.id}`, { token: u.token })).status, 404);
  assert.equal((await call('PUT', `/api/schedules/${id}/preferences`, { token: u.token, body: { mobility: 'chaotic' } })).status, 400);
});

const ICS_A = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:a1', 'SUMMARY:Calculus', 'DTSTART;TZID=America/Chicago:20261120T090000', 'DTEND;TZID=America/Chicago:20261120T103000', 'PRIORITY:1', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a2', 'SUMMARY:Chemistry', 'DTSTART;TZID=America/Chicago:20261120T130000', 'DTEND;TZID=America/Chicago:20261120T143000', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const ICS_B = ICS_A.replace(/BEGIN:VEVENT\r\nUID:a2[\s\S]*?END:VEVENT\r\n/, '');

test('.ics import: dry run, idempotent re-import, user edits survive, vanished items are reported and KEPT', async () => {
  const t = await makeApp();
  const { call, token, scheduleId } = await guest(t);
  const before = (await call('GET', `/api/schedules/${scheduleId}/items`, { token })).json.items.length;
  const dry = await call('POST', `/api/schedules/${scheduleId}/import/ics`, { token, body: { ics: ICS_A, dryRun: true } });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.wouldImport, 2);
  assert.equal((await call('GET', `/api/schedules/${scheduleId}/items`, { token })).json.items.length, before); // dry run wrote nothing

  const first = await call('POST', `/api/schedules/${scheduleId}/import/ics`, { token, body: { ics: ICS_A } });
  assert.deepEqual(first.json.imported, { created: 2, updated: 0 });
  const items = (await call('GET', `/api/schedules/${scheduleId}/items`, { token })).json.items as { id: string; title: string; priority: number | null; source: string }[];
  assert.equal(items.length, before + 2);
  const calc = items.find((i) => i.title === 'Calculus')!;
  assert.equal(calc.priority, 5); // from the .ics PRIORITY
  assert.equal(calc.source, 'ics');

  // the user edits it ...
  await call('PATCH', `/api/schedules/${scheduleId}/items/${calc.id}`, { token, body: { priority: 2, locked: false } });
  // ... re-import is idempotent and does not overwrite the user's decisions
  const again = await call('POST', `/api/schedules/${scheduleId}/import/ics`, { token, body: { ics: ICS_A } });
  assert.deepEqual(again.json.imported, { created: 0, updated: 2 });
  const after = (await call('GET', `/api/schedules/${scheduleId}/items`, { token })).json.items as { title: string; priority: number | null; locked: boolean | null }[];
  assert.equal(after.length, before + 2);
  const calc2 = after.find((i) => i.title === 'Calculus')!;
  assert.equal(calc2.priority, 2);
  assert.equal(calc2.locked, false);

  // the source dropped an event: it is reported, not deleted
  const shrunk = await call('POST', `/api/schedules/${scheduleId}/import/ics`, { token, body: { ics: ICS_B } });
  assert.equal(shrunk.json.missing.length, 1);
  assert.equal(shrunk.json.missing[0].title, 'Chemistry');
  assert.match(shrunk.json.note, /kept/);
  assert.equal((await call('GET', `/api/schedules/${scheduleId}/items`, { token })).json.items.length, before + 2);
});

test('.ics import rejects garbage and oversized files', async () => {
  const t = await makeApp();
  const { call, token, scheduleId } = await guest(t);
  const bad = await call('POST', `/api/schedules/${scheduleId}/import/ics`, { token, body: { ics: 'this is definitely not a calendar file' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, 'not_ics');
  const huge = await call('POST', `/api/schedules/${scheduleId}/import/ics`, { token, body: '{"ics":"' + 'A'.repeat(3 * 1024 * 1024) + '"}' });
  assert.equal(huge.status, 413);
});

/* ───────────── adopt: copy-on-write, explicit confirmation ───────────── */

test('adopt creates a NEW schedule; deferrals need explicit confirmation and are kept; the original never changes', async () => {
  const t = await makeApp();
  const { call, token, scheduleId } = await guest(t);
  const date = await demoDate(t);
  const { id } = await idsByTitle(call, token, scheduleId, date);
  const originalItems = (await call('GET', `/api/schedules/${scheduleId}/items`, { token })).json;
  const disruptions = [{ type: 'overrun', targetId: id.Practice, minutes: 45 }];

  const noConfirm = await call('POST', `/api/schedules/${scheduleId}/adopt`, { token, body: { window: { date }, source: { kind: 'future', strategy: 'protect_priorities', disruptions } } });
  assert.equal(noConfirm.status, 400); // confirm: true is mandatory
  const unconfirmed = await call('POST', `/api/schedules/${scheduleId}/adopt`, { token, body: { window: { date }, confirm: true, source: { kind: 'future', strategy: 'protect_priorities', disruptions } } });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.json.error.code, 'deferral_not_confirmed');
  assert.equal(unconfirmed.json.error.details[0].id, id.Study);
  assert.equal((await call('GET', '/api/schedules', { token })).json.schedules.length, 1); // nothing was created

  const ok = await call('POST', `/api/schedules/${scheduleId}/adopt`, { token, body: { window: { date }, confirm: true, acceptDeferrals: [id.Study], source: { kind: 'future', strategy: 'protect_priorities', disruptions } } });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.originalScheduleUnchanged, true);
  assert.equal(ok.json.deferredKept, 1);
  const copyItems = (await call('GET', `/api/schedules/${ok.json.schedule.id}/items`, { token })).json.items as { title: string; start: string | null }[];
  assert.ok(copyItems.some((i) => i.title === 'Study' && i.start === null)); // kept, unscheduled: not deleted
  assert.equal(copyItems.length, 4);
  assert.equal(ok.json.schedule.sourceScheduleId, scheduleId);
  assert.deepEqual((await call('GET', `/api/schedules/${scheduleId}/items`, { token })).json, originalItems);
});

/* ───────────── account deletion ───────────── */

test('deleting the account erases everything the user owns', async () => {
  const t = await makeApp();
  const { call, token, scheduleId } = await guest(t);
  const noConfirm = await call('DELETE', '/api/me', { token, body: { confirm: 'yes' } });
  assert.equal(noConfirm.status, 400);
  assert.equal((await call('DELETE', '/api/me', { token, body: { confirm: 'delete my account' } })).status, 204);
  assert.equal((await call('GET', '/api/me', { token })).status, 401);
  for (const table of ['users', 'sessions', 'schedules', 'schedule_items', 'runs', 'connections']) {
    assert.equal((t.store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c, 0, `${table} not empty`);
  }
  assert.ok(scheduleId);
});
