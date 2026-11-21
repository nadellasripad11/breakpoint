import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Attempt, Disruption } from '../src/engine/index.ts';
import { Rng, buildWorld, checkAttempt, freeTime, judgeAttempt, makeChallenge, rescueDay, simulateCascade, solveFloaters, validatePlacements, baselineIssues, bufferFor } from '../src/engine/index.ts';
import { client, makeApp } from './apiHelpers.ts';

/** breakpoint's own answer, turned into the shape a visitor submits. */
function engineAttempt(c: ReturnType<typeof makeChallenge>, disruptions: Disruption[] = c.suggested): Attempt {
  const r = rescueDay(c.plan, disruptions);
  assert.ok(r.lanes.repaired, 'the day can be saved');
  const placements: Record<string, number> = {};
  for (const b of r.lanes.repaired.blocks) if (!b.locked && !b.injected) placements[b.id] = b.start;
  return { disruptions, placements, deferred: r.deferred.map((d) => d.id) };
}

const lexCost = (m: { deferred: number; moved: number; totalMinutes: number }) => [m.deferred, m.moved, m.totalMinutes];
const lexLess = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  return false;
};

/* ═══════════════════ the generator ═══════════════════ */

test('challenges: 120 seeds, each deterministic, valid, genuinely fragile, genuinely breakable and genuinely repairable', () => {
  const signatures = new Set<string>();
  let attempts = 0;
  for (let seed = 0; seed < 120; seed++) {
    const c = makeChallenge(seed);
    assert.deepEqual(c, makeChallenge(seed), `seed ${seed} is deterministic`);
    attempts += c.attempt + 1;
    signatures.add(JSON.stringify(c.plan.items.map((i) => [i.id, i.start, i.duration, i.deadline ?? 0])) + JSON.stringify(c.suggested));

    assert.deepEqual(baselineIssues(c.plan), [], `seed ${seed}: the starting day is valid`);
    const sim = simulateCascade(c.plan, c.suggested);
    assert.ok(sim.conflicts.some((x) => x.severity !== 'minor'), `seed ${seed}: carrying on really breaks the day`);
    const d = c.suggested[0]!;
    if (d.type === 'overrun') assert.ok(bufferFor(c.plan, d).minutes < d.minutes, `seed ${seed}: the day was fragile (buffer smaller than the disruption)`);

    const r = rescueDay(c.plan, c.suggested);
    assert.equal(r.status, 'repaired', `seed ${seed}`);
    assert.ok(r.changes.length >= 1 && r.changes.length <= 4, `seed ${seed}: a visible but modest fix (${r.changes.length})`);
    assert.ok(r.guarantees.every((g) => g.ok), `seed ${seed}: ${JSON.stringify(r.guarantees.filter((g) => !g.ok))}`);
    assert.equal(r.optimal, true);
    // the day always contains each protected thing the judge is going to test
    assert.ok(c.plan.items.some((i) => i.kind === 'break'), 'a protected break');
    assert.ok(c.plan.items.filter((i) => i.locked).length >= 2, 'locked events');
    assert.ok(c.plan.items.filter((i) => i.deadline !== undefined && i.kind !== 'break').length >= 2, 'hard deadlines');
  }
  assert.ok(signatures.size >= 40, `the seeds produce different days (${signatures.size} distinct of 120)`);
  assert.ok(attempts / 120 < 6, `generation is cheap: ${(attempts / 120).toFixed(1)} tries per seed on average`);
});

/* ═══════════════════ the judge ═══════════════════ */

test('judge: Breakpoint\'s own fix is valid, matches itself, and scores 100', () => {
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const c = makeChallenge(seed);
    const rep = judgeAttempt(c.plan, engineAttempt(c));
    assert.equal(rep.valid, true, `seed ${seed}: ${JSON.stringify(rep.violations)}`);
    assert.equal(rep.verdict, 'matched');
    assert.equal(rep.score, 100);
    assert.equal(rep.yours!.moved, rep.breakpoint!.moved);
    assert.equal(rep.yours!.totalMinutes, rep.breakpoint!.totalMinutes);
  }
});

test('judge: "just carry on" is rejected with the exact minutes the deadline is missed by', () => {
  for (const seed of [0, 1, 2, 3, 4, 5]) {
    const c = makeChallenge(seed);
    const sim = simulateCascade(c.plan, c.suggested);
    const placements: Record<string, number> = {};
    for (const o of sim.outcomes) if (!o.locked && !o.injected && c.plan.items.find((i) => i.id === o.id)?.blocking) placements[o.id] = o.simulated.start;
    const rep = judgeAttempt(c.plan, { disruptions: c.suggested, placements, deferred: [] });
    assert.equal(rep.valid, false);
    assert.equal(rep.verdict, 'invalid');
    const missed = sim.conflicts.filter((x) => x.code === 'deadline_missed');
    assert.ok(missed.length > 0);
    let compared = 0;
    for (const m of missed) {
      const o = sim.outcomes.find((x) => x.id === m.itemId)!;
      if (o.fragments.length !== 1) {
        // the simulation pauses this task around a locked block; a single slot cannot show that, so it fails another rule instead
        assert.ok(rep.violations.some((x) => x.itemId === m.itemId));
        continue;
      }
      const v = rep.violations.find((x) => x.code === 'deadline' && x.itemId === m.itemId);
      assert.ok(v, `seed ${seed}: the violation for ${m.itemId} is reported`);
      assert.equal(v.minutes, m.minutes, 'same number of minutes as the cascade simulation');
      compared++;
    }
    assert.ok(compared > 0 || missed.some((m) => sim.outcomes.find((x) => x.id === m.itemId)!.fragments.length > 1));
  }
});

