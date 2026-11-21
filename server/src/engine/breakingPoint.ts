import type { Conflict, Disruption, Minutes, Plan } from './types.ts';
import { PlanError } from './types.ts';
import { conflictKey, simulateCascade } from './cascade.ts';
import { buildWorld, freeTime } from './world.ts';
import { solveFloaters } from './solver.ts';
import { diagnoseWorld } from './diagnose.ts';
import type { Diagnosis } from './diagnose.ts';
import { fmtClock, fmtDuration } from './time.ts';

/**
 * breaking point: how many minutes of disruption can the schedule take before a critical failure?
 *
 * critical failure =
 *   - a hard deadline is missed (non-deferrable task), or a critical protected break is lost
 *   - two locked commitments overlap and at least one is critical
 *   - a non-deferrable task no longer fits in the planning window
 * conflicts that already exist in the plan before the disruption are reported separately and never count as "new".
 *
 * two modes:
 *   cascade : you do nothing and carry on (butterfly effect). exact, found by scanning minute by minute.
 *   recover : a feasible re-plan still exists (parallel futures can place everything). exact, via the solver.
 */

export type ProbeType = 'delay' | 'overrun' | 'lost_time' | 'unexpected';

export interface Probe {
  type: ProbeType;
  /** delay / overrun: the item that is disrupted */
  targetId?: string;
  /** lost_time / unexpected: when it hits (defaults to the start of the plan for lost_time) */
  at?: Minutes;
}

export type BreakingMode = 'cascade' | 'recover';

export interface BreakingPointResult {
  mode: BreakingMode;
  probe: Probe;
  /**
   * breaks             : a failure occurs at `breakingminutes`; `tolerableminutes` is one less
   * withstands_limit   : no failure up to the search limit
   * already_broken     : (recover mode) the undisturbed plan itself has no feasible schedule
   */
  status: 'breaks' | 'withstands_limit' | 'already_broken';
  tolerableMinutes: number | null;
  breakingMinutes: number | null;
  limitMinutes: number;
  failure: { conflicts: Conflict[] } | { diagnosis: Diagnosis } | null;
  preexisting: Conflict[];
  explanation: string;
}

export const DEFAULT_LIMIT = 480;
export const MAX_LIMIT = 1440;

export function probeToDisruption(plan: Plan, probe: Probe, minutes: number): Disruption {
  switch (probe.type) {
    case 'delay':
    case 'overrun':
      if (!probe.targetId) throw new PlanError('invalid_probe', `A "${probe.type}" probe needs a targetId.`);
      return { type: probe.type, targetId: probe.targetId, minutes };
    case 'lost_time':
      return probe.at === undefined ? { type: 'lost_time', minutes } : { type: 'lost_time', minutes, start: probe.at };
    case 'unexpected':
      if (probe.at === undefined) throw new PlanError('invalid_probe', 'An "unexpected" probe needs an `at` time.');
      return { type: 'unexpected', start: probe.at, duration: minutes };
  }
}

/** "if \"practice\" runs over", "if you lose time at the start of the day", ... */
function describeProbe(plan: Plan, probe: Probe): string {
  const tz = plan.settings.timezone;
  const name = (id?: string) => `"${plan.items.find((i) => i.id === id)?.title ?? id ?? 'this item'}"`;
  switch (probe.type) {
    case 'overrun':
      return `If ${name(probe.targetId)} runs over`;
    case 'delay':
      return `If ${name(probe.targetId)} starts late`;
    case 'lost_time':
      return probe.at === undefined ? 'If you lose time at the start of the day' : `If you lose time at ${fmtClock(probe.at, tz)}`;
    case 'unexpected':
      return `If an unexpected commitment hits at ${probe.at === undefined ? 'a given time' : fmtClock(probe.at, tz)}`;
  }
}

export function cascadeBreakingPoint(plan: Plan, probe: Probe, limit = DEFAULT_LIMIT): BreakingPointResult {
  const lim = clampLimit(limit);
  const tz = plan.settings.timezone;
  const baseline = simulateCascade(plan, []);
  const preexisting = baseline.conflicts.filter((c) => c.severity === 'critical');
  const known = new Set(preexisting.map(conflictKey));
  let first: { minutes: number; conflicts: Conflict[] } | null = null;
  for (let m = 1; m <= lim; m++) {
    const sim = simulateCascade(plan, [probeToDisruption(plan, probe, m)]);
    const fresh = sim.conflicts.filter((c) => c.severity === 'critical' && !known.has(conflictKey(c)));
    if (fresh.length) {
      first = { minutes: m, conflicts: fresh };
      break;
    }
  }
  const what = describeProbe(plan, probe);
  if (!first) {
    return {
      mode: 'cascade',
      probe,
      status: 'withstands_limit',
      tolerableMinutes: lim,
      breakingMinutes: null,
      limitMinutes: lim,
      failure: null,
      preexisting,
      explanation: `${what}, the schedule absorbs up to ${fmtDuration(lim)} (the search limit) without any critical conflict.`,
    };
  }
  const worst = first.conflicts[0]!;
  return {
    mode: 'cascade',
    probe,
    status: 'breaks',
    tolerableMinutes: first.minutes - 1,
    breakingMinutes: first.minutes,
    limitMinutes: lim,
    failure: { conflicts: first.conflicts },
    preexisting,
    explanation: `${what}, the schedule tolerates ${fmtDuration(first.minutes - 1)}. At ${fmtDuration(first.minutes)}, ${worst.message.charAt(0).toLowerCase()}${worst.message.slice(1)}`,
  };
}

