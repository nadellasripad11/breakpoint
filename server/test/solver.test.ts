import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Floater, Interval } from '../src/engine/index.ts';
import { Rng, improveByOrder, mergeIntervals, relaxPlacements, solveFloaters, weightByCount } from '../src/engine/index.ts';

const GRID = 15;

function mk(i: number, d: number, release: number, deadline: number, deferrable: boolean, priority = 3): Floater {
  return { id: `f${i}`, title: `f${i}`, kind: 'task', duration: d, release, deadline, origStart: release, priority: priority as 1 | 2 | 3 | 4 | 5, deferrable, critical: false };
}

/**
 * independent oracle: enumerate every start-time assignment on a coarse grid (no ordering heuristic, no dp).
 * returns the maximum number of tasks that can be placed while all non-deferrable ones are, or -1 if infeasible.
 */
function bruteForce(free: Interval[], floaters: Floater[]): number {
  const n = floaters.length;
  const slots = new Set<number>();
  for (const iv of free) for (let t = iv.start; t < iv.end; t += GRID) slots.add(t);
  const fits = (s: number, d: number) => {
    for (let t = s; t < s + d; t += GRID) if (!slots.has(t)) return false;
    return true;
  };
  let best = -1;
  const taken: Interval[] = [];
  const rec = (i: number, placed: number) => {
    if (i === n) {
      best = Math.max(best, placed);
      return;
    }
    const f = floaters[i]!;
    // option 1: place at any grid start
    for (let s = Math.ceil(f.release / GRID) * GRID; s + f.duration <= f.deadline; s += GRID) {
      if (!fits(s, f.duration)) continue;
      if (taken.some((t) => s < t.end && t.start < s + f.duration)) continue;
      taken.push({ start: s, end: s + f.duration });
      rec(i + 1, placed + 1);
      taken.pop();
    }
    // option 2: defer (only if allowed)
    if (f.deferrable) rec(i + 1, placed);
  };
  rec(0, 0);
  return best;
}

test('exact solver agrees with an independent brute-force oracle on 150 random instances', () => {
  const rng = new Rng(20261119);
  let feasibleSeen = 0;
  let infeasibleSeen = 0;
  for (let k = 0; k < 150; k++) {
    // free time: 1-3 gaps inside a 6h window, aligned to the grid
    const gaps: Interval[] = [];
    let cur = 0;
    for (let g = 0; g < rng.int(1, 3); g++) {
      cur += rng.int(0, 3) * GRID;
      const len = rng.int(2, 10) * GRID;
      gaps.push({ start: cur, end: cur + len });
      cur += len;
    }
    const free = mergeIntervals(gaps);
    const n = rng.int(1, 4);
    const floaters: Floater[] = [];
    for (let i = 0; i < n; i++) {
      const d = rng.int(1, 5) * GRID;
      const release = rng.int(0, 6) * GRID;
      const deadline = release + d + rng.int(0, 10) * GRID;
      floaters.push(mk(i, d, release, deadline, rng.next() < 0.5, rng.int(1, 5)));
    }
    const res = solveFloaters(free, floaters);
    const oracle = bruteForce(free, floaters);
    assert.equal(res.feasible, oracle >= 0, `feasibility mismatch (instance ${k})`);
    if (res.feasible) {
      feasibleSeen++;
      assert.equal(res.placed.size, oracle, `placed count mismatch (instance ${k})`);
      assert.equal(res.placed.size + res.deferred.length, n); // nothing vanishes
      for (const id of res.deferred) assert.ok(floaters.find((f) => f.id === id)!.deferrable); // only deferrable tasks are ever deferred
    } else {
      infeasibleSeen++;
      assert.ok(res.failed.length >= 0 && res.placed.size === 0);
    }
  }
  assert.ok(feasibleSeen > 30 && infeasibleSeen > 10, `instance mix too skewed: ${feasibleSeen}/${infeasibleSeen}`);
});

test('ordered mode keeps the original order', () => {
  const free = [{ start: 0, end: 600 }];
  const floaters = [mk(0, 60, 0, 600, false), mk(1, 60, 0, 600, false), mk(2, 60, 0, 600, false)];
  const res = solveFloaters(free, floaters, { ordered: true });
  assert.ok(res.feasible);
  assert.ok(res.placed.get('f0')! < res.placed.get('f1')! && res.placed.get('f1')! < res.placed.get('f2')!);
});

test('infeasible: reports which non-deferrable task cannot be placed, places nothing', () => {
  const res = solveFloaters([{ start: 0, end: 60 }], [mk(0, 90, 0, 600, false)]);
  assert.equal(res.feasible, false);
  assert.deepEqual(res.failed, ['f0']);
});

test('greedy fallback is flagged as not optimal and never violates constraints', () => {
  const free = [{ start: 0, end: 2000 }];
  const floaters = Array.from({ length: 24 }, (_, i) => mk(i, 30, 0, 2000, i % 2 === 0));
  const res = solveFloaters(free, floaters, { exactLimit: 10 });
  assert.equal(res.method, 'greedy');
  assert.equal(res.optimal, false);
  assert.ok(res.feasible);
  const starts = [...res.placed.values()].sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 30);
});

test('relaxPlacements never makes a plan worse and keeps it valid', () => {
  const free = [{ start: 0, end: 600 }];
  const placed = [
    { id: 'a', start: 0, duration: 60, release: 0, deadline: 600, origStart: 120 },
    { id: 'b', start: 60, duration: 60, release: 0, deadline: 600, origStart: 300 },
  ];
  const before = placed.reduce((s, p) => s + Math.abs(p.start - p.origStart), 0);
  const out = relaxPlacements(free, placed);
  const after = out.reduce((s, p) => s + Math.abs(p.start - p.origStart), 0);
  assert.ok(after <= before);
  assert.deepEqual(out.map((p) => p.start), [120, 300]);
  const imp = improveByOrder(free, placed, {});
  assert.ok(imp.reduce((s, p) => s + Math.abs(p.start - p.origStart), 0) <= after);
});
