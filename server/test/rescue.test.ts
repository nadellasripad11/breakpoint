import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Disruption, Interval, Minutes, Plan } from '../src/engine/index.ts';
import { Rng, adoptRepair, bufferFor, buildWorld, freeTime, minDisplacementPlacement, rescueDay, simulateCascade } from '../src/engine/index.ts';
import { at, item, mkPlan, settings } from './helpers.ts';
import { randomPlan } from './random.ts';

/* ═══════════════════ the exact minimum-movement solver vs. brute force ═══════════════════ */

/** Tries every order and every integer start. Independent of the DP: plain recursion. */
function bruteMinMovement(free: Interval[], tasks: { id: string; duration: number; release: number; deadline: number; origStart: number }[], ordered: boolean): number | null {
  const sorted = [...tasks].sort((a, b) => a.origStart - b.origStart || a.id.localeCompare(b.id));
  let best: number | null = null;
  const fits = (s: number, d: number) => free.some((g) => s >= g.start && s + d <= g.end);
  const rec = (remaining: typeof sorted, cursor: number, cost: number) => {
    if (best !== null && cost >= best) return;
    if (remaining.length === 0) {
      best = cost;
      return;
    }
    const candidates = ordered ? [remaining[0]!] : remaining;
    for (const t of candidates) {
      for (let s = Math.max(cursor, t.release); s + t.duration <= t.deadline; s++) {
        if (!fits(s, t.duration)) continue;
        rec(remaining.filter((x) => x !== t), s + t.duration, cost + Math.abs(s - t.origStart));
      }
    }
  };
  rec(sorted, -Infinity, 0);
  return best;
}

test('minDisplacementPlacement is exactly minimal: 400 random small instances against brute force (free or fixed order)', () => {
  const rng = new Rng(2024);
  let feasible = 0;
  let infeasible = 0;
  for (let n = 0; n < 400; n++) {
    // a 50-minute world with 1-3 free gaps
    const gaps: Interval[] = [];
    let c = rng.int(0, 5);
    for (let g = 0; g < rng.int(1, 3); g++) {
      const len = rng.int(8, 25);
      gaps.push({ start: c, end: c + len });
      c += len + rng.int(2, 8);
    }
    const tasks = Array.from({ length: rng.int(1, 4) }, (_, i) => {
      const duration = rng.int(3, 12);
      const release = rng.int(0, 20);
      return { id: `t${i}`, duration, release, deadline: release + duration + rng.int(0, 30), origStart: rng.int(0, 40) };
    });
    const ordered = rng.next() < 0.3;
    const expected = bruteMinMovement(gaps, tasks, ordered);
    const got = minDisplacementPlacement(gaps, tasks, { ordered });
    if (expected === null) {
      assert.equal(got, null, `case ${n}: brute force finds no placement but the solver returned one`);
      infeasible++;
    } else {
      assert.ok(got, `case ${n}: brute force finds a placement (cost ${expected}) but the solver returned none`);
      assert.equal(got.cost, expected, `case ${n}: solver cost ${got.cost} vs brute force ${expected}`);
      assert.equal(got.exact, true);
      // and the returned placement really is valid and really has that cost
      let total = 0;
      const iv: Interval[] = [];
      for (const t of tasks) {
        const s: number = got.placed.get(t.id)!;
        assert.ok(s >= t.release && s + t.duration <= t.deadline, 'inside its own window');
        assert.ok(gaps.some((g) => s >= g.start && s + t.duration <= g.end), 'inside a free gap');
        iv.push({ start: s, end: s + t.duration });
        total += Math.abs(s - t.origStart);
      }
      assert.equal(total, expected);
      iv.sort((a, b) => a.start - b.start);
      for (let i = 1; i < iv.length; i++) assert.ok(iv[i]!.start >= iv[i - 1]!.end, 'no overlap');
      feasible++;
    }
  }
  assert.ok(feasible > 150 && infeasible > 20, `the sample must exercise both outcomes (feasible ${feasible}, infeasible ${infeasible})`);
});

/* ═══════════════════ "smallest feasible changes": rescue vs. an exhaustive search of the whole day ═══════════════════ */

