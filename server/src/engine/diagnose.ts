import type { Interval, Plan, Disruption } from './types.ts';
import type { Floater, World } from './world.ts';
import { buildWorld, freeTime } from './world.ts';
import { fmtClock, fmtDuration } from './time.ts';
import { freeWithin, intersectIntervals } from './intervals.ts';
import { solveFloaters } from './solver.ts';

export type ReasonCode = 'impossible_window' | 'task_too_long' | 'fragmentation' | 'not_enough_time';

export interface Reason {
  code: ReasonCode;
  message: string;
  itemIds: string[];
  shortfallMinutes?: number;
}

export interface Suggestion {
  action: 'defer_or_remove' | 'extend_deadline' | 'shorten' | 'loosen_mobility';
  message: string;
  itemId?: string;
  minutes?: number;
}

/** Explains WHY no feasible schedule exists. Nothing here changes the user's schedule. */
export interface Diagnosis {
  feasible: false;
  summary: string;
  reasons: Reason[];
  /** A minimal set of tasks that cannot all fit together (remove any one of them and the rest fit). */
  conflictSet: string[];
  suggestions: Suggestion[];
}

function clip(free: readonly Interval[], a: number, b: number): Interval[] {
  return intersectIntervals(free, [{ start: a, end: b }]);
}

