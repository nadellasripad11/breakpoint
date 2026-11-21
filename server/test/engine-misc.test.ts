import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Plan, PlanItem } from '../src/engine/index.ts';
import { assertValidPlacements, baselineIssues, buildBaseline, buildWorld, diagnoseWorld, EngineInvariantError, expandProtectedBreaks, fortifyDay, runChaos, validatePlacements } from '../src/engine/index.ts';
import { at, landingPlan, mkPlan, prefs, settings } from './helpers.ts';
import { randomPlan } from './random.ts';

/* ───────────── chaos ───────────── */

test('chaos is reproducible: same plan + seed = identical report; a different seed explores differently', () => {
  const plan = landingPlan();
  const a = runChaos(plan, { scenarios: 150, seed: 42 });
  const b = runChaos(plan, { scenarios: 150, seed: 42 });
  const c = runChaos(plan, { scenarios: 150, seed: 43 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.worstScenarios, c.worstScenarios);
  // default seed is derived from the plan, so omitting it is deterministic too
  assert.deepEqual(runChaos(plan, { scenarios: 50 }), runChaos(plan, { scenarios: 50 }));
});

test('chaos statistics are sane and point at the fragile item', () => {
  const r = runChaos(landingPlan(), { scenarios: 300, seed: 7 });
  assert.ok(r.survivalRate >= 0 && r.survivalRate <= 1);
  assert.equal(r.resilienceScore, Math.round(r.survivalRate * 100));
  assert.ok(r.anyConflictRate >= 1 - r.survivalRate - 1e-9); // every critical failure is also a conflict
  assert.equal(r.fragileItems[0]!.itemId, 'project'); // the only hard deadline
  const sev = (s: 'mild' | 'realistic' | 'severe') => runChaos(landingPlan(), { scenarios: 300, seed: 7, severity: s }).survivalRate;
  assert.ok(sev('mild') >= sev('realistic') && sev('realistic') >= sev('severe'));
  assert.ok(r.summary.includes('Project'));
});

test('chaos caps the scenario count and handles empty plans', () => {
  const empty: Plan = { items: [], settings: settings() };
  const r = runChaos(empty, { scenarios: 10 });
  assert.equal(r.survivalRate, 1);
  assert.equal(runChaos(landingPlan(), { scenarios: 999999, seed: 1, examples: 0 }).scenarios, 2000);
});

/* ───────────── fortify ───────────── */

function slackPlan(): Plan {
  return mkPlan(
    [
      { id: 'x', title: 'Problem set', kind: 'task', duration: 60, start: at(16), release: at(15), deadline: at(17, 15), priority: 4 },
      { id: 'talk', title: 'Club meeting', kind: 'event', duration: 60, start: at(18), priority: 3 },
    ],
    settings({ from: at(15), to: at(21), hours: ['15:00', '21:00'] }),
  );
}

test('fortify proposes a small, proven improvement and never touches locked items or deadlines', () => {
  const plan = slackPlan();
  const snapshot = structuredClone(plan);
  const r = fortifyDay(plan);
  assert.deepEqual(plan, snapshot); // proposal only: the input is untouched
  assert.ok(r.adjustments.length >= 1);
  const first = r.adjustments[0]!;
  assert.equal(first.itemId, 'x');
  assert.ok(first.shiftMinutes < 0 && first.shiftMinutes >= -45);
  assert.ok(first.gain.dayStartToleranceMinutes > 0);
  assert.ok((r.after.dayStartTolerance ?? 240) > (r.before.dayStartTolerance ?? 240));
  assert.ok(r.after.survivalRate >= r.before.survivalRate);
  const x = r.proposedStarts.find((p) => p.id === 'x')!;
  assert.ok(x.end <= at(17, 15) && x.start >= at(15));
  const talk = r.proposedStarts.find((p) => p.id === 'talk')!;
  assert.equal(talk.start, at(18));
  assert.equal(talk.changed, false);
  assert.match(r.explanation[r.explanation.length - 1]!, /proposal only/);
});

test('fortify never makes a schedule worse (property over random plans)', () => {
  let improved = 0;
  for (let seed = 600; seed < 640; seed++) {
    const plan = randomPlan(seed);
    if (!plan) continue;
    const before = structuredClone(plan);
    const r = fortifyDay(plan, { scenarios: 30 });
    assert.deepEqual(plan, before);
    assert.ok(r.after.survivalRate >= r.before.survivalRate - 1e-9, `seed ${seed}: survival got worse`);
    for (const p of r.proposedStarts) {
      const orig: PlanItem = plan.items.find((i) => i.id === p.id)!;
      if (orig.locked) assert.equal(p.start, orig.start, `seed ${seed}: locked "${p.id}" moved`);
      if (orig.deadline !== undefined) assert.ok(p.end <= orig.deadline, `seed ${seed}: deadline violated`);
      if (orig.release !== undefined) assert.ok(p.start >= orig.release, `seed ${seed}: release violated`);
    }
    if (r.adjustments.length) improved++;
  }
  assert.ok(improved >= 1, 'fortify should find something on at least one random day');
});

/* ───────────── baseline + preferences ───────────── */

test('baseline places unscheduled tasks earliest-first around locked events, honouring deadlines, deterministically', () => {
  const plan = mkPlan(
    [
      { id: 'class', kind: 'event', duration: 120, start: at(9) },
      { id: 'a', title: 'Essay', kind: 'task', duration: 90, priority: 4, deadline: at(15) },
      { id: 'b', title: 'Reading', kind: 'task', duration: 60, priority: 2 },
    ],
    settings(),
  );
  const r = buildBaseline(plan);
  assert.equal(r.unscheduled.length, 0);
  const starts = Object.fromEntries(r.plan.items.map((i) => [i.id, i.start]));
  assert.equal(starts.class, at(9)); // locked: untouched
  assert.ok(starts.a! >= at(7) && starts.a! + 90 <= at(15));
  assert.ok(![[starts.a!, 90], [starts.b!, 60]].some(([s, d], i, arr) => arr.some(([s2, d2], j) => i !== j && s! < s2! + d2! && s2! < s! + d!)));
  for (const t of ['a', 'b'] as const) assert.ok(starts[t]! + (t === 'a' ? 90 : 60) <= at(9) || starts[t]! >= at(11));
  assert.deepEqual(buildBaseline(plan), r);
  assert.equal(plan.items.find((i) => i.id === 'a')!.start, undefined); // input unchanged
});

test('baseline reports (never drops) a task that cannot be placed', () => {
  const plan = mkPlan([{ id: 'big', title: 'Thesis', kind: 'task', duration: 600, priority: 5, deadline: at(12) }], settings());
  const r = buildBaseline(plan);
  assert.equal(r.unscheduled.length, 1);
  assert.match(r.unscheduled[0]!.message, /NOT removed/);
  assert.ok(r.diagnosis);
  assert.ok(r.plan.items.some((i) => i.id === 'big')); // still in the plan
});

test('protected breaks expand into one flexible, non-deferrable item per day inside the window', () => {
  const p = prefs({ protectedBreaks: [{ id: 'lunch', title: 'Lunch', durationMin: 45, windowStart: '12:00', windowEnd: '14:00' }] });
  const horizon = { start: at(0, 0, 20), end: at(0, 0, 23) };
  const breaks = expandProtectedBreaks(horizon, p);
  assert.equal(breaks.length, 3);
  assert.ok(breaks.every((b) => b.kind === 'break' && !b.deferrable && b.duration === 45 && b.deadline! - b.release! === 120));
  assert.throws(() => expandProtectedBreaks(horizon, prefs({ protectedBreaks: [{ id: 'x', title: 'x', durationMin: 90, windowStart: '12:00', windowEnd: '13:00' }] })), /does not fit/);
});

test('baselineIssues reports problems that already exist in the plan, without "fixing" them', () => {
  const plan = mkPlan(
    [
      { id: 'a', title: 'Meeting A', kind: 'event', duration: 60, start: at(9) },
      { id: 'b', title: 'Meeting B', kind: 'event', duration: 60, start: at(9, 30) },
      { id: 'c', title: 'Report', kind: 'task', duration: 60, start: at(16), deadline: at(16, 30) },
    ],
    settings(),
  );
  const issues = baselineIssues(plan);
  assert.ok(issues.some((i) => i.code === 'locked_overlap' && i.itemIds.includes('a') && i.itemIds.includes('b')));
  assert.ok(issues.some((i) => i.code === 'deadline_violated' && i.itemIds[0] === 'c'));
});

/* ───────────── validator + diagnosis ───────────── */

test('the validator catches every kind of invalid plan (it is the last line of defence)', () => {
  const world = buildWorld(landingPlan(), []);
  const good = new Map([['study', at(16)], ['practice', at(17)], ['project', at(18, 30)], ['rest', at(19, 30)]]);
  assert.deepEqual(validatePlacements(world, good, []), []);
  assert.ok(validatePlacements(world, new Map([...good, ['practice', at(16, 30)]]), []).some((v) => /overlaps/.test(v)));
  assert.ok(validatePlacements(world, new Map([...good, ['project', at(20, 30)]]), []).some((v) => /deadline/.test(v)));
  const missing = new Map(good);
  missing.delete('project');
  assert.ok(validatePlacements(world, missing, []).some((v) => /either placed or deferred/.test(v)));
  assert.ok(validatePlacements(world, missing, ['project']).some((v) => /not deferrable/.test(v)));
  assert.ok(validatePlacements(world, new Map([...good, ['study', at(14)]]), []).some((v) => /before its release|outside free time/.test(v)));
  assert.throws(() => assertValidPlacements(world, missing, []), EngineInvariantError);
});

test('diagnosis names the cause, the minimal conflicting set and concrete fixes', () => {
  const plan = mkPlan(
    [
      { id: 'a', title: 'Essay', kind: 'task', duration: 180, start: at(15), deadline: at(17), priority: 5 },
      { id: 'b', title: 'Gym', kind: 'task', duration: 30, start: at(18), priority: 5 },
    ],
    settings({ from: at(15), to: at(21), hours: ['15:00', '21:00'] }),
  );
  const d = diagnoseWorld(buildWorld(plan, []), plan, []);
  assert.deepEqual(d.conflictSet, ['a']); // gym is innocent and is not blamed
  assert.equal(d.reasons[0]!.code, 'impossible_window');
  assert.ok(d.suggestions.some((s) => s.action === 'extend_deadline' && s.itemId === 'a' && s.minutes === 60));
  assert.ok(d.suggestions.some((s) => s.action === 'shorten' && s.itemId === 'a' && s.minutes === 60));
  assert.match(d.summary, /Nothing was removed or moved/);
});

test('diagnosis detects fragmentation: enough free time in total but not in one piece', () => {
  const plan = mkPlan(
    [
      { id: 'm1', kind: 'event', duration: 60, start: at(16) },
      { id: 'm2', kind: 'event', duration: 60, start: at(18) },
      { id: 'job', title: 'Workshop', kind: 'task', duration: 90, start: at(15), deadline: at(20), priority: 5 },
    ],
    settings({ from: at(15), to: at(20), hours: ['15:00', '20:00'] }),
  );
  const d = diagnoseWorld(buildWorld(plan, []), plan, []);
  assert.equal(d.reasons[0]!.code, 'fragmentation');
  assert.match(d.reasons[0]!.message, /one piece/);
});
