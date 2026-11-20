import type { Disruption, Interval, Minutes, Plan, PlanItem } from './types.ts';
import { Rng } from './prng.ts';
import { buildWorld, describeDisruption, lockedInterval } from './world.ts';
import { intersectIntervals, overlaps, totalLength } from './intervals.ts';
import { baselineIssues, validatePlacements } from './validate.ts';
import { fmtClock, fmtDuration, isoToMin } from './time.ts';
import { rescueDay } from './rescue.ts';
import type { RescueResult } from './rescue.ts';
import { bufferFor, pipWords } from './explain.ts';
import type { PipLine } from './explain.ts';

/**
 * "Can you save this day?": a deliberately fragile day, generated from a seed, plus a judge that checks a visitor's fix
 * with the same rules the engine uses and compares it with Breakpoint's own rescue. No account, no server: everything
 * here is pure, deterministic code (the same seed always gives the same day).
 */

/** An arbitrary fixed Monday. Times in a challenge are the same wall-clock times for everyone (UTC). */
export const CHALLENGE_DAY: Minutes = isoToMin('2026-01-12T00:00:00Z');
const at = (h: number, m = 0): Minutes => CHALLENGE_DAY + h * 60 + m;

export interface Challenge {
  seed: number;
  /** which of the generator's tries produced this day (always the same for a seed) */
  attempt: number;
  title: string;
  story: string;
  plan: Plan;
  /** a disruption that really breaks this day and really can be repaired */
  suggested: Disruption[];
  facts: { items: number; slackMinutes: number; bufferMinutes: number | null; suggestedMinutes: number; breakpointMoves: number };
}

function item(p: Partial<PlanItem> & Pick<PlanItem, 'id' | 'title' | 'start' | 'duration'>): PlanItem {
  return { kind: 'task', locked: false, priority: 3, deferrable: false, critical: false, blocking: true, ...p };
}

const TITLES = ['Back-to-back Monday', 'The overbooked afternoon', 'Deadline day', 'One thing after another'];