export function diagnoseWorld(world: World, plan?: Plan, disruptions: readonly Disruption[] = []): Diagnosis {
  const tz = world.settings.timezone;
  const free = freeTime(world);
  const required = world.floaters.filter((f) => !f.deferrable);
  const title = (id: string) => world.floaters.find((f) => f.id === id)?.title ?? id;
  const reasons: Reason[] = [];

  // 1 · individual impossibilities
  for (const t of required) {
    if (t.deadline - t.release < t.duration) {
      reasons.push({
        code: 'impossible_window',
        itemIds: [t.id],
        message: `"${t.title}" needs ${fmtDuration(t.duration)} but only ${fmtDuration(Math.max(0, t.deadline - t.release))} lie between when it can start (${fmtClock(t.release, tz)}) and its deadline (${fmtClock(t.deadline, tz)}).`,
      });
      continue;
    }
    const segs = clip(free, t.release, t.deadline);
    const longest = segs.reduce((m, s) => Math.max(m, s.end - s.start), 0);
    const totalFree = segs.reduce((m, s) => m + (s.end - s.start), 0);
    if (longest < t.duration) {
      reasons.push(
        totalFree >= t.duration
          ? {
              code: 'fragmentation',
              itemIds: [t.id],
              shortfallMinutes: t.duration - longest,
              message: `"${t.title}" needs ${fmtDuration(t.duration)} in one piece, but the longest free stretch before ${fmtClock(t.deadline, tz)} is ${fmtDuration(longest)} (your commitments split the free time).`,
            }
          : {
              code: 'task_too_long',
              itemIds: [t.id],
              shortfallMinutes: t.duration - totalFree,
              message: `"${t.title}" needs ${fmtDuration(t.duration)} but only ${fmtDuration(totalFree)} are free between ${fmtClock(t.release, tz)} and ${fmtClock(t.deadline, tz)}.`,
            },
      );
    }
  }

  // 2 · Hall-style check: more work than free time inside some window?
  const points = [...new Set(required.flatMap((t) => [t.release, t.deadline]))].sort((a, b) => a - b);
  let worst: { a: number; b: number; demand: number; supply: number; ids: string[] } | null = null;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      const inside = required.filter((t) => t.release >= a && t.deadline <= b);
      if (inside.length < 2) continue;
      const demand = inside.reduce((s, t) => s + t.duration, 0);
      const supply = freeWithin(free, a, b);
      if (demand > supply && (!worst || demand - supply > worst.demand - worst.supply)) worst = { a, b, demand, supply, ids: inside.map((t) => t.id) };
    }
  }
  if (worst) {
    reasons.push({
      code: 'not_enough_time',
      itemIds: worst.ids,
      shortfallMinutes: worst.demand - worst.supply,
      message: `${worst.ids.map((id) => `"${title(id)}"`).join(', ')} need ${fmtDuration(worst.demand)} between ${fmtClock(worst.a, tz)} and ${fmtClock(worst.b, tz)}, but only ${fmtDuration(worst.supply)} is free. You are short by ${fmtDuration(worst.demand - worst.supply)}.`,
    });
  }

  // 3 · minimal conflicting set (deletion filter; deterministic order)
  let conflictSet: Floater[] = [...required];
  const feasibleWith = (set: Floater[]) => solveFloaters(free, set, { ordered: world.settings.mobility === 'fixed' }).feasible;
  if (required.length <= 20 && !feasibleWith(required)) {
    const candidates = [...required].sort((a, b) => a.priority - b.priority || a.duration - b.duration || a.id.localeCompare(b.id));
    for (const c of candidates) {
      const without = conflictSet.filter((t) => t.id !== c.id);
      if (!feasibleWith(without)) conflictSet = without;
    }
  } else if (required.length > 20) {
    conflictSet = required.filter((t) => reasons.some((r) => r.itemIds.includes(t.id)));
  }
  const conflictIds = conflictSet.map((t) => t.id);

  // 4 · suggestions (never applied automatically)
  const suggestions: Suggestion[] = [];
  const ordered = world.settings.mobility === 'fixed';
  if (conflictSet.length <= 20) {
    for (const t of conflictSet) {
      const rest = conflictSet.filter((x) => x.id !== t.id);
      if (solveFloaters(free, rest, { ordered }).feasible) {
        suggestions.push({ action: 'defer_or_remove', itemId: t.id, minutes: t.duration, message: `Move "${t.title}" (${fmtDuration(t.duration)}) to another day, and everything else fits.` });
      }
      // smallest deadline extension
      if (t.deadline < world.settings.horizon.end) {
        const maxExt = world.settings.horizon.end - t.deadline;
        const ok = (e: number) => solveFloaters(free, conflictSet.map((x) => (x.id === t.id ? { ...x, deadline: x.deadline + e } : x)), { ordered }).feasible;
        if (ok(maxExt)) {
          let lo = 1;
          let hi = maxExt;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ok(mid)) hi = mid;
            else lo = mid + 1;
          }
          suggestions.push({ action: 'extend_deadline', itemId: t.id, minutes: lo, message: `Extend the deadline of "${t.title}" by ${fmtDuration(lo)} (to ${fmtClock(t.deadline + lo, tz)}) and everything fits.` });
        }
      }
      // smallest shortening
      const okShort = (r: number) => solveFloaters(free, conflictSet.map((x) => (x.id === t.id ? { ...x, duration: x.duration - r } : x)), { ordered }).feasible;
      if (t.duration > 5 && okShort(t.duration - 5)) {
        let lo = 1;
        let hi = t.duration - 5;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (okShort(mid)) hi = mid;
          else lo = mid + 1;
        }
        suggestions.push({ action: 'shorten', itemId: t.id, minutes: lo, message: `Shorten "${t.title}" by ${fmtDuration(lo)} (to ${fmtDuration(t.duration - lo)}) and everything fits.` });
      }
    }
  }
  if (plan && plan.settings.mobility !== 'flexible') {
    const loose = buildWorld({ ...plan, settings: { ...plan.settings, mobility: 'flexible' } }, disruptions);
    if (solveFloaters(freeTime(loose), loose.floaters, {}).feasible) {
      suggestions.push({ action: 'loosen_mobility', message: `Allow bigger changes: with Flexible mobility everything fits (your current setting is "${plan.settings.mobility}").` });
    }
  }
  suggestions.sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity) || a.message.localeCompare(b.message));

  const names = conflictSet.map((t) => `"${t.title}"`).join(', ');
  const summary = conflictSet.length
    ? `No schedule can fit ${names} within your commitments, deadlines and available hours. Nothing was removed or moved; here is why and what would fix it.`
    : 'No feasible schedule exists under the current constraints. Nothing was removed or moved.';
  return { feasible: false, summary, reasons, conflictSet: conflictIds, suggestions: suggestions.slice(0, 8) };
}
