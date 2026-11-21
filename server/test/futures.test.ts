import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Disruption, Future, Plan, StrategyId } from '../src/engine/index.ts';
import { Rng, generateScenario, parallelFutures, simulateCascade } from '../src/engine/index.ts';
import { at, landingPlan, mkPlan, settings } from './helpers.ts';
import { randomPlan } from './random.ts';

const STRATEGIES: StrategyId[] = ['protect_priorities', 'maximize_completion', 'minimize_changes'];
const get = (f: ReturnType<typeof parallelFutures>, s: StrategyId) => f.futures.find((x) => x.strategy === s)!;

/** every guarantee the product makes, checked independently of the code that produced the plan. */
function checkFuture(plan: Plan, disruptions: Disruption[], f: Future, label: string): void {
  if (!f.feasible) {
    assert.ok(f.diagnosis, `${label}: infeasible results must explain themselves`);
    assert.ok(f.diagnosis.summary.length > 0 && f.diagnosis.conflictSet.length > 0, `${label}: diagnosis must name the conflict`);
    assert.equal(f.items.length, 0, `${label}: nothing is proposed when infeasible`);
    return;
  }
  const byId = new Map(f.items.map((i) => [i.id, i]));
  const deferred = new Set(f.deferred.map((d) => d.id));
  // 1 · nothing vanishes: every original item is either in the plan or explicitly deferred, exactly once
  for (const it of plan.items) assert.ok(byId.has(it.id) !== deferred.has(it.id), `${label}: "${it.id}" must be placed xor deferred`);
  assert.equal(f.items.length + f.deferred.length, plan.items.length + disruptions.filter((d) => d.type === 'unexpected' || d.type === 'lost_time').length, `${label}: item count`);
  // 2 · locked commitments never move (except by the disruption itself, e.g. a delayed meeting)
  for (const it of plan.items.filter((i) => i.locked && i.blocking)) {
    const delay = disruptions.filter((d) => d.type === 'delay' && d.targetId === it.id).reduce((s, d) => s + (d as { minutes: number }).minutes, 0);
    const extra = disruptions.filter((d) => d.type === 'overrun' && d.targetId === it.id).reduce((s, d) => s + (d as { minutes: number }).minutes, 0);
    const out = byId.get(it.id)!;
    assert.equal(out.start, it.start! + delay, `${label}: locked "${it.id}" moved`);
    assert.equal(out.end - out.start, it.duration + extra, `${label}: locked "${it.id}" resized`);
    assert.equal(out.status, 'locked');
  }
  // 3 · only deferrable, non-break items may be deferred
  for (const d of f.deferred) {
    const it = plan.items.find((i) => i.id === d.id)!;
    assert.ok(it.deferrable && it.kind !== 'break' && !it.locked, `${label}: "${d.id}" is not deferrable`);
    assert.match(d.message, /not been deleted/);
  }
  assert.equal(f.requiresConfirmation, f.deferred.length > 0);
  // 4 · deadlines, release times, availability; and no overlaps between any two blocking items
  const blocking = f.items.filter((i) => plan.items.find((p) => p.id === i.id)?.blocking !== false);
  for (const out of blocking) {
    const it = plan.items.find((p) => p.id === out.id);
    if (!it || it.locked) continue;
    if (it.deadline !== undefined) assert.ok(out.end <= it.deadline, `${label}: "${out.id}" violates its deadline`);
    if (it.release !== undefined) assert.ok(out.start >= it.release, `${label}: "${out.id}" starts before its release`);
    assert.ok(plan.settings.availability.some((a) => out.start >= a.start && out.end <= a.end), `${label}: "${out.id}" is outside available hours`);
  }
  const sorted = [...blocking].sort((a, b) => a.start - b.start);
  const preLocked = (a: string, b: string) => {
    const x = plan.items.find((p) => p.id === a);
    const y = plan.items.find((p) => p.id === b);
    return !!x?.locked && !!y?.locked;
  };
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (b.start < a.end && !(a.locked && b.locked)) assert.fail(`${label}: "${a.id}" overlaps "${b.id}"`);
    void preLocked;
  }
  // 5 · metrics add up
  assert.equal(f.metrics.deferredCount, f.deferred.length);
  assert.equal(f.metrics.keptCount + f.metrics.movedCount, f.metrics.placedCount);
}

test('landing page: Practice +45m gives three genuinely different, valid futures', () => {
  const plan = landingPlan();
  const d: Disruption[] = [{ type: 'overrun', targetId: 'practice', minutes: 45 }];
  const r = parallelFutures(plan, d);
  assert.equal(r.futures.length, 3);
  for (const f of r.futures) checkFuture(plan, d, f, f.strategy);

  const protect = get(r, 'protect_priorities');
  const keptIds = protect.items.filter((i) => i.status === 'kept').map((i) => i.id).sort();
  assert.deepEqual(keptIds, ['practice', 'rest']); // priority 4 and 5 keep their slots
  assert.deepEqual(protect.deferred.map((x) => x.id), ['study']); // the low-priority task is deferred, loudly
  assert.equal(protect.requiresConfirmation, true);

  const keepAll = get(r, 'maximize_completion');
  assert.equal(keepAll.deferred.length, 0);
  assert.equal(keepAll.metrics.placedCount, 4);

  const minimal = get(r, 'minimize_changes');
  assert.equal(minimal.deferred.length, 0);
  assert.equal(minimal.metrics.totalDisplacementMinutes, 195); // proven minimum for this day
  assert.ok(minimal.metrics.totalDisplacementMinutes <= keepAll.metrics.totalDisplacementMinutes);

  assert.equal(r.recommended, 'minimize_changes');
  assert.equal(r.doNothing!.survives, false); // doing nothing would miss the project deadline; the futures do not
});

