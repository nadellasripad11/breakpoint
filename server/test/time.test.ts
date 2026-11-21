import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAvailability, fmtClock, fmtDuration, isoToMin, minToZonedIso, normalizePreferences, parseHHMM, tzOffsetMin, zonedToMin } from '../src/engine/index.ts';

test('zoned <-> epoch round trip', () => {
  const m = zonedToMin(2026, 11, 20, 17, 0, 'America/Chicago');
  assert.equal(minToZonedIso(m, 'America/Chicago'), '2026-11-20T17:00:00-06:00');
  assert.equal(isoToMin('2026-11-20T17:00:00-06:00'), m);
  assert.equal(isoToMin('2026-11-20T23:00:00Z'), m);
});

test('DST: wall-clock arithmetic across spring-forward and fall-back', () => {
  // us spring forward: 2026-03-08, 02:00 -> 03:00 in chicago. 02:30 does not exist.
  const before = zonedToMin(2026, 3, 8, 1, 30, 'America/Chicago');
  const after = zonedToMin(2026, 3, 8, 3, 30, 'America/Chicago');
  assert.equal(after - before, 60); // only one real hour passes
  assert.equal(tzOffsetMin(before, 'America/Chicago'), -360);
  assert.equal(tzOffsetMin(after, 'America/Chicago'), -300);
  const gap = zonedToMin(2026, 3, 8, 2, 30, 'America/Chicago');
  assert.ok(gap >= before + 30 && gap <= after); // nonexistent time resolves forward, never backward
  // fall back: 2026-11-01, 02:00 -> 01:00. a day is 25 hours long.
  const dayStart = zonedToMin(2026, 11, 1, 0, 0, 'America/Chicago');
  const nextDay = zonedToMin(2026, 11, 2, 0, 0, 'America/Chicago');
  assert.equal(nextDay - dayStart, 25 * 60);
});

test('formatting helpers', () => {
  const m = zonedToMin(2026, 11, 20, 0, 5, 'America/Chicago');
  assert.equal(fmtClock(m, 'America/Chicago'), '12:05 AM');
  assert.equal(fmtClock(zonedToMin(2026, 11, 20, 12, 0, 'America/Chicago'), 'America/Chicago'), '12:00 PM');
  assert.equal(fmtDuration(45), '45m');
  assert.equal(fmtDuration(90), '1h 30m');
  assert.equal(fmtDuration(120), '2h');
  assert.equal(parseHHMM('24:00'), 1440);
  assert.throws(() => parseHHMM('25:00'));
  assert.throws(() => isoToMin('not a date'));
});

test('availability follows working hours per local day, including DST days', () => {
  const prefs = normalizePreferences({ timezone: 'America/Chicago', workingHours: { start: '08:00', end: '22:00', days: [1, 2, 3, 4, 5] } });
  const horizon = { start: zonedToMin(2026, 11, 20, 0, 0, 'America/Chicago'), end: zonedToMin(2026, 11, 23, 0, 0, 'America/Chicago') }; // fri, sat, sun
  const av = buildAvailability(horizon, prefs);
  assert.equal(av.length, 1); // only friday works
  assert.equal(av[0]!.end - av[0]!.start, 14 * 60);
  assert.throws(() => normalizePreferences({ timezone: 'Mars/Olympus' }));
  assert.throws(() => normalizePreferences({ workingHours: { start: '10:00', end: '09:00' } }));
});