function build(seed: number, attempt: number): Challenge | null {
  const rng = new Rng((Math.imul(seed + 1, 2654435761) + Math.imul(attempt + 1, 40503)) >>> 0);
  const gap = () => rng.pick([5, 10, 15]);

  const lecDur = rng.pick([60, 75, 90]);
  const lecEnd = at(9) + lecDur;
  const projStart = lecEnd + gap();
  const projDur = rng.pick([75, 90, 105]);
  const projEnd = projStart + projDur;
  const projDeadline = projEnd + rng.pick([15, 20, 25, 30]);
  const lunchStart = Math.max(projEnd + gap(), at(12));
  const lunchEnd = lunchStart + 45;
  const probStart = lunchEnd + gap();
  const probDur = rng.pick([60, 75, 90]);
  const probEnd = probStart + probDur;
  const probDeadline = probEnd + rng.pick([30, 45, 60]);
  const essayStart = probEnd + gap();
  const essayDur = rng.pick([60, 75]);
  const essayEnd = essayStart + essayDur;
  const essayDeadline = essayEnd + rng.pick([15, 20, 30, 45]);
  const gymStart = essayEnd + gap();
  const gymDur = rng.pick([45, 60]);
  const choirStart = at(18, rng.pick([0, 15, 30]));
  const emailStart = choirStart + 60 + 15;

  if (lunchEnd > at(14) || gymStart + gymDur > choirStart) return null;

  const items: PlanItem[] = [
    item({ id: 'lecture', title: 'Morning lecture', kind: 'event', start: at(9), duration: lecDur, locked: true, priority: 4, category: 'school' }),
    item({ id: 'project', title: 'Project work', start: projStart, duration: projDur, priority: 4, deadline: projDeadline, category: 'school' }),
    item({ id: 'lunch', title: 'Lunch', kind: 'break', start: lunchStart, duration: 45, priority: 5, release: at(12), deadline: at(14) }),
    item({ id: 'problems', title: 'Problem set', start: probStart, duration: probDur, priority: 4, deadline: probDeadline, category: 'school' }),
    item({ id: 'essay', title: 'Essay draft', start: essayStart, duration: essayDur, priority: 5, critical: true, deadline: essayDeadline, category: 'school' }),
    item({ id: 'gym', title: 'Gym', start: gymStart, duration: gymDur, priority: 2, deferrable: true, category: 'fitness' }),
    item({ id: 'choir', title: 'Choir rehearsal', kind: 'event', start: choirStart, duration: 60, locked: true, priority: 5, critical: true, category: 'extra' }),
    item({ id: 'email', title: 'Catch up on email', start: emailStart, duration: 30, priority: 1, deferrable: true }),
  ];
  const plan: Plan = {
    items,
    settings: { horizon: { start: CHALLENGE_DAY, end: CHALLENGE_DAY + 1440 }, availability: [{ start: at(8), end: at(22) }], mobility: 'balanced', criticalPriority: 5, timezone: 'UTC' },
  };
  if (baselineIssues(plan).length) return null;

  const kind = rng.pick(['project', 'problems', 'meeting'] as const);
  const minutes = rng.pick([35, 40, 45, 50, 60]);
  let suggested: Disruption;
  if (kind === 'meeting') suggested = { type: 'unexpected', start: at(14, rng.pick([0, 15, 30, 45, 60, 90])), duration: rng.pick([45, 60]), title: 'Surprise meeting', priority: 5 };
  else suggested = { type: 'overrun', targetId: kind, minutes };

  // it must really break the day, and the day must be repairable, with a visible but modest fix
  const r = rescueDay(plan, [suggested]);
  if (r.status !== 'repaired' || r.changes.length < 1 || r.changes.length > 4) return null;
  if (!r.conflicts.some((c) => c.severity !== 'minor')) return null;
  const buffer = suggested.type === 'overrun' ? bufferFor(plan, suggested).minutes : null;
  if (buffer !== null && suggested.type === 'overrun' && buffer >= suggested.minutes) return null;

  const blocks = items.filter((i) => i.blocking).sort((a, b) => a.start! - b.start!);
  let slack = 0;
  for (let i = 1; i < blocks.length; i++) slack += Math.max(0, blocks[i]!.start! - (blocks[i - 1]!.start! + blocks[i - 1]!.duration));
  const dur = suggested.type === 'overrun' ? suggested.minutes : suggested.duration;
  return {
    seed,
    attempt,
    title: TITLES[seed % TITLES.length]!,
    story: `Eight things, ${fmtDuration(slack)} of slack in total, three hard limits (two deadlines and a protected lunch). Then: ${describeDisruption(suggested, plan)}.`,
    plan,
    suggested: [suggested],
    facts: { items: blocks.length, slackMinutes: slack, bufferMinutes: buffer, suggestedMinutes: dur, breakpointMoves: r.changes.length },
  };
}

/** The same seed always returns the same challenge. */
export function makeChallenge(seed: number): Challenge {
  const s = Math.abs(Math.trunc(seed)) >>> 0;
  for (let attempt = 0; attempt < 500; attempt++) {
    const c = build(s, attempt);
    if (c) return c;
  }
  throw new Error(`no challenge could be generated for seed ${s}`);
}

/* ───────────── judging a visitor's fix ───────────── */

export interface Attempt {
  /** the disruptions the visitor applied (they may add their own) */
  disruptions: Disruption[];
  /** start minute of every flexible item the visitor kept; items not listed must be in `deferred` */
  placements: Record<string, number>;
  /** flexible items sent to another day (only items marked deferrable may be) */
  deferred: string[];
}

export type ViolationCode = 'unplaced' | 'unknown_item' | 'locked_moved' | 'overlap_locked' | 'overlap_task' | 'deadline' | 'break_window' | 'before_release' | 'outside_hours' | 'not_deferrable';