test('rescue finds the smallest change: 120 random tiny days against exhaustive search (fewest items moved, then fewest minutes)', () => {
  const rng = new Rng(77);
  let compared = 0;
  let broken = 0;
  for (let n = 0; n < 400 && compared < 120; n++) {
    // a 100-minute day, flexible mobility, a locked event in the middle, 2-3 flexible tasks laid out back to back
    const day0 = at(10);
    const T = (m: number) => day0 + m;
    const s = settings({ from: T(0), to: T(100), hours: ['00:00', '23:59'], mobility: 'flexible' });
    const lockStart = rng.int(40, 60);
    const lockDur = rng.int(6, 14);
    const items: Parameters<typeof mkPlan>[0] = [{ id: 'lock', kind: 'event', duration: lockDur, start: T(lockStart), locked: true, priority: 4 }];
    let cur = rng.int(0, 4);
    const count = rng.int(2, 3);
    for (let i = 0; i < count; i++) {
      const dur = rng.int(6, 14);
      if (cur + dur > lockStart && cur < lockStart + lockDur) cur = lockStart + lockDur + rng.int(0, 3);
      if (cur + dur > 98) break;
      items.push({ id: `t${i}`, duration: dur, start: T(cur), priority: 4, deferrable: false, deadline: T(Math.min(100, cur + dur + rng.int(2, 25))) });
      cur += dur + rng.int(0, 4);
    }
    if (items.length < 3) continue;
    const plan = mkPlan(items, s);
    const target = items[1 + rng.int(0, items.length - 2)]!;
    const disruption: Disruption = rng.next() < 0.7 ? { type: 'overrun', targetId: target.id, minutes: rng.int(4, 18) } : { type: 'unexpected', start: T(rng.int(10, 70)), duration: rng.int(5, 12), priority: 5 };
    const r = rescueDay(plan, [disruption]);
    const world = buildWorld(plan, [disruption]);
    const free = freeTime(world);
    const floaters = world.floaters;

    // exhaustive: every ordered selection of start minutes for ALL tasks (no task may be deferred: none is deferrable)
    let best: { moved: number; total: number } | null = null;
    const fits = (st: number, d: number) => free.some((g) => st >= g.start && st + d <= g.end);
    const rec = (idx: number, placed: { s: number; e: number }[], moved: number, total: number) => {
      if (idx === floaters.length) {
        if (!best || moved < best.moved || (moved === best.moved && total < best.total)) best = { moved, total };
        return;
      }
      const f = floaters[idx]!;
      for (let st = f.release; st + f.duration <= f.deadline; st++) {
        if (!fits(st, f.duration)) continue;
        if (placed.some((p) => st < p.e && st + f.duration > p.s)) continue;
        const d = Math.abs(st - f.origStart);
        rec(idx + 1, [...placed, { s: st, e: st + f.duration }], moved + (d === 0 ? 0 : 1), total + d);
      }
    };
    rec(0, [], 0, 0);

    if (best === null) {
      assert.equal(r.status, 'impossible', `case ${n}: exhaustive search finds no valid day, so rescue must say so`);
      assert.equal(r.lanes.repaired, null);
      broken++;
      continue;
    }
    assert.notEqual(r.status, 'impossible', `case ${n}: a valid day exists but rescue claimed none`);
    assert.equal(r.deferred.length, 0);
    const b = best as { moved: number; total: number };
    assert.equal(r.metrics.moved, b.moved, `case ${n}: moved ${r.metrics.moved} vs optimum ${b.moved}`);
    assert.equal(r.metrics.totalMinutes, b.total, `case ${n}: minutes ${r.metrics.totalMinutes} vs optimum ${b.total}`);
    assert.equal(r.optimal, true);
    compared++;
  }
  assert.ok(compared >= 120, `compared ${compared}`);
  assert.ok(broken >= 3, `the sample should include genuinely impossible days (${broken})`);
});

/* ═══════════════════ impossible schedules ═══════════════════ */

