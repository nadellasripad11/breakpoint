import type { Interval, Plan } from './types.ts';
import { EngineInvariantError } from './types.ts';
import type { World } from './world.ts';
import { freeTime } from './world.ts';
import { fitsFree, overlaps } from './intervals.ts';
import { fmtClock, fmtDuration } from './time.ts';

/**
 * independent checker for any generated plan. the generators are supposed to make these impossible;
 * this verifies it anyway and the api refuses to return a plan that fails.
 *
 *  1. every flexible item is either placed or explicitly deferred: exactly once. nothing disappears.
 *  2. non-deferrable items are always placed.
 *  3. placed items respect their release time, hard deadline and the free time (availability minus locked blocks).
 *  4. placed items never overlap each other.
 *  5. (fixed mobility) the original order is preserved.
 * locked items are not part of the placement at all, so they cannot move.
 */
export function validatePlacements(world: World, placed: ReadonlyMap<string, number>, deferred: readonly string[]): string[] {
  const v: string[] = [];
  const free = freeTime(world);
  const ids = new Set(world.floaters.map((f) => f.id));
  const seen = new Set<string>();
  const defSet = new Set(deferred);

  for (const f of world.floaters) {
    const isPlaced = placed.has(f.id);
    const isDeferred = defSet.has(f.id);
    if (isPlaced === isDeferred) v.push(`"${f.title}" must be either placed or deferred (placed=${isPlaced}, deferred=${isDeferred})`);
    if (isDeferred && !f.deferrable) v.push(`"${f.title}" is not deferrable but was deferred`);
    seen.add(f.id);
  }
  for (const id of [...placed.keys(), ...deferred]) if (!ids.has(id)) v.push(`unknown item "${id}" in result`);

  const intervals: { id: string; iv: Interval }[] = [];
  for (const f of world.floaters) {
    const s = placed.get(f.id);
    if (s === undefined) continue;
    if (!Number.isInteger(s)) v.push(`"${f.title}" has a non-integer start`);
    if (s < f.release) v.push(`"${f.title}" starts at ${s} before its release ${f.release}`);
    if (s + f.duration > f.deadline) v.push(`"${f.title}" ends after its deadline`);
    if (!fitsFree(free, s, f.duration)) v.push(`"${f.title}" is placed outside free time (a locked commitment or unavailable hours)`);
    intervals.push({ id: f.id, iv: { start: s, end: s + f.duration } });
  }
  intervals.sort((a, b) => a.iv.start - b.iv.start);
  for (let i = 1; i < intervals.length; i++) {
    if (overlaps(intervals[i - 1]!.iv, intervals[i]!.iv) > 0) v.push(`"${intervals[i - 1]!.id}" overlaps "${intervals[i]!.id}"`);
  }
  if (world.settings.mobility === 'fixed') {
    const byOrig = [...world.floaters].filter((f) => placed.has(f.id)).sort((a, b) => a.origStart - b.origStart || a.id.localeCompare(b.id));
    for (let i = 1; i < byOrig.length; i++) {
      if (placed.get(byOrig[i]!.id)! < placed.get(byOrig[i - 1]!.id)!) v.push(`order changed under fixed mobility: "${byOrig[i]!.title}" now precedes "${byOrig[i - 1]!.title}"`);
    }
  }
  return v;
}

export function assertValidPlacements(world: World, placed: ReadonlyMap<string, number>, deferred: readonly string[]): void {
  const v = validatePlacements(world, placed, deferred);
  if (v.length) throw new EngineInvariantError(v);
}

export interface BaselineIssue {
  code: 'locked_overlap' | 'task_overlap' | 'task_on_locked' | 'deadline_violated' | 'outside_availability' | 'before_release';
  itemIds: string[];
  message: string;
}

/** problems that already exist in the user's own plan before any disruption. reported, never "fixed" silently. */
export function baselineIssues(plan: Plan): BaselineIssue[] {
  const tz = plan.settings.timezone;
  const issues: BaselineIssue[] = [];
  const blocking = plan.items.filter((i) => i.blocking && i.start !== undefined);
  const iv = (i: { start?: number; duration: number }): Interval => ({ start: i.start!, end: i.start! + i.duration });
  const sorted = [...blocking].sort((a, b) => a.start! - b.start! || a.id.localeCompare(b.id));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (b.start! >= a.start! + a.duration) break;
      const o = overlaps(iv(a), iv(b));
      if (o <= 0) continue;
      const code = a.locked && b.locked ? 'locked_overlap' : a.locked || b.locked ? 'task_on_locked' : 'task_overlap';
      issues.push({ code, itemIds: [a.id, b.id], message: `"${a.title}" and "${b.title}" overlap by ${fmtDuration(o)} at ${fmtClock(Math.max(a.start!, b.start!), tz)}.` });
    }
  }
  for (const it of blocking) {
    if (it.locked) continue;
    if (it.deadline !== undefined && it.start! + it.duration > it.deadline) {
      issues.push({ code: 'deadline_violated', itemIds: [it.id], message: `"${it.title}" is planned to end at ${fmtClock(it.start! + it.duration, tz)}, after its ${fmtClock(it.deadline, tz)} deadline.` });
    }
    if (it.release !== undefined && it.start! < it.release) {
      issues.push({ code: 'before_release', itemIds: [it.id], message: `"${it.title}" is planned before its earliest start (${fmtClock(it.release, tz)}).` });
    }
  }
  return issues;
}