export interface Violation {
  code: ViolationCode;
  itemId: string;
  otherId?: string;
  minutes: number;
  message: string;
}

export interface Metrics {
  moved: number;
  kept: number;
  totalMinutes: number;
  maxMinutes: number;
  deferred: number;
}

export interface Comparison {
  label: string;
  yours: number;
  ours: number;
}

export type Verdict = 'invalid' | 'impossible_day' | 'matched' | 'better' | 'valid_bigger';

export interface AttemptReport {
  valid: boolean;
  verdict: Verdict;
  headline: string;
  violations: Violation[];
  yours: Metrics | null;
  breakpoint: Metrics | null;
  comparison: Comparison[];
  /** 0 to 100: Breakpoint's cost divided by yours (documented in `scoreNote`) */
  score: number;
  scoreNote: string;
  pip: PipLine[];
  rescue: RescueResult;
}

const COST = { deferred: 120, moved: 15 };
const costOf = (m: Metrics) => m.totalMinutes + COST.moved * m.moved + COST.deferred * m.deferred;

/** Checks a visitor's fix against the rules, using the engine's own model of the disrupted day. */
export function checkAttempt(plan: Plan, attempt: Attempt): { violations: Violation[]; metrics: Metrics | null } {
  const world = buildWorld(plan, attempt.disruptions);
  const tz = plan.settings.timezone;
  const clock = (m: Minutes) => fmtClock(m, tz);
  const v: Violation[] = [];
  const floaters = new Map(world.floaters.map((f) => [f.id, f]));
  const lockedIds = new Set(world.locked.map((l) => l.id));
  const avail = intersectIntervals(world.settings.availability, [world.settings.horizon]);
  const deferred = new Set(attempt.deferred);

  for (const id of [...Object.keys(attempt.placements), ...attempt.deferred]) {
    if (lockedIds.has(id)) v.push({ code: 'locked_moved', itemId: id, minutes: 0, message: `"${world.work.find((w) => w.id === id)?.title ?? id}" is locked: it cannot be moved or deferred.` });
    else if (!floaters.has(id)) v.push({ code: 'unknown_item', itemId: id, minutes: 0, message: `"${id}" is not part of this day.` });
  }

  const placed: { id: string; iv: Interval }[] = [];
  for (const f of world.floaters) {
    const s = attempt.placements[f.id];
    const isDef = deferred.has(f.id);
    if (s === undefined && !isDef) {
      v.push({ code: 'unplaced', itemId: f.id, minutes: f.duration, message: `"${f.title}" has no slot and was not deferred. Nothing may silently disappear.` });
      continue;
    }
    if (isDef) {
      if (!f.deferrable) v.push({ code: 'not_deferrable', itemId: f.id, minutes: f.duration, message: `"${f.title}" cannot be deferred${f.kind === 'break' ? ': it is a protected break' : ': it has a hard deadline today'}.` });
      continue;
    }
    if (s === undefined || !Number.isFinite(s)) continue;
    const e = s + f.duration;
    placed.push({ id: f.id, iv: { start: s, end: e } });
    if (s < f.release) v.push({ code: 'before_release', itemId: f.id, minutes: f.release - s, message: `"${f.title}" starts ${pipWords(f.release - s)} before the earliest it can (${clock(f.release)}).` });
    if (e > f.deadline) {
      const late = e - f.deadline;
      v.push(
        f.kind === 'break'
          ? { code: 'break_window', itemId: f.id, minutes: late, message: `"${f.title}" is a protected break and must end by ${clock(f.deadline)}; yours ends ${pipWords(late)} too late (${clock(e)}).` }
          : { code: 'deadline', itemId: f.id, minutes: late, message: `"${f.title}" would finish at ${clock(e)}, ${pipWords(late)} after its ${clock(f.deadline)} deadline.` },
      );
    }
    for (const l of world.locked) {
      const o = overlaps({ start: s, end: e }, lockedInterval(l));
      if (o > 0) v.push({ code: 'overlap_locked', itemId: f.id, otherId: l.id, minutes: o, message: `"${f.title}" overlaps "${l.title}" (locked, ${clock(l.start)}) by ${pipWords(o)}.` });
    }
    const outside = f.duration - totalLength(intersectIntervals([{ start: s, end: e }], avail));
    if (outside > 0) v.push({ code: 'outside_hours', itemId: f.id, minutes: outside, message: `"${f.title}" has ${pipWords(outside)} outside your available hours.` });
  }
  placed.sort((a, b) => a.iv.start - b.iv.start || a.id.localeCompare(b.id));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (placed[j]!.iv.start >= placed[i]!.iv.end) break;
      const o = overlaps(placed[i]!.iv, placed[j]!.iv);
      if (o > 0) v.push({ code: 'overlap_task', itemId: placed[i]!.id, otherId: placed[j]!.id, minutes: o, message: `"${floaters.get(placed[i]!.id)!.title}" and "${floaters.get(placed[j]!.id)!.title}" overlap by ${pipWords(o)}.` });
    }
  }

  if (v.length) return { violations: v, metrics: null };
  let moved = 0;
  let kept = 0;
  let total = 0;
  let max = 0;
  for (const f of world.floaters) {
    const s = attempt.placements[f.id];
    if (s === undefined) continue;
    const d = Math.abs(s - f.origStart);
    if (d === 0) kept++;
    else moved++;
    total += d;
    max = Math.max(max, d);
  }
  return { violations: [], metrics: { moved, kept, totalMinutes: total, maxMinutes: max, deferred: attempt.deferred.length } };
}