test('impossible: more required work than free time -> no schedule, exact shortfall, nothing changed, Pip says why', () => {
  // 3 PM to 9 PM; a locked 4-hour block leaves 2 hours free. The essay (2h, due 9) and the report (1h, due 9) need 3 hours.
  const plan = mkPlan(
    [
      { id: 'class', kind: 'event', title: 'Evening class', duration: 240, start: at(17), locked: true, priority: 4 },
      { id: 'essay', title: 'Essay', duration: 120, start: at(15), priority: 5, deadline: at(21) },
      { id: 'report', title: 'Report', duration: 60, start: at(16), priority: 4, deadline: at(21) },
    ],
    settings({ from: at(15), to: at(21), hours: ['15:00', '21:00'] }),
  );
  const before = JSON.stringify(plan);
  const r = rescueDay(plan, [{ type: 'delay', targetId: 'essay', minutes: 30 }]);
  assert.equal(JSON.stringify(plan), before, 'the input schedule is never modified');
  assert.equal(r.status, 'impossible');
  assert.equal(r.lanes.repaired, null);
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.guarantees, []);
  assert.ok(r.diagnosis);
  const hall = r.diagnosis.reasons.find((x) => x.code === 'not_enough_time');
  assert.ok(hall, 'names the cause');
  assert.equal(hall.shortfallMinutes, 60, 'needs 180 minutes, only 120 are free: short by exactly 60');
  assert.ok(r.diagnosis.suggestions.length > 0, 'offers concrete ways out');
  const text = r.pip.map((l) => l.text).join(' ');
  assert.match(text, /No valid schedule exists/);
  assert.match(text, /short by 1h/);
  assert.match(text, /untouched/);
  // the disrupted lane still shows what would happen if nothing is done
  assert.ok(r.conflicts.length > 0);
});

test('impossible: a task that cannot fit anywhere before its deadline, however the rest is arranged', () => {
  const plan = mkPlan(
    [
      { id: 'meeting', kind: 'event', duration: 60, start: at(15), locked: true, priority: 4 },
      { id: 'proposal', title: 'Proposal', duration: 90, start: at(16), priority: 5, deadline: at(17, 15) },
    ],
    settings({ from: at(15), to: at(21), hours: ['15:00', '21:00'] }),
  );
  // a locked 45-minute surprise at 4:00 leaves only 15 minutes before the 5:15 deadline
  const r = rescueDay(plan, [{ type: 'unexpected', start: at(16), duration: 45, title: 'Fire drill', priority: 5 }]);
  assert.equal(r.status, 'impossible');
  assert.ok(r.diagnosis!.reasons.some((x) => x.itemIds.includes('proposal')));
  assert.ok(r.pip.some((l) => l.kind === 'impossible' && /Proposal/.test(l.text)));
});

/* ═══════════════════ overlapping deadlines ═══════════════════ */

test('overlapping deadlines that cannot all be met: says so with the exact shortfall instead of missing one silently', () => {
  // three tasks must all finish by 5 PM; together they need 150 minutes but only 120 are free before then
  const plan = mkPlan(
    [
      { id: 'a', title: 'Lab report', duration: 60, start: at(15), priority: 5, deadline: at(17) },
      { id: 'b', title: 'Problem set', duration: 50, start: at(16), priority: 4, deadline: at(17) },
      { id: 'c', title: 'Slides', duration: 40, start: at(16, 50), priority: 4, deadline: at(17) },
    ],
    settings({ from: at(15), to: at(19), hours: ['15:00', '19:00'] }),
  );
  const r = rescueDay(plan, [{ type: 'lost_time', minutes: 30, start: at(15) }]);
  assert.equal(r.status, 'impossible');
  const hall = r.diagnosis!.reasons.find((x) => x.code === 'not_enough_time')!;
  assert.deepEqual([...hall.itemIds].sort(), ['a', 'b', 'c']);
  assert.equal(hall.shortfallMinutes, 60); // 150 needed, 90 free
});

test('overlapping deadlines that CAN all be met: the repair satisfies every one of them (earliest-deadline order)', () => {
  // the long task has the later deadline and sits first in the plan; the short one is urgent
  const plan = mkPlan(
    [
      { id: 'long', title: 'Long reading', duration: 90, start: at(15), priority: 3, deadline: at(18) },
      { id: 'urgent', title: 'Urgent form', duration: 20, start: at(16, 30), priority: 3, deadline: at(16, 45) },
      { id: 'mid', title: 'Mid task', duration: 40, start: at(17), priority: 3, deadline: at(18, 30) },
    ],
    settings({ from: at(15), to: at(20), hours: ['15:00', '20:00'], mobility: 'flexible' }),
  );
  const r = rescueDay(plan, [{ type: 'delay', targetId: 'urgent', minutes: 0 + 5 }]);
  // the urgent form was already due at 4:45; delaying it makes it impossible to keep its slot and deadline unless others yield
  assert.notEqual(r.status, 'impossible');
  const repaired = r.lanes.repaired!;
  for (const b of repaired.blocks) if (b.deadline !== null) assert.ok(b.end <= b.deadline, `${b.title} ends ${b.end} <= ${b.deadline}`);
  assert.ok(r.guarantees.every((g) => g.ok), JSON.stringify(r.guarantees));
});

