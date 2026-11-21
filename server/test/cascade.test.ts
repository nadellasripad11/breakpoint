import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanError, simulateCascade } from '../src/engine/index.ts';
import { at, landingPlan, mkPlan, settings } from './helpers.ts';

const byId = (r: ReturnType<typeof simulateCascade>, id: string) => r.outcomes.find((o) => o.id === id)!;

test('landing scenario: Practice runs 45m long and the ripple pushes Project past its deadline', () => {
  const r = simulateCascade(landingPlan(), [{ type: 'overrun', targetId: 'practice', minutes: 45 }]);
  assert.equal(byId(r, 'study').status, 'unchanged');
  assert.equal(byId(r, 'practice').simulated.end, at(19, 15));
  assert.equal(byId(r, 'project').simulated.start, at(19, 15));
  assert.equal(byId(r, 'project').simulated.end, at(20, 15));
  assert.equal(byId(r, 'rest').shiftMinutes, 45);
  const c = r.conflicts.find((x) => x.code === 'deadline_missed')!;
  assert.equal(c.severity, 'critical');
  assert.equal(c.itemId, 'project');
  assert.equal(c.minutes, 15);
  assert.equal(r.summary.survives, false);
  assert.match(r.summary.headline, /Project.*8:00 PM deadline/);
  assert.ok(r.ripple.some((e) => e.to === 'project' && e.from === 'practice'));
});

test('no disruption: nothing moves and nothing conflicts', () => {
  const r = simulateCascade(landingPlan(), []);
  assert.equal(r.conflicts.length, 0);
  assert.ok(r.outcomes.every((o) => o.status === 'unchanged' && o.shiftMinutes === 0));
  assert.equal(r.summary.survives, true);
});

test('small disruptions are absorbed by slack (no conflicts, only shifts)', () => {
  const r = simulateCascade(landingPlan(), [{ type: 'overrun', targetId: 'practice', minutes: 20 }]);
  assert.equal(r.conflicts.length, 0);
  assert.equal(byId(r, 'project').status, 'shifted');
  assert.match(r.summary.headline, /Absorbed/);
});

test('locked commitments never move, and flexible work pauses around them then resumes', () => {
  const plan = mkPlan(
    [
      { id: 'T', title: 'Essay', kind: 'task', duration: 60, start: at(15, 30), priority: 3 },
      { id: 'E', title: 'Class', kind: 'event', duration: 60, start: at(16, 30) },
      { id: 'U', title: 'Reading', kind: 'task', duration: 30, start: at(17, 30), priority: 2 },
    ],
    settings({ from: at(8), to: at(22) }),
  );
  const r = simulateCascade(plan, [{ type: 'overrun', targetId: 'T', minutes: 30 }]);
  const cls = byId(r, 'E');
  assert.equal(cls.simulated.start, at(16, 30));
  assert.equal(cls.shiftMinutes, 0);
  const essay = byId(r, 'T');
  assert.equal(essay.fragments.length, 2);
  assert.deepEqual(essay.fragments[0], { start: at(15, 30), end: at(16, 30) });
  assert.deepEqual(essay.fragments[1], { start: at(17, 30), end: at(18, 0) });
  assert.equal(byId(r, 'U').simulated.start, at(18, 0)); // pushed behind the resumed essay
  assert.equal(r.conflicts.filter((c) => c.severity === 'critical').length, 0);
});

test('an unexpected commitment on top of a critical locked event is a critical locked_overlap', () => {
  const plan = mkPlan([{ id: 'exam', title: 'Exam', kind: 'event', duration: 60, start: at(17), critical: true, priority: 5 }], settings());
  const r = simulateCascade(plan, [{ type: 'unexpected', start: at(17, 30), duration: 30, title: 'Family emergency' }]);
  const c = r.conflicts[0]!;
  assert.equal(c.code, 'locked_overlap');
  assert.equal(c.severity, 'critical');
  assert.equal(c.minutes, 30);
  assert.equal(byId(r, 'exam').simulated.start, at(17)); // the exam is untouched; the conflict is reported, not "resolved"
});

test('a delayed locked event moves as a whole and can collide with the next locked event', () => {
  const plan = mkPlan(
    [
      { id: 'a', kind: 'event', duration: 60, start: at(9), critical: true },
      { id: 'b', kind: 'event', duration: 60, start: at(10), critical: true },
    ],
    settings(),
  );
  const r = simulateCascade(plan, [{ type: 'delay', targetId: 'a', minutes: 30 }]);
  assert.equal(byId(r, 'a').simulated.start, at(9, 30));
  assert.equal(r.conflicts[0]!.code, 'locked_overlap');
  assert.equal(r.conflicts[0]!.minutes, 30);
});

test('simulations are non-destructive: the plan object is never mutated', () => {
  const plan = landingPlan();
  const snapshot = structuredClone(plan);
  simulateCascade(plan, [{ type: 'overrun', targetId: 'practice', minutes: 90 }, { type: 'lost_time', minutes: 20 }, { type: 'unexpected', start: at(18), duration: 30 }]);
  assert.deepEqual(plan, snapshot);
});

test('invalid disruptions are rejected with a clear PlanError', () => {
  const plan = landingPlan();
  assert.throws(() => simulateCascade(plan, [{ type: 'overrun', targetId: 'nope', minutes: 10 }]), (e: unknown) => e instanceof PlanError && e.code === 'unknown_target');
  assert.throws(() => simulateCascade(plan, [{ type: 'delay', targetId: 'study', minutes: -5 }]), (e: unknown) => e instanceof PlanError && e.code === 'invalid_disruption');
  assert.throws(() => simulateCascade(plan, [{ type: 'delay', targetId: 'study', minutes: 1e9 }]), PlanError);
});

test('deterministic: identical input gives identical output', () => {
  const d = [{ type: 'overrun' as const, targetId: 'practice', minutes: 33 }, { type: 'lost_time' as const, minutes: 12 }];
  assert.deepEqual(simulateCascade(landingPlan(), d), simulateCascade(landingPlan(), d));
});

test('a missed protected-break window is reported as break_lost, not hidden', () => {
  const plan = mkPlan(
    [
      { id: 'work', kind: 'task', duration: 120, start: at(10), priority: 4 },
      { id: 'lunch', title: 'Lunch', kind: 'break', duration: 30, start: at(12), release: at(11, 30), deadline: at(13), priority: 5 },
    ],
    settings(),
  );
  const r = simulateCascade(plan, [{ type: 'overrun', targetId: 'work', minutes: 90 }]);
  const c = r.conflicts.find((x) => x.code === 'break_lost')!;
  assert.ok(c);
  assert.equal(c.itemId, 'lunch');
});
