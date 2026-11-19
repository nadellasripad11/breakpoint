import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoToMin, minToZonedIso, zonedToMin } from '../src/engine/index.ts';
import { ImportError, parseIcs } from '../src/calendar/ics.ts';
import { expandRecurrence, parseRRule } from '../src/calendar/recurrence.ts';
import { buildPlan } from '../src/calendar/expand.ts';
import type { StoredItem } from '../src/calendar/expand.ts';
import { at, prefs, TZ } from './helpers.ts';

const CT = 'America/Chicago';
/** window from local midnight of (y,mo,d1) to local midnight of (y2,mo2,d2) */
const win = (y: number, mo: number, d1: number, y2: number, mo2: number, d2: number) => ({ start: zonedToMin(y, mo, d1, 0, 0, CT), end: zonedToMin(y2, mo2, d2, 0, 0, CT) });
const days = (starts: number[]) => starts.map((m) => minToZonedIso(m, CT).slice(0, 16));

/* ───────────── recurrence ───────────── */

test('weekly BYDAY with COUNT, EXDATE, and the same wall-clock time across DST', () => {
  const rule = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6');
  const start = { y: 2026, mo: 10, d: 26, h: 9, mi: 0 }; // Mon 26 Oct 2026, CDT
  const all = expandRecurrence({ start, timezone: CT, durationMin: 60, rule, window: win(2026, 10, 1, 2026, 12, 1) });
  assert.deepEqual(days(all), ['2026-10-26T09:00', '2026-10-28T09:00', '2026-11-02T09:00', '2026-11-04T09:00', '2026-11-09T09:00', '2026-11-11T09:00']);
  // DST ended on 1 Nov: still 09:00 wall-clock, but 25 hours (not 24) between 4 Nov and 3 Nov-equivalent instants
  assert.equal(all[2]! - all[1]!, 5 * 1440 + 60);
  const ex = expandRecurrence({ start, timezone: CT, durationMin: 60, rule, exdates: [all[1]!], window: win(2026, 10, 1, 2026, 12, 1) });
  assert.equal(ex.length, 5); // EXDATE removes it
  const inWin = expandRecurrence({ start, timezone: CT, durationMin: 60, rule, window: win(2026, 11, 3, 2026, 11, 10) });
  assert.deepEqual(days(inWin), ['2026-11-04T09:00', '2026-11-09T09:00']);
});

test('monthly nth weekday, last weekday, month-end clamping and yearly', () => {
  const second = expandRecurrence({ start: { y: 2026, mo: 1, d: 13, h: 10, mi: 0 }, timezone: CT, durationMin: 30, rule: parseRRule('FREQ=MONTHLY;BYDAY=2TU'), window: win(2026, 1, 1, 2026, 4, 1) });
  assert.deepEqual(days(second.slice(0, 3)), ['2026-01-13T10:00', '2026-02-10T10:00', '2026-03-10T10:00']);
  const last = expandRecurrence({ start: { y: 2026, mo: 1, d: 30, h: 8, mi: 0 }, timezone: CT, durationMin: 30, rule: parseRRule('FREQ=MONTHLY;BYDAY=-1FR'), window: win(2026, 1, 1, 2026, 4, 1) });
  assert.deepEqual(days(last.slice(0, 2)), ['2026-01-30T08:00', '2026-02-27T08:00']);
  const m31 = expandRecurrence({ start: { y: 2026, mo: 1, d: 31, h: 8, mi: 0 }, timezone: CT, durationMin: 30, rule: parseRRule('FREQ=MONTHLY'), window: win(2026, 1, 1, 2026, 7, 1) });
  assert.deepEqual(days(m31.slice(0, 3)), ['2026-01-31T08:00', '2026-03-31T08:00', '2026-05-31T08:00']); // months without a 31st are skipped
  const yearly = expandRecurrence({ start: { y: 2024, mo: 2, d: 29, h: 8, mi: 0 }, timezone: CT, durationMin: 30, rule: parseRRule('FREQ=YEARLY'), window: { start: zonedToMin(2024, 1, 1, 0, 0, CT), end: zonedToMin(2029, 1, 1, 0, 0, CT) } });
  assert.deepEqual(days(yearly), ['2024-02-29T08:00', '2028-02-29T08:00']);
});

test('UNTIL, INTERVAL, daily, and bounded expansion', () => {
  const until = expandRecurrence({ start: { y: 2026, mo: 11, d: 2, h: 9, mi: 0 }, timezone: CT, durationMin: 30, rule: parseRRule('FREQ=DAILY;INTERVAL=2;UNTIL=20261108T235959Z'), window: win(2026, 11, 1, 2026, 12, 1) });
  assert.deepEqual(days(until), ['2026-11-02T09:00', '2026-11-04T09:00', '2026-11-06T09:00', '2026-11-08T09:00']);
  const cap = expandRecurrence({ start: { y: 2020, mo: 1, d: 1, h: 9, mi: 0 }, timezone: CT, durationMin: 30, rule: parseRRule('FREQ=DAILY'), window: { start: zonedToMin(2020, 1, 1, 0, 0, CT), end: zonedToMin(2040, 1, 1, 0, 0, CT) } });
  assert.ok(cap.length <= 1000); // never unbounded
  assert.throws(() => parseRRule('FREQ=SECONDLY'), /FREQ/);
  assert.throws(() => parseRRule('FREQ=DAILY;COUNT=0'), /COUNT/);
});