test('two disruptions on overlapping deadlines: the repair reorders the day so both deadlines are still met', () => {
  // the task with the EARLIER deadline sits after the one with the later deadline
  const plan = mkPlan(
    [
      { id: 'p', title: 'Project', duration: 60, start: at(15), priority: 4, deadline: at(18) },
      { id: 'q', title: 'Quiz prep', duration: 45, start: at(16), priority: 4, deadline: at(17) },
      { id: 'r', title: 'Reading', duration: 30, start: at(17, 30), priority: 2, deferrable: true },
    ],
    settings({ from: at(15), to: at(20), hours: ['15:00', '20:00'], mobility: 'flexible' }),
  );
  const r = rescueDay(plan, [{ type: 'overrun', targetId: 'p', minutes: 30 }, { type: 'overrun', targetId: 'q', minutes: 10 }]);
  assert.ok(r.conflicts.some((c) => c.code === 'deadline_missed' && c.itemId === 'q'), 'carrying on would really miss the quiz deadline');
  assert.notEqual(r.status, 'impossible');
  const by = new Map(r.lanes.repaired!.blocks.map((b) => [b.id, b]));
  assert.ok(by.get('p')!.end <= at(18), 'project deadline met');
  assert.ok(by.get('q')!.end <= at(17), 'quiz deadline met');
  assert.ok(by.get('q')!.start < by.get('p')!.start, 'the urgent task now goes first');
  assert.ok(r.guarantees.every((g) => g.ok));
});

/* ═══════════════════ protected commitments ═══════════════════ */

test('locked events never move, and a flexible task is never placed on top of one', () => {
  const plan = mkPlan(
    [
      { id: 'lecture', kind: 'event', title: 'Lecture', duration: 60, start: at(15), locked: true, priority: 4 },
      { id: 'work', title: 'Work', duration: 60, start: at(16), priority: 4, deadline: at(19) },
      { id: 'dinner', kind: 'event', title: 'Dinner', duration: 60, start: at(18), locked: true, priority: 5, critical: true },
    ],
    settings({ from: at(15), to: at(21), hours: ['15:00', '21:00'] }),
  );
  const r = rescueDay(plan, [{ type: 'overrun', targetId: 'work', minutes: 45 }]);
  const by = new Map(r.lanes.repaired!.blocks.map((b) => [b.id, b]));
  assert.deepEqual([by.get('lecture')!.start, by.get('lecture')!.end], [at(15), at(16)]);
  assert.deepEqual([by.get('dinner')!.start, by.get('dinner')!.end], [at(18), at(19)]);
  const w = by.get('work')!;
  assert.ok(w.end <= at(18) || w.start >= at(19), 'work is not on top of dinner');
  assert.ok(r.guarantees.find((g) => g.key === 'locked_unmoved')!.ok);
});

test('two locked events that collide cannot be fixed by shuffling: reported, never "solved" by moving a lock', () => {
  const plan = mkPlan(
    [
      { id: 'a', kind: 'event', title: 'Interview', duration: 60, start: at(15), locked: true, priority: 5, critical: true },
      { id: 'b', kind: 'event', title: 'Dentist', duration: 60, start: at(17), locked: true, priority: 4 },
      { id: 'w', title: 'Work', duration: 30, start: at(16), priority: 3 },
    ],
    settings({ from: at(15), to: at(21), hours: ['15:00', '21:00'] }),
  );
  const r = rescueDay(plan, [{ type: 'delay', targetId: 'a', minutes: 90 }]);
  // the delayed interview now overlaps the dentist; both are locked
  assert.ok(r.conflicts.some((c) => c.code === 'locked_overlap'));
  const c = r.conflicts.find((x) => x.code === 'locked_overlap')!;
  assert.match(c.detail, /Neither can move/);
  const by = new Map((r.lanes.repaired?.blocks ?? []).map((b) => [b.id, b]));
  if (r.lanes.repaired) assert.equal(by.get('b')!.start, at(17), 'the dentist did not move');
});