test('judge: cheating is caught: moving a lock, deferring a hard deadline, silently dropping a task, breaking the lunch window', () => {
  const c = makeChallenge(3);
  const good = engineAttempt(c);

  const lock = judgeAttempt(c.plan, { ...good, placements: { ...good.placements, lecture: good.placements.project! } });
  assert.ok(lock.violations.some((v) => v.code === 'locked_moved' && v.itemId === 'lecture'));

  const deferDeadline = judgeAttempt(c.plan, { ...good, placements: Object.fromEntries(Object.entries(good.placements).filter(([k]) => k !== 'essay')), deferred: [...good.deferred, 'essay'] });
  assert.ok(deferDeadline.violations.some((v) => v.code === 'not_deferrable' && v.itemId === 'essay'));

  const drop = judgeAttempt(c.plan, { ...good, placements: Object.fromEntries(Object.entries(good.placements).filter(([k]) => k !== 'gym')), deferred: good.deferred.filter((d) => d !== 'gym') });
  assert.ok(drop.violations.some((v) => v.code === 'unplaced' && v.itemId === 'gym'), 'nothing may silently disappear');

  const lunchLate = judgeAttempt(c.plan, { ...good, placements: { ...good.placements, lunch: good.placements.lunch! + 240 } });
  assert.ok(lunchLate.violations.some((v) => v.code === 'break_window' && v.itemId === 'lunch'));

  const onLocked = judgeAttempt(c.plan, { ...good, placements: { ...good.placements, gym: c.plan.items.find((i) => i.id === 'choir')!.start! } });
  assert.ok(onLocked.violations.some((v) => v.code === 'overlap_locked' && v.otherId === 'choir'));

  const afterHours = judgeAttempt(c.plan, { ...good, placements: { ...good.placements, email: c.plan.items.find((i) => i.id === 'email')!.start! + 400 } });
  assert.ok(afterHours.violations.some((v) => v.code === 'outside_hours' && v.itemId === 'email'));

  for (const rep of [lock, deferDeadline, drop, lunchLate, onLocked, afterHours]) {
    assert.equal(rep.valid, false);
    assert.equal(rep.verdict, 'invalid');
    assert.ok(rep.pip.length > 0 && rep.violations.every((v) => v.message.length > 10), 'every violation explains itself');
  }
});

test('judge: valid-but-wasteful fixes are accepted but never beat Breakpoint (60 seeds x 3 random strategies)', () => {
  const rng = new Rng(31);
  let valid = 0;
  let bigger = 0;
  for (let seed = 0; seed < 60; seed++) {
    const c = makeChallenge(seed);
    const world = buildWorld(c.plan, c.suggested);
    for (let k = 0; k < 3; k++) {
      const w = Array.from({ length: world.floaters.length }, () => 1 + rng.int(0, 20));
      const byId = new Map(world.floaters.map((f, i) => [f.id, w[i]!]));
      const res = solveFloaters(freeTime(world), world.floaters, { weight: (f) => 1e6 * byId.get(f.id)! + f.duration });
      if (!res.feasible) continue;
      const attempt: Attempt = { disruptions: c.suggested, placements: Object.fromEntries(res.placed), deferred: res.deferred };
      const rep = judgeAttempt(c.plan, attempt);
      if (!rep.valid) continue;
      valid++;
      assert.notEqual(rep.verdict, 'better', `seed ${seed}: a random valid fix beat the "provably smallest" one`);
      assert.ok(!lexLess(lexCost(rep.yours!), lexCost(rep.breakpoint!)));
      if (rep.verdict === 'valid_bigger') {
        bigger++;
        assert.ok(rep.score < 100);
        assert.ok(rep.comparison.length === 4);
      }
    }
  }
  assert.ok(valid >= 100 && bigger >= 20, `valid ${valid}, bigger ${bigger}`);
});