export function recoverBreakingPoint(plan: Plan, probe: Probe, limit = DEFAULT_LIMIT): BreakingPointResult {
  const lim = clampLimit(limit);
  const ordered = plan.settings.mobility === 'fixed';
  const feasible = (m: number): boolean => {
    const world = buildWorld(plan, m === 0 ? [] : [probeToDisruption(plan, probe, m)]);
    return solveFloaters(freeTime(world), world.floaters, { ordered }).feasible;
  };
  const what = describeProbe(plan, probe);
  if (!feasible(0)) {
    return {
      mode: 'recover',
      probe,
      status: 'already_broken',
      tolerableMinutes: null,
      breakingMinutes: 0,
      limitMinutes: lim,
      failure: { diagnosis: diagnoseWorld(buildWorld(plan, []), plan, []) },
      preexisting: [],
      explanation: 'Even without any disruption, no feasible schedule exists for the tasks, deadlines and commitments you have set. See the diagnosis.',
    };
  }
  // overrun / lost_time / unexpected only ever remove free time as the minutes grow, so feasibility is monotone and
  // binary search is exact. a delay moves a block or a start time (freeing time on one side, using it on the other),
  // so delays are scanned minute by minute instead.
  const monotone = probe.type !== 'delay';
  let breaking: number | null = null;
  if (monotone) {
    if (!feasible(lim)) {
      let lo = 1;
      let hi = lim;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (feasible(mid)) lo = mid + 1;
        else hi = mid;
      }
      breaking = lo;
    }
  } else {
    for (let m = 1; m <= lim; m++) {
      if (!feasible(m)) {
        breaking = m;
        break;
      }
    }
  }
  if (breaking === null) {
    return {
      mode: 'recover',
      probe,
      status: 'withstands_limit',
      tolerableMinutes: lim,
      breakingMinutes: null,
      limitMinutes: lim,
      failure: null,
      preexisting: [],
      explanation: `${what}, re-planning keeps everything feasible up to ${fmtDuration(lim)} (the search limit).`,
    };
  }
  const world = buildWorld(plan, [probeToDisruption(plan, probe, breaking)]);
  const diagnosis = diagnoseWorld(world, plan, [probeToDisruption(plan, probe, breaking)]);
  return {
    mode: 'recover',
    probe,
    status: 'breaks',
    tolerableMinutes: breaking - 1,
    breakingMinutes: breaking,
    limitMinutes: lim,
    failure: { diagnosis },
    preexisting: [],
    explanation: `${what}, the day can still be re-planned for up to ${fmtDuration(breaking - 1)}. At ${fmtDuration(breaking)} no feasible schedule exists. ${diagnosis.reasons[0]?.message ?? diagnosis.summary}`,
  };
}

export function breakingPoint(plan: Plan, probe: Probe, mode: BreakingMode | 'both', limit = DEFAULT_LIMIT): { cascade?: BreakingPointResult; recover?: BreakingPointResult } {
  return {
    ...(mode !== 'recover' ? { cascade: cascadeBreakingPoint(plan, probe, limit) } : {}),
    ...(mode !== 'cascade' ? { recover: recoverBreakingPoint(plan, probe, limit) } : {}),
  };
}

function clampLimit(n: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

/* ───────────── per-item weak links ───────────── */

export interface WeakLink {
  itemId: string;
  title: string;
  /** minutes this item can run over before a critical failure (null = withstands the limit) */
  overrunTolerance: number | null;
  /** minutes this item can start late before a critical failure (null = withstands the limit) */
  delayTolerance: number | null;
  /** the first thing that breaks when the overrun tolerance is exceeded */
  firstFailure: string | null;
}

export interface WeakLinkProfile {
  weakest: WeakLink | null;
  /** weakest overall tolerance in minutes (min over overrun + delay probes), null if nothing breaks */
  minTolerance: number | null;
  links: WeakLink[];
}

/** probe every blocking item with an overrun and a delay and rank them by how little slack they have. */
export function weakLinkProfile(plan: Plan, limit = 240): WeakLinkProfile {
  const links: WeakLink[] = [];
  for (const it of plan.items) {
    if (!it.blocking || it.start === undefined) continue;
    const over = cascadeBreakingPoint(plan, { type: 'overrun', targetId: it.id }, limit);
    const delay = cascadeBreakingPoint(plan, { type: 'delay', targetId: it.id }, limit);
    links.push({
      itemId: it.id,
      title: it.title,
      overrunTolerance: over.status === 'breaks' ? over.tolerableMinutes : null,
      delayTolerance: delay.status === 'breaks' ? delay.tolerableMinutes : null,
      firstFailure: over.status === 'breaks' && over.failure && 'conflicts' in over.failure ? over.failure.conflicts[0]!.message : null,
    });
  }
  const tol = (l: WeakLink) => Math.min(l.overrunTolerance ?? Infinity, l.delayTolerance ?? Infinity);
  links.sort((a, b) => tol(a) - tol(b) || a.title.localeCompare(b.title) || a.itemId.localeCompare(b.itemId));
  const weakest = links.length && Number.isFinite(tol(links[0]!)) ? links[0]! : null;
  return { weakest, minTolerance: weakest ? tol(weakest) : null, links };
}

/** convenience for the "day starts late" probe. */
export function dayStartTolerance(plan: Plan, limit = DEFAULT_LIMIT): BreakingPointResult {
  return cascadeBreakingPoint(plan, { type: 'lost_time' }, limit);
}