test('a protected break stays inside its window and is never deferred, even when that costs a task its slot', () => {
  const plan = mkPlan(
    [
      { id: 'proj', title: 'Project', duration: 90, start: at(10), priority: 4, deadline: at(15) },
      { id: 'lunch', title: 'Lunch', kind: 'break', duration: 45, start: at(12), priority: 5, release: at(12), deadline: at(13, 30) },
      { id: 'read', title: 'Reading', duration: 60, start: at(13), priority: 2, deferrable: true },
    ],
    settings({ from: at(9), to: at(17), hours: ['09:00', '17:00'], mobility: 'flexible' }),
  );
  const r = rescueDay(plan, [{ type: 'overrun', targetId: 'proj', minutes: 80 }]);
  assert.ok(r.lanes.repaired);
  const lunch = r.lanes.repaired!.blocks.find((b) => b.id === 'lunch')!;
  assert.ok(lunch.start >= at(12) && lunch.end <= at(13, 30), `lunch ${lunch.start}-${lunch.end} stays in its 12:00-1:30 window`);
  assert.equal(lunch.end - lunch.start, 45, 'and is not shortened');
  assert.ok(!r.deferred.some((d) => d.id === 'lunch'));
  assert.ok(r.guarantees.find((g) => g.key === 'breaks_protected')!.ok);
});

test('a protected break is never sacrificed to make the numbers work: if it is the only way, the day is reported impossible', () => {
  // the only 45 minutes free inside the 12:00-1:00 window are taken by a locked surprise
  const plan = mkPlan(
    [
      { id: 'lunch', title: 'Lunch', kind: 'break', duration: 45, start: at(12), priority: 5, release: at(12), deadline: at(13) },
      { id: 'task', title: 'Task', duration: 30, start: at(14), priority: 3, deferrable: true },
    ],
    settings({ from: at(9), to: at(17), hours: ['09:00', '17:00'] }),
  );
  const r = rescueDay(plan, [{ type: 'unexpected', start: at(12, 10), duration: 40, title: 'Surprise call', priority: 5 }]);
  assert.equal(r.status, 'impossible');
  assert.ok(r.diagnosis!.reasons.some((x) => x.itemIds.includes('lunch')));
  assert.ok(r.pip.some((l) => /Lunch/.test(l.text)));
});

test('property: 300 random days x random disruptions: whenever a repair exists, every guarantee is re-verified true and nothing locked moved', () => {
  const rng = new Rng(9);
  let checked = 0;
  let repairedCount = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const plan = randomPlan(seed);
    if (!plan) continue;
    const tasks = plan.items.filter((i) => !i.locked && i.blocking);
    if (tasks.length === 0) continue;
    const t = rng.pick(tasks);
    const d: Disruption[] = [{ type: rng.pick(['overrun', 'delay'] as const), targetId: t.id, minutes: rng.pick([15, 30, 45, 90]) }];
    const r = rescueDay(plan, d);
    checked++;
    if (r.status === 'impossible') {
      assert.equal(r.lanes.repaired, null);
      assert.ok(r.diagnosis);
      continue;
    }
    repairedCount++;
    for (const g of r.guarantees) assert.ok(g.ok, `seed ${seed}: ${g.key} failed (${g.detail})`);
    const rep = new Map(r.lanes.repaired!.blocks.map((b) => [b.id, b]));
    for (const it of plan.items) if (it.locked && it.blocking) assert.equal(rep.get(it.id)!.start, it.start, `seed ${seed}: locked "${it.id}" moved`);
    // moved + kept + deferred accounts for every flexible item
    const flexible = plan.items.filter((i) => !i.locked && i.blocking).length;
    assert.equal(r.metrics.moved + r.metrics.kept + r.metrics.deferred, flexible, `seed ${seed}: an item went missing`);
  }
  assert.ok(checked > 200 && repairedCount > 100, `checked ${checked}, repaired ${repairedCount}`);
});

/* ═══════════════════ Pip explains why: sentences come from computed numbers ═══════════════════ */