/* ───────────── ics ───────────── */

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:School',
  'X-WR-TIMEZONE:America/Chicago',
  'BEGIN:VTIMEZONE',
  'TZID:America/Chicago',
  'BEGIN:STANDARD',
  'DTSTART:19701101T020000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0600',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:class-1',
  'SUMMARY:Calculus\\, section 2',
  'DTSTART;TZID=America/Chicago:20261120T090000',
  'DTEND;TZID=America/Chicago:20261120T103000',
  'RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=4',
  'EXDATE;TZID=America/Chicago:20261127T090000',
  'PRIORITY:1',
  'CATEGORIES:School',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:lunch-1',
  'SUMMARY:A very long summary that is folded',
  ' across two lines',
  'DTSTART:20261120T180000Z',
  'DURATION:PT45M',
  'TRANSP:TRANSPARENT',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:holiday',
  'SUMMARY:Thanksgiving',
  'DTSTART;VALUE=DATE:20261126',
  'DTEND;VALUE=DATE:20261127',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:cancelled-1',
  'SUMMARY:Cancelled thing',
  'STATUS:CANCELLED',
  'DTSTART:20261120T200000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:class-1',
  'RECURRENCE-ID;TZID=America/Chicago:20261204T090000',
  'SUMMARY:Calculus (moved)',
  'DTSTART;TZID=America/Chicago:20261204T140000',
  'DTEND;TZID=America/Chicago:20261204T153000',
  'END:VEVENT',
  'BEGIN:VTODO',
  'UID:todo-1',
  'SUMMARY:Essay draft',
  'DUE;TZID=America/Chicago:20261125T170000',
  'PRIORITY:2',
  'END:VTODO',
  'BEGIN:VTODO',
  'UID:todo-done',
  'SUMMARY:Already done',
  'STATUS:COMPLETED',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

test('parses events, folding, escapes, tz, duration, recurrence, overrides, todos, cancelled, transparent, all-day', () => {
  const r = parseIcs(ICS);
  assert.equal(r.calendarName, 'School');
  const byId = Object.fromEntries(r.items.map((i) => [i.externalId, i]));
  const cal = byId['class-1']!;
  assert.equal(cal.title, 'Calculus, section 2');
  assert.equal(cal.start, '2026-11-20T09:00:00-06:00');
  assert.equal(cal.durationMin, 90);
  assert.equal(cal.priority, 5);
  assert.equal(cal.category, 'School');
  assert.equal(cal.recurrence!.rrule, 'FREQ=WEEKLY;BYDAY=FR;COUNT=4');
  assert.equal(cal.recurrence!.exdates.length, 2); // the EXDATE plus the occurrence that was moved
  assert.ok(cal.recurrence!.exdates.includes('2026-11-27T09:00:00-06:00'));
  assert.ok(cal.recurrence!.exdates.includes('2026-12-04T09:00:00-06:00'));
  assert.equal(byId['class-1#2026-12-04T09:00:00-06:00']!.title, 'Calculus (moved)');
  const lunch = byId['lunch-1']!;
  assert.equal(lunch.title, 'A very long summary that is foldedacross two lines'.replace('foldedacross', 'folded' + 'across'));
  assert.equal(lunch.durationMin, 45);
  assert.equal(lunch.blocking, false); // TRANSPARENT = free time
  assert.equal(byId.holiday!.allDay, true);
  assert.equal(byId.holiday!.blocking, false);
  assert.equal(byId['cancelled-1'], undefined);
  const todo = byId['todo-1']!;
  assert.equal(todo.kind, 'task');
  assert.equal(todo.start, null);
  assert.equal(todo.deadline, '2026-11-25T17:00:00-06:00');
  assert.equal(todo.priority, 5);
  assert.equal(byId['todo-done'], undefined);
});

test('ics parser rejects garbage and oversize input, survives malformed content', () => {
  assert.throws(() => parseIcs('hello'), (e: unknown) => e instanceof ImportError && e.code === 'not_ics');
  assert.throws(() => parseIcs('BEGIN:VCALENDAR\n' + 'X'.repeat(3 * 1024 * 1024)), (e: unknown) => e instanceof ImportError && e.code === 'too_large');
  const messy = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:No start\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:garbage\nSUMMARY:Bad\nEND:VEVENT\nBEGIN:VEVENT\nUID:ok\nSUMMARY:Fine\nDTSTART:20261120T100000Z\nEND:VEVENT\n::::\nEND:VCALENDAR';
  const r = parseIcs(messy);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]!.durationMin, 30); // no end -> 30m, with a warning
  assert.ok(r.warnings.some((w) => /30 minutes/.test(w)));
  assert.ok(r.warnings.some((w) => /without a readable start/.test(w)));
  const many = 'BEGIN:VCALENDAR\n' + Array.from({ length: 5001 }, (_, i) => `BEGIN:VEVENT\nUID:${i}\nDTSTART:20261120T100000Z\nEND:VEVENT`).join('\n') + '\nEND:VCALENDAR';
  assert.throws(() => parseIcs(many), (e: unknown) => e instanceof ImportError && e.code === 'too_many_items');
});

