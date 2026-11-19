import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Plan, Probe } from '../src/engine/index.ts';
import { buildWorld, cascadeBreakingPoint, conflictKey, freeTime, probeToDisruption, recoverBreakingPoint, simulateCascade, solveFloaters, weakLinkProfile } from '../src/engine/index.ts';
import { at, landingPlan, mkPlan, settings } from './helpers.ts';
import { randomPlan } from './random.ts';

test('landing page: Practice can run 30m over; at 31m Project misses its 8 PM deadline', () => {
  const bp = cascadeBreakingPoint(landingPlan(), { type: 'overrun', targetId: 'practice' });
  assert.equal(bp.status, 'breaks');
  assert.equal(bp.tolerableMinutes, 30);
  assert.equal(bp.breakingMinutes, 31);
  assert.ok('conflicts' in bp.failure!);
  assert.match(bp.explanation, /tolerates 30m/);
  assert.match(bp.explanation, /Project/);
  // and it is exactly right, checked directly against the simulator
  const plan = landingPlan();
  assert.equal(simulateCascade(plan, [{ type: 'overrun', targetId: 'practice', minutes: 30 }]).summary.survives, true);
  assert.equal(simulateCascade(plan, [{ type: 'overrun', targetId: 'practice', minutes: 31 }]).summary.survives, false);
});

test('losing time at the start of the day: same 30m tolerance', () => {
  const bp = cascadeBreakingPoint(landingPlan(), { type: 'lost_time' });
  assert.equal(bp.tolerableMinutes, 30);
});

test('cascade breaking point is the smallest minute that creates a NEW critical conflict (matches a brute-force scan)', () => {
  let checked = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const plan = randomPlan(seed);
    if (!plan) continue;
    const target = plan.items.find((i) => i.blocking)!;
    for (const probe of [{ type: 'overrun', targetId: target.id }, { type: 'lost_time' }] as Probe[]) {
      const bp = cascadeBreakingPoint(plan, probe, 300);
      const known = new Set(simulateCascade(plan, []).conflicts.filter((c) => c.severity === 'critical').map(conflictKey));
      let first: number | null = null;
      for (let m = 1; m <= 300; m++) {
        const s = simulateCascade(plan, [probeToDisruption(plan, probe, m)]);
        if (s.conflicts.some((c) => c.severity === 'critical' && !known.has(conflictKey(c)))) {
          first = m;
          break;
        }
      }
      assert.equal(bp.breakingMinutes, first, `seed ${seed} ${probe.type}`);
      checked++;
    }
  }
  assert.ok(checked > 60);
});

function linearFirstInfeasible(plan: Plan, probe: Probe, limit: number): number | null {
  for (let m = 1; m <= limit; m++) {
    const w = buildWorld(plan, [probeToDisruption(plan, probe, m)]);
    if (!solveFloaters(freeTime(w), w.floaters, { ordered: plan.settings.mobility === 'fixed' }).feasible) return m;
  }
  return null;
}

test('recover breaking point (binary search) equals an exhaustive minute-by-minute scan', () => {
  let checked = 0;
  for (let seed = 100; seed < 160; seed++) {
    const plan = randomPlan(seed, { mobility: seed % 3 === 0 ? 'fixed' : 'balanced' });
    if (!plan) continue;
    const flexible = plan.items.find((i) => i.blocking && !i.locked);
    if (!flexible) continue;
    for (const probe of [{ type: 'overrun', targetId: flexible.id }, { type: 'lost_time' }] as Probe[]) {
      const bp = recoverBreakingPoint(plan, probe, 240);
      if (bp.status === 'already_broken') continue;
      const lin = linearFirstInfeasible(plan, probe, 240);
      assert.equal(bp.breakingMinutes, lin, `seed ${seed} ${probe.type}`);
      checked++;
    }
  }
  assert.ok(checked > 40, `only ${checked} comparisons ran`);
});

test('re-planning tolerates more than doing nothing (it can only help)', () => {
  const plan = landingPlan();
  const probe: Probe = { type: 'overrun', targetId: 'practice' };
  const doNothing = cascadeBreakingPoint(plan, probe).tolerableMinutes!;
  const replan = recoverBreakingPoint(plan, probe).tolerableMinutes!;
  assert.ok(replan >= doNothing);
  assert.ok(replan > doNothing); // here by a lot: Study can be deferred, Project moved forward
});

test('already broken: a plan with no feasible schedule says so, with a diagnosis', () => {
  const plan = mkPlan([{ id: 'big', title: 'Thesis chapter', kind: 'task', duration: 420, start: at(9), deadline: at(12), priority: 5 }], settings());
  const bp = recoverBreakingPoint(plan, { type: 'lost_time' });
  assert.equal(bp.status, 'already_broken');
  assert.ok(bp.failure && 'diagnosis' in bp.failure && bp.failure.diagnosis.conflictSet.includes('big'));
});

test('withstands the limit: a nearly empty day never breaks', () => {
  const plan = mkPlan([{ id: 'a', title: 'Read', kind: 'task', duration: 30, start: at(10), priority: 2 }], settings());
  const bp = cascadeBreakingPoint(plan, { type: 'overrun', targetId: 'a' }, 120);
  assert.equal(bp.status, 'withstands_limit');
  assert.equal(bp.tolerableMinutes, 120);
  assert.equal(bp.breakingMinutes, null);
});

test('probe validation: delay/overrun need a target, unexpected needs a time', () => {
  const plan = landingPlan();
  assert.throws(() => cascadeBreakingPoint(plan, { type: 'overrun' }), /targetId/);
  assert.throws(() => cascadeBreakingPoint(plan, { type: 'unexpected' }), /at/);
});

test('weak-link profile ranks the least resilient items first', () => {
  const p = weakLinkProfile(landingPlan());
  assert.ok(p.weakest);
  assert.equal(p.minTolerance, 30);
  const tol = p.links.map((l) => Math.min(l.overrunTolerance ?? Infinity, l.delayTolerance ?? Infinity));
  assert.deepEqual(tol, [...tol].sort((a, b) => a - b));
});