test('Pip: "ran 45 minutes long but you only had 25 minutes of buffer, so we need another 20" comes from the simulation', () => {
  // Project 4:00-5:00; a locked dinner at 5:25 means exactly 25 minutes of room
  const plan = mkPlan(
    [
      { id: 'project', title: 'Project', duration: 60, start: at(16), priority: 4, deadline: at(21) },
      { id: 'dinner', kind: 'event', title: 'Dinner', duration: 60, start: at(17, 25), locked: true, priority: 5, critical: true },
      { id: 'wrap', title: 'Wrap-up', duration: 30, start: at(18, 30), priority: 3 },
    ],
    settings({ from: at(15), to: at(21), hours: ['15:00', '21:00'] }),
  );
  const b = bufferFor(plan, { type: 'overrun', targetId: 'project', minutes: 45 });
  // a flexible task pauses around a locked event rather than conflicting, so the real wall is later: compute it, don't assume it
  const scan = (() => {
    let m = 0;
    while (simulateCascade(plan, [{ type: 'overrun', targetId: 'project', minutes: m + 1 }]).conflicts.length === 0 && m < 480) m++;
    return m;
  })();
  assert.equal(b.minutes, scan, 'buffer equals a minute-by-minute scan of the cascade');

  const r = rescueDay(plan, [{ type: 'overrun', targetId: 'project', minutes: 45 }]);
  const line = r.pip.find((l) => l.kind === 'shortfall' || l.kind === 'buffer')!;
  assert.equal(line.facts.minutes, 45);
  assert.equal(line.facts.buffer, scan);
  if (line.kind === 'shortfall') assert.equal(line.facts.shortfall, 45 - scan, 'shortfall = disruption minus buffer, exactly');
});

test('Pip: the exact example, with a deadline wall: 45 minutes long, 25 minutes of buffer, another 20 minutes to find', () => {
  // Project 4:00-5:00, due 5:25: exactly 25 minutes of buffer
  const plan = mkPlan(
    [
      { id: 'project', title: 'project', duration: 60, start: at(16), priority: 4, deadline: at(17, 25) },
      { id: 'gym', title: 'Gym', duration: 45, start: at(17, 10), priority: 2, deferrable: true },
    ],
    settings({ from: at(15), to: at(21), hours: ['15:00', '21:00'], mobility: 'flexible' }),
  );
  const r = rescueDay(plan, [{ type: 'overrun', targetId: 'project', minutes: 45 }]);
  const line = r.pip.find((l) => l.kind === 'shortfall')!;
  assert.equal(line.facts.buffer, 25);
  assert.equal(line.facts.shortfall, 20);
  assert.match(line.text, /Your project ran 45 minutes long, but you had only 25 minutes of buffer/);
  assert.match(line.text, /We need to find another 20 minutes\./);
});

test('Pip: every number in every sentence appears in the computed result (no invented figures)', () => {
  for (const seed of [3, 11, 25, 40, 77]) {
    const plan = randomPlan(seed);
    if (!plan) continue;
    const t = plan.items.find((i) => !i.locked && i.blocking);
    if (!t) continue;
    const r = rescueDay(plan, [{ type: 'overrun', targetId: t.id, minutes: 40 }]);
    for (const l of r.pip) {
      for (const [k, v] of Object.entries(l.facts)) {
        if (typeof v !== 'number') continue;
        if (k === 'minutes') assert.equal(v, 40);
        if (k === 'moved') assert.equal(v, r.changes.length);
        if (k === 'totalMinutes') assert.equal(v, r.metrics.totalMinutes);
        if (k === 'delta') assert.ok(r.changes.some((c) => c.deltaMinutes === v));
        if (k === 'conflicts') assert.equal(v, r.conflicts.length);
      }
    }
  }
});

test('rescue is deterministic: the same day and disruption always give the same answer', () => {
  const plan = randomPlan(5)!;
  const t = plan.items.find((i) => !i.locked && i.blocking)!;
  const d: Disruption[] = [{ type: 'overrun', targetId: t.id, minutes: 30 }];
  assert.deepEqual(rescueDay(plan, d), rescueDay(plan, d));
});

test('replay: starts at the original, ends at the repaired day, and every frame places only known blocks', () => {
  const plan = randomPlan(8)!;
  const t = plan.items.find((i) => !i.locked && i.blocking)!;
  const r = rescueDay(plan, [{ type: 'overrun', targetId: t.id, minutes: 60 }]);
  assert.equal(r.replay[0]!.phase, 'original');
  if (r.lanes.repaired) {
    const last = r.replay[r.replay.length - 1]!;
    assert.equal(last.phase, 'done');
    assert.deepEqual(last.blocks.map((b) => [b.id, b.start, b.end]), r.lanes.repaired.blocks.map((b) => [b.id, b.start, b.end]));
  }
  const ids = new Set(r.replay.flatMap((f) => f.blocks.map((b) => b.id)));
  for (const id of ids) assert.ok(r.lanes.original.blocks.some((b) => b.id === id) || r.lanes.disrupted.blocks.some((b) => b.id === id), `frame block ${id} exists`);
});