test('unknown / Windows time zones and floating times are handled with a warning, not a crash', () => {
  const r = parseIcs(
    ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:w', 'SUMMARY:Outlook', 'DTSTART;TZID=Central Standard Time:20261120T090000', 'DTEND;TZID=Central Standard Time:20261120T100000', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:u', 'SUMMARY:Odd', 'DTSTART;TZID=Narnia/Cair:20261120T090000', 'DTEND;TZID=Narnia/Cair:20261120T100000', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:f', 'SUMMARY:Floating', 'DTSTART:20261120T090000', 'DTEND:20261120T100000', 'END:VEVENT', 'END:VCALENDAR'].join('\n'),
    { defaultTimezone: CT },
  );
  assert.equal(r.items.find((i) => i.externalId === 'w')!.start, '2026-11-20T09:00:00-06:00');
  assert.equal(r.items.find((i) => i.externalId === 'u')!.start, '2026-11-20T09:00:00-06:00');
  assert.ok(r.warnings.some((w) => /Unknown time zone/.test(w)));
  assert.ok(r.warnings.some((w) => /Floating/.test(w)));
});

/* ───────────── stored items -> plan ───────────── */

const stored = (p: Partial<StoredItem> & { id: string }): StoredItem => ({
  kind: 'event', title: p.id, start: null, durationMin: 60, allDay: false, timezone: TZ, locked: null, priority: null, category: null, deadline: null, release: null,
  deferrable: null, critical: null, blocking: true, recurrence: null, source: 'manual', externalId: null, ...p,
});

test('buildPlan expands recurrences, applies preference priorities, places tasks, adds protected breaks', () => {
  const p = prefs({ categoryPriority: { School: 5, Fitness: 4 }, protectedBreaks: [{ id: 'lunch', title: 'Lunch', durationMin: 30, windowStart: '12:00', windowEnd: '14:00' }] });
  const horizon = { start: at(0, 0, 20), end: at(0, 0, 21) };
  const items = [
    stored({ id: 'class', title: 'Calculus', start: '2026-11-13T09:00:00-06:00', durationMin: 90, category: 'School', recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=FR', exdates: [] } }),
    stored({ id: 'gym', kind: 'task', title: 'Gym', durationMin: 60, category: 'Fitness' }),
    stored({ id: 'essay', kind: 'task', title: 'Essay', durationMin: 120, deadline: '2026-11-20T17:00:00-06:00' }),
    stored({ id: 'elsewhere', title: 'Other day', start: '2026-12-25T09:00:00-06:00' }),
    stored({ id: 'banner', title: 'Holiday', start: '2026-11-20T00:00:00-06:00', allDay: true }),
  ];
  const built = buildPlan(items, p, horizon);
  const ids = built.plan.items.map((i) => i.id);
  assert.ok(ids.includes('class@2026-11-20T09:00'));
  assert.ok(!ids.includes('elsewhere'));
  const cls = built.plan.items.find((i) => i.id === 'class@2026-11-20T09:00')!;
  assert.equal(cls.start, at(9));
  assert.equal(cls.locked, true);
  assert.equal(cls.priority, 5);
  assert.equal(cls.critical, true);
  assert.equal(built.plan.items.find((i) => i.id === 'gym')!.priority, 4);
  assert.equal(built.plan.items.find((i) => i.id === 'banner')!.blocking, false);
  assert.ok(built.plan.items.every((i) => !i.blocking || i.start !== undefined), 'every blocking item got a slot');
  const essay = built.plan.items.find((i) => i.id === 'essay')!;
  assert.ok(essay.start! + 120 <= at(17));
  const lunch = built.plan.items.find((i) => i.kind === 'break')!;
  assert.ok(lunch.start! >= at(12) && lunch.start! + 30 <= at(14));
  assert.equal(lunch.deferrable, false);
  assert.equal(built.baseline.unscheduled.length, 0);
});

test('buildPlan validates the horizon and survives a bad RRULE with a warning', () => {
  const p = prefs();
  assert.throws(() => buildPlan([], p, { start: at(10), end: at(9) }), /after/);
  assert.throws(() => buildPlan([], p, { start: at(0), end: at(0) + 40 * 1440 }), /31 days/);
  const r = buildPlan([stored({ id: 'bad', start: '2026-11-20T09:00:00-06:00', recurrence: { rrule: 'FREQ=NEVER', exdates: [] } })], p, { start: at(0), end: at(24) });
  assert.ok(r.warnings.some((w) => /left out of the plan/.test(w)));
  assert.equal(isoToMin('2026-11-20T09:00:00-06:00'), at(9));
});