test('judge: 300 random nudges of Breakpoint\'s own fix never find anything smaller (the optimum really is the optimum)', () => {
  const rng = new Rng(5);
  let validNudges = 0;
  for (let n = 0; n < 300; n++) {
    const c = makeChallenge(rng.int(0, 119));
    const base = engineAttempt(c);
    const ours = judgeAttempt(c.plan, base).breakpoint!;
    const ids = Object.keys(base.placements);
    const placements = { ...base.placements };
    for (let k = 0; k < rng.int(1, 2); k++) {
      const id = rng.pick(ids);
      placements[id] = placements[id]! + rng.pick([-30, -20, -15, -10, -5, 5, 10, 15, 20, 30]);
    }
    const rep = judgeAttempt(c.plan, { ...base, placements });
    if (!rep.valid) continue;
    validNudges++;
    assert.ok(!lexLess(lexCost(rep.yours!), lexCost({ deferred: ours.deferred, moved: ours.moved, totalMinutes: ours.totalMinutes })), 'a nudge beat the optimum');
  }
  assert.ok(validNudges > 40, `enough nudges were valid to mean something (${validNudges})`);
});

test('judge: the detailed checker and the independent validator always agree (random good, bad and cheating attempts)', () => {
  const rng = new Rng(404);
  let valid = 0;
  let invalid = 0;
  for (let n = 0; n < 400; n++) {
    const c = makeChallenge(rng.int(0, 119));
    const base = engineAttempt(c);
    const placements: Record<string, number> = { ...base.placements };
    const deferred = [...base.deferred];
    for (const id of Object.keys(placements)) {
      const roll = rng.next();
      if (roll < 0.25) placements[id] = placements[id]! + rng.int(-60, 60);
      else if (roll < 0.3) {
        delete placements[id];
        if (rng.next() < 0.5) deferred.push(id);
      }
    }
    if (rng.next() < 0.1) placements.lecture = at0(c) + rng.int(0, 600);
    const attempt: Attempt = { disruptions: c.suggested, placements, deferred };
    const rep = judgeAttempt(c.plan, attempt); // throws if the two checkers ever disagree
    const world = buildWorld(c.plan, attempt.disruptions);
    const known = (id: string) => world.floaters.some((f) => f.id === id);
    const independent = validatePlacements(world, new Map(Object.entries(placements).filter(([id]) => known(id))), deferred.filter(known));
    assert.equal(rep.valid, independent.length === 0 && !('lecture' in placements));
    if (rep.valid) valid++;
    else invalid++;
    const detail = checkAttempt(c.plan, attempt);
    assert.equal(detail.violations.length === 0, rep.valid);
  }
  assert.ok(valid > 30 && invalid > 100, `both outcomes are exercised (valid ${valid}, invalid ${invalid})`);
});
const at0 = (c: ReturnType<typeof makeChallenge>) => c.plan.settings.horizon.start;

test('judge: visitors can add their own disruptions, including ones nobody can survive, and get the reason instead of a score', () => {
  const c = makeChallenge(2);
  const nasty: Disruption[] = [{ type: 'lost_time', minutes: 600, start: c.plan.settings.horizon.start + 8 * 60 }];
  const rep = judgeAttempt(c.plan, { disruptions: nasty, placements: {}, deferred: [] });
  assert.equal(rep.verdict, 'impossible_day');
  assert.equal(rep.valid, false);
  assert.match(rep.headline, /cannot be saved/);
  assert.ok(rep.rescue.diagnosis);
  assert.ok(rep.pip.some((l) => /No valid schedule exists/.test(l.text)));

  // a custom, survivable disruption is judged against breakpoint's answer for that disruption
  const mine: Disruption[] = [{ type: 'overrun', targetId: 'problems', minutes: 25 }, { type: 'unexpected', start: c.plan.settings.horizon.start + 15 * 60, duration: 30, title: 'Call', priority: 5 }];
  const r2 = rescueDay(c.plan, mine);
  if (r2.lanes.repaired) {
    const att: Attempt = { disruptions: mine, placements: Object.fromEntries(r2.lanes.repaired.blocks.filter((b) => !b.locked && !b.injected).map((b) => [b.id, b.start])), deferred: r2.deferred.map((d) => d.id) };
    assert.equal(judgeAttempt(c.plan, att).verdict, 'matched');
  }
});

/* ═══════════════════ the api ═══════════════════ */

test('API: POST /api/engine/rescue works with no account, returns ISO times, and refuses nothing it should accept', async () => {
  const t = await makeApp();
  const call = client(t);
  const demo = await call('GET', '/api/demo/schedule?tz=America/Chicago');
  const res = await call('POST', '/api/engine/rescue', { body: demo.json.try.futures });
  assert.equal(res.status, 200, res.text);
  const r = res.json.result;
  assert.ok(['repaired', 'repaired_with_deferrals', 'absorbed', 'impossible'].includes(r.status));
  assert.match(r.lanes.original.blocks[0].start, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Array.isArray(r.pip) && r.pip.length > 0);
  assert.ok(Array.isArray(r.replay) && r.replay[0].phase === 'original');
  if (r.status !== 'impossible') assert.ok(r.guarantees.every((g: { ok: boolean }) => g.ok));

  // validation: a rescue needs at least one disruption
  const bad = await call('POST', '/api/engine/rescue', { body: { ...demo.json.try.futures, disruptions: [] } });
  assert.equal(bad.status, 400);
});