export type { Plan, Minutes };
void item;

/* ═══════════════════ three ways forward + "test it again" ═══════════════════ */

test('options: all three strategies come back, the top-level repair is the smallest one, and each option passes every rule', () => {
  let checked = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const plan = randomPlan(seed);
    if (!plan) continue;
    const t = plan.items.find((i) => !i.locked && i.blocking);
    if (!t) continue;
    const r = rescueDay(plan, [{ type: 'overrun', targetId: t.id, minutes: 45 }]);
    assert.deepEqual(r.options.map((o) => o.strategy).sort(), ['maximize_completion', 'minimize_changes', 'protect_priorities']);
    const smallest = r.options.find((o) => o.strategy === 'minimize_changes')!;
    assert.equal(r.strategy, 'minimize_changes');
    if (r.status === 'impossible') {
      assert.ok(r.options.every((o) => !o.feasible && o.view === null && o.note.length > 0));
      continue;
    }
    assert.deepEqual(smallest.view!.lane, r.lanes.repaired);
    assert.deepEqual(smallest.view!.changes, r.changes);
    for (const o of r.options.filter((x) => x.feasible)) {
      checked++;
      assert.ok(o.view, `seed ${seed}: ${o.strategy} has a view`);
      for (const g of o.view!.guarantees) assert.ok(g.ok, `seed ${seed}: ${o.strategy} broke "${g.key}" (${g.detail})`);
      assert.equal(o.view!.replay[o.view!.replay.length - 1]!.phase, 'done');
      // the smallest repair never moves more than another way forward that also defers nothing
      if (o.view!.deferred.length === 0 && smallest.view!.deferred.length === 0) assert.ok(smallest.view!.metrics.moved <= o.view!.metrics.moved, `seed ${seed}: ${o.strategy} moved fewer than "minimize changes"`);
    }
    assert.equal(r.options.filter((o) => o.recommended).length <= 1, true);
    // "same as" is honest: it points at an earlier option whose repaired day is identical
    for (const o of r.options) {
      if (!o.sameAs) continue;
      const twin = r.options.find((x) => x.strategy === o.sameAs)!;
      assert.deepEqual(o.view!.lane.blocks.map((b) => [b.id, b.start, b.end]), twin.view!.lane.blocks.map((b) => [b.id, b.start, b.end]));
    }
  }
  assert.ok(checked > 150, `checked ${checked} options`);
});

test('adoptRepair: the repaired day becomes a plan that has no conflicts left, locked events stay put, nothing is lost', () => {
  let adopted = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const plan = randomPlan(seed);
    if (!plan) continue;
    const t = plan.items.find((i) => !i.locked && i.blocking);
    if (!t) continue;
    const d: Disruption[] = [{ type: 'overrun', targetId: t.id, minutes: 30 }];
    const r = rescueDay(plan, d);
    for (const strategy of ['minimize_changes', 'protect_priorities', 'maximize_completion'] as const) {
      const next = adoptRepair(plan, d, strategy);
      const o = r.options.find((x) => x.strategy === strategy)!;
      if (!o.feasible) { assert.equal(next, null); continue; }
      assert.ok(next);
      adopted++;
      // the input plan was not touched
      assert.equal(plan.items.find((i) => i.id === t.id)!.duration, t.duration);
      // every locked item is where it was
      for (const it of plan.items) if (it.locked && it.blocking) assert.equal(next!.items.find((x) => x.id === it.id)!.start, it.start);
      // the adopted plan simulates clean: nothing overlaps and no deadline is missed with no further disruption
      const sim = simulateCascade(next!, []);
      assert.equal(sim.conflicts.length, 0, `seed ${seed} ${strategy}: ${sim.conflicts.map((c) => c.message).join(' | ')}`);
      // same blocks as the option's repaired lane
      const lane = new Map(o.view!.lane.blocks.map((b) => [b.id, `${b.start}:${b.end}`]));
      for (const it of next!.items) if (it.blocking && it.start !== undefined) assert.equal(lane.get(it.id), `${it.start}:${it.start + it.duration}`, `seed ${seed} ${strategy}: ${it.id}`);
    }
  }
  assert.ok(adopted > 150, `adopted ${adopted}`);
});
