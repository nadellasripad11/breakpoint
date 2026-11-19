import type { Plan, PlanItem } from './types.ts';
import { PlanError } from './types.ts';
import type { Floater, World, WorkItem } from './world.ts';
import { freeTime, lockedInterval } from './world.ts';
import { solveFloaters, weightByCount } from './solver.ts';
import { diagnoseWorld } from './diagnose.ts';
import type { Diagnosis } from './diagnose.ts';
import { fmtDuration } from './time.ts';
import { subtractIntervals } from './intervals.ts';

export interface BaselineResult {
  plan: Plan;
  /** ids that received a start time */
  placed: string[];
  /** flexible items that could not be placed. They stay in the plan (without a start) and are reported, never dropped. */
  unscheduled: { id: string; title: string; message: string }[];
  diagnosis?: Diagnosis;
}

/**
 * Gives every unscheduled flexible item (a Notion task with only a due date, a protected break, ...) a concrete slot.
 * Items that already have a start keep it. Placement is earliest-possible, honours release times, hard deadlines,
 * availability and locked commitments, and is deterministic.
 */
export function buildBaseline(plan: Plan): BaselineResult {
  const { settings } = plan;
  const unscheduled = plan.items.filter((i) => i.blocking && i.start === undefined);
  const bad = unscheduled.find((i) => i.locked);
  if (bad) throw new PlanError('locked_needs_start', `"${bad.title}" is locked but has no start time.`);
  if (unscheduled.length === 0) return { plan, placed: [], unscheduled: [] };

  const fixed = plan.items.filter((i): i is PlanItem & { start: number } => i.blocking && i.start !== undefined);
  const toWork = (i: PlanItem & { start: number }): WorkItem => ({ ...i, start: i.start, origStart: i.start, origDuration: i.duration, injected: false, shiftedBy: 0, extendedBy: 0 });
  const lockedWork = fixed.filter((i) => i.locked).map(toWork);
  // already-scheduled flexible items keep their slots: they are obstacles for the new ones
  const occupied = fixed.filter((i) => !i.locked).map((i) => lockedInterval(toWork(i)));

  const floaters: Floater[] = unscheduled.map((i) => ({
    id: i.id,
    title: i.title,
    kind: i.kind,
    duration: i.duration,
    release: Math.max(i.release ?? settings.horizon.start, settings.horizon.start),
    deadline: Math.min(i.deadline ?? settings.horizon.end, settings.horizon.end),
    origStart: Math.max(i.release ?? settings.horizon.start, settings.horizon.start),
    priority: i.priority,
    deferrable: i.kind === 'break' ? false : i.deferrable,
    critical: i.critical,
  }));
  const world: World = { settings, locked: lockedWork, floaters, work: [], injected: [], disruptionTotal: 0, notes: [] };
  const free = subtractIntervals(freeTime(world), occupied);

  let res = solveFloaters(free, floaters, { weight: weightByCount });
  let diagnosis: Diagnosis | undefined;
  if (!res.feasible) {
    diagnosis = diagnoseWorld({ ...world, locked: [...lockedWork, ...[]] }, undefined, []);
    // best effort: place as much as possible (required items first), report the rest
    const relaxed = floaters.map((f) => ({ ...f, deferrable: true }));
    res = solveFloaters(free, relaxed, { weight: (f) => (floaters.find((x) => x.id === f.id)!.deferrable ? 1 : 1e13) + weightByCount(f) });
  }

  const placed = res.placed;
  const items = plan.items.map((i) => (placed.has(i.id) ? { ...i, start: placed.get(i.id)! } : i));
  const unplaced = floaters.filter((f) => !placed.has(f.id));
  return {
    plan: { ...plan, items },
    placed: [...placed.keys()],
    unscheduled: unplaced.map((f) => ({
      id: f.id,
      title: f.title,
      message: `"${f.title}" (${fmtDuration(f.duration)}) could not be placed before its deadline within your available hours. It was NOT removed; it is waiting for you to decide what to do.`,
    })),
    ...(diagnosis ? { diagnosis } : {}),
  };
}