export function judgeAttempt(plan: Plan, attempt: Attempt): AttemptReport {
  const rescue = rescueDay(plan, attempt.disruptions);
  const { violations, metrics } = checkAttempt(plan, attempt);

  // the independent validator must agree with the detailed checker about validity
  const world = buildWorld(plan, attempt.disruptions);
  const placedMap = new Map(Object.entries(attempt.placements).filter(([id]) => world.floaters.some((f) => f.id === id)));
  const defList = attempt.deferred.filter((id) => world.floaters.some((f) => f.id === id));
  const independent = validatePlacements(world, placedMap, defList);
  const valid = violations.length === 0;
  // locked / unknown ids are outside the validator's world (it only sees flexible items), so compare on everything else
  const comparable = violations.filter((x) => x.code !== 'locked_moved' && x.code !== 'unknown_item');
  if (comparable.length === 0 !== (independent.length === 0)) throw new Error(`checker disagreement: ${JSON.stringify({ violations, independent })}`);

  const ours: Metrics | null =
    rescue.status === 'impossible' ? null : { moved: rescue.metrics.moved, kept: rescue.metrics.kept, totalMinutes: rescue.metrics.totalMinutes, maxMinutes: rescue.metrics.maxMinutes, deferred: rescue.metrics.deferred };
  const tz = plan.settings.timezone;
  const pip: PipLine[] = [];
  const base = { rescue, violations, breakpoint: ours, yours: metrics, scoreNote: `Score = Breakpoint's cost / your cost, where cost = minutes moved + ${COST.moved} per item touched + ${COST.deferred} per task deferred.` };

  if (!valid) {
    for (const x of violations.slice(0, 4)) pip.push({ kind: 'impossible', text: x.message, facts: { minutes: x.minutes }, itemIds: [x.itemId, ...(x.otherId ? [x.otherId] : [])] });
    if (rescue.status === 'impossible') {
      return { ...base, valid, verdict: 'impossible_day', headline: 'This day cannot be saved. No valid schedule exists, for you or for Breakpoint.', comparison: [], score: 0, pip: [...rescue.pip, ...pip] };
    }
    return { ...base, valid, verdict: 'invalid', headline: `Not valid yet: ${violations.length} ${violations.length === 1 ? 'rule is' : 'rules are'} broken.`, comparison: [], score: 0, pip };
  }

  if (!ours || !metrics) {
    // the visitor produced a valid schedule where the engine found none: cannot happen if both are right
    throw new Error('visitor fix is valid but the engine found no schedule');
  }

  const comparison: Comparison[] = [
    { label: 'Tasks deferred', yours: metrics.deferred, ours: ours.deferred },
    { label: 'Items moved', yours: metrics.moved, ours: ours.moved },
    { label: 'Minutes moved', yours: metrics.totalMinutes, ours: ours.totalMinutes },
    { label: 'Longest single move', yours: metrics.maxMinutes, ours: ours.maxMinutes },
  ];
  const lex = (m: Metrics) => [m.deferred, m.moved, m.totalMinutes];
  const a = lex(metrics);
  const b = lex(ours);
  let cmp = 0;
  for (let i = 0; i < 3 && cmp === 0; i++) cmp = a[i]! - b[i]!;
  const verdict: Verdict = cmp === 0 ? 'matched' : cmp < 0 ? 'better' : 'valid_bigger';
  const score = Math.max(0, Math.min(100, Math.round((100 * (costOf(ours) + 30)) / (costOf(metrics) + 30))));

  // which of your moves were unnecessary? (Breakpoint left the same item exactly where it was planned)
  const oursById = new Map((rescue.lanes.repaired?.blocks ?? []).map((x) => [x.id, x]));
  const extra: string[] = [];
  for (const f of world.floaters) {
    const s = attempt.placements[f.id];
    if (s === undefined || s === f.origStart) continue;
    const theirs = oursById.get(f.id);
    if (theirs && theirs.start === f.origStart) extra.push(`"${f.title}" (you moved it ${pipWords(Math.abs(s - f.origStart))}; it could stay at ${fmtClock(f.origStart, tz)})`);
  }
  if (verdict === 'matched') pip.push({ kind: 'fix', text: `Your fix touches ${metrics.moved} ${metrics.moved === 1 ? 'item' : 'items'} and moves ${pipWords(metrics.totalMinutes)} in total, which is exactly the minimum Breakpoint found.`, facts: { moved: metrics.moved, minutes: metrics.totalMinutes }, itemIds: [] });
  else if (verdict === 'better') pip.push({ kind: 'fix', text: `Your fix beats Breakpoint's: ${metrics.moved} moved (${pipWords(metrics.totalMinutes)}) versus ${ours.moved} (${pipWords(ours.totalMinutes)}). That is only possible on a day too large to prove optimal.`, facts: { moved: metrics.moved, minutes: metrics.totalMinutes }, itemIds: [] });
  else {
    pip.push({ kind: 'fix', text: `Your fix is valid, but it touches ${metrics.moved} ${metrics.moved === 1 ? 'item' : 'items'} and moves ${pipWords(metrics.totalMinutes)} in total. Breakpoint's touches ${ours.moved} and moves ${pipWords(ours.totalMinutes)}.`, facts: { yoursMoved: metrics.moved, yoursMinutes: metrics.totalMinutes, oursMoved: ours.moved, oursMinutes: ours.totalMinutes }, itemIds: [] });
    if (extra.length) pip.push({ kind: 'why_smallest', text: `You didn't need to move ${extra.join(', ')}.`, facts: { unnecessary: extra.length }, itemIds: [] });
  }
  pip.push(...rescue.pip.filter((l) => l.kind === 'change' || l.kind === 'kept'));

  const headline =
    verdict === 'matched' ? `Saved, with the smallest possible change. Score ${score}.`
    : verdict === 'better' ? `Saved, and you beat Breakpoint. Score ${score}.`
    : `Saved, but Breakpoint did it with less. Score ${score}.`;
  return { ...base, valid, verdict, headline, comparison, score, pip };
}