test('no disruption: every future is a no-op (nothing moves, nothing deferred)', () => {
  const r = parallelFutures(landingPlan(), []);
  for (const f of r.futures) {
    assert.equal(f.metrics.movedCount, 0, f.strategy);
    assert.equal(f.deferred.length, 0, f.strategy);
  }
});

test('property: 300 random schedules x random disruptions x 3 strategies all satisfy every guarantee', () => {
  let feasible = 0;
  let infeasible = 0;
  let deferrals = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const plan = randomPlan(seed, { mobility: (['fixed', 'balanced', 'flexible'] as const)[seed % 3] });
    if (!plan) continue;
    const disruptions = generateScenario(plan, new Rng(seed * 7919), seed % 2 === 0 ? 'severe' : 'realistic');
    const r = parallelFutures(plan, disruptions);
    for (const f of r.futures) {
      checkFuture(plan, disruptions, f, `seed ${seed} ${f.strategy}`);
      if (f.feasible) feasible++;
      else infeasible++;
      deferrals += f.deferred.length;
    }
  }
  assert.ok(feasible > 300, `feasible ${feasible}`);
  assert.ok(infeasible >= 3, `the property test must also exercise infeasible days (saw ${infeasible})`);
  assert.ok(deferrals > 5, `and deferrals (saw ${deferrals})`);
});

test('"fixed" mobility keeps the original order and never moves a task earlier', () => {
  for (let seed = 400; seed < 460; seed++) {
    const plan = randomPlan(seed, { mobility: 'fixed' });
    if (!plan) continue;
    const d = generateScenario(plan, new Rng(seed), 'realistic');
    const r = parallelFutures(plan, d);
    for (const f of r.futures) {
      if (!f.feasible) continue;
      const tasks = f.items.filter((i) => i.status === 'kept' || i.status === 'moved');
      const byOrig = [...tasks].sort((a, b) => a.original!.start - b.original!.start);
      for (let i = 1; i < byOrig.length; i++) assert.ok(byOrig[i]!.start >= byOrig[i - 1]!.start, `seed ${seed}: order changed`);
      for (const t of tasks) assert.ok(t.movedByMinutes >= 0, `seed ${seed}: "${t.id}" moved earlier under fixed mobility`);
    }
  }
});

test('infeasible: a clear explanation, concrete suggestions, and no schedule changes', () => {
  const plan = mkPlan(
    [
      { id: 'essay', title: 'Essay', kind: 'task', duration: 120, start: at(15), deadline: at(17), priority: 5 },
      { id: 'lab', title: 'Lab report', kind: 'task', duration: 90, start: at(17), deadline: at(18, 30), priority: 5 },
    ],
    settings({ from: at(15), to: at(21), hours: ['15:00', '21:00'] }),
  );
  const snapshot = structuredClone(plan);
  const d: Disruption[] = [{ type: 'unexpected', start: at(16), duration: 45, title: 'Dentist' }];
  const r = parallelFutures(plan, d);
  assert.deepEqual(plan, snapshot);
  assert.equal(r.recommended, null);
  for (const f of r.futures) {
    assert.equal(f.feasible, false);
    const dg = f.diagnosis!;
    assert.ok(dg.conflictSet.includes('essay'));
    assert.ok(dg.reasons.length > 0 && dg.reasons[0]!.message.includes('Essay'));
    assert.ok(dg.suggestions.length > 0);
    assert.ok(dg.suggestions.every((s) => s.message.length > 10));
    assert.match(f.explanation[0]!, /untouched/);
  }
  const ext = r.futures[0]!.diagnosis!.suggestions.find((s) => s.action === 'extend_deadline' && s.itemId === 'essay');
  assert.ok(ext && ext.minutes! >= 1);
});

test('breaks are protected: never deferred, never moved out of their window', () => {
  const plan = mkPlan(
    [
      { id: 'a', title: 'Deep work', kind: 'task', duration: 180, start: at(9), priority: 4 },
      { id: 'lunch', title: 'Lunch', kind: 'break', duration: 45, start: at(12, 30), release: at(12), deadline: at(14), priority: 5 },
      { id: 'b', title: 'Emails', kind: 'task', duration: 60, start: at(13, 15), priority: 2 },
    ],
    settings(),
  );
  const d: Disruption[] = [{ type: 'overrun', targetId: 'a', minutes: 60 }];
  const r = parallelFutures(plan, d);
  for (const f of r.futures) {
    checkFuture(plan, d, f, f.strategy);
    const lunch = f.items.find((i) => i.id === 'lunch')!;
    assert.ok(lunch.start >= at(12) && lunch.end <= at(14));
    assert.ok(!f.deferred.some((x) => x.id === 'lunch'));
  }
});

test('futures and the cascade agree on what "survives" means', () => {
  // whenever the cascade survives with zero conflicts, the minimize-changes future must be a pure no-op or a subset of shifts
  for (let seed = 500; seed < 540; seed++) {
    const plan = randomPlan(seed);
    if (!plan) continue;
    const d = generateScenario(plan, new Rng(seed), 'mild');
    const sim = simulateCascade(plan, d);
    const f = get(parallelFutures(plan, d), 'minimize_changes');
    if (f.feasible && sim.conflicts.length === 0) assert.equal(f.deferred.length, 0);
  }
  assert.ok(STRATEGIES.length === 3);
});
