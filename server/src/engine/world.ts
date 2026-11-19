import type { Disruption, Interval, ItemKind, Minutes, Plan, PlanItem, PlanSettings, Priority } from './types.ts';
import { PlanError } from './types.ts';
import { fmtClock, fmtDuration } from './time.ts';
import { intersectIntervals, mergeIntervals, subtractIntervals } from './intervals.ts';

/** Hard cap so a typo cannot create absurd plans. */
export const MAX_DISRUPTION_MIN = 7 * 24 * 60;

/** A plan item resolved for simulation: has a concrete start and remembers where it came from. */
export interface WorkItem extends PlanItem {
  start: Minutes;
  origStart: Minutes;
  origDuration: number;
  injected: boolean;
  shiftedBy: number;
  extendedBy: number;
}

export interface Floater {
  id: string;
  title: string;
  kind: ItemKind;
  duration: number;
  release: Minutes;
  deadline: Minutes;
  /** Baseline start, used to measure how far a plan moved it. */
  origStart: Minutes;
  priority: Priority;
  deferrable: boolean;
  critical: boolean;
}

export interface World {
  settings: PlanSettings;
  /** Blocking, locked time: calendar commitments, locked breaks, injected disruptions. */
  locked: WorkItem[];
  /** Flexible blocking work that the solver may place. */
  floaters: Floater[];
  /** Everything (including non-blocking items) after the disruptions were applied. */
  work: WorkItem[];
  injected: WorkItem[];
  /** Sum of all disruption minutes (used to size mobility windows). */
  disruptionTotal: number;
  notes: string[];
}

export function lockedInterval(i: { start: Minutes; duration: number }): Interval {
  return { start: i.start, end: i.start + i.duration };
}

function checkMinutes(m: number, what: string): number {
  if (!Number.isFinite(m) || m <= 0) throw new PlanError('invalid_disruption', `${what}: minutes must be a positive number`);
  if (m > MAX_DISRUPTION_MIN) throw new PlanError('invalid_disruption', `${what}: minutes must be at most ${MAX_DISRUPTION_MIN}`);
  return Math.round(m);
}

/** Copy the plan's items into WorkItems and apply the disruptions to the COPIES. The plan is never mutated. */
export function applyDisruptions(plan: Plan, disruptions: readonly Disruption[]): { work: WorkItem[]; injected: WorkItem[]; notes: string[]; total: number } {
  const work: WorkItem[] = plan.items.map((it) => {
    if (it.start === undefined) {
      throw new PlanError('unscheduled_item', `"${it.title}" has no start time yet. Build the baseline first (it is placed automatically by the API).`);
    }
    return { ...it, start: it.start, origStart: it.start, origDuration: it.duration, injected: false, shiftedBy: 0, extendedBy: 0 };
  });
  const byId = new Map(work.map((w) => [w.id, w]));
  const injected: WorkItem[] = [];
  const notes: string[] = [];
  const tz = plan.settings.timezone;
  let total = 0;
  let n = 0;
  for (const d of disruptions) {
    n++;
    if (d.type === 'delay' || d.type === 'overrun') {
      const target = byId.get(d.targetId);
      if (!target) throw new PlanError('unknown_target', `Disruption #${n} targets "${d.targetId}", which is not in this plan.`);
      const m = checkMinutes(d.minutes, `Disruption #${n} (${d.type})`);
      total += m;
      if (d.type === 'delay') {
        target.start += m;
        target.shiftedBy += m;
        notes.push(`"${target.title}" starts ${fmtDuration(m)} late.`);
      } else {
        target.duration += m;
        target.extendedBy += m;
        notes.push(`"${target.title}" takes ${fmtDuration(m)} longer than planned.`);
      }
    } else if (d.type === 'unexpected') {
      const m = checkMinutes(d.duration, `Disruption #${n} (unexpected)`);
      total += m;
      const title = d.title?.trim() || 'Unexpected commitment';
      const w: WorkItem = {
        id: `disruption:unexpected:${n}`,
        title,
        kind: 'event',
        start: d.start,
        duration: m,
        locked: true,
        priority: d.priority ?? 5,
        deferrable: false,
        critical: false,
        blocking: true,
        origStart: d.start,
        origDuration: m,
        injected: true,
        shiftedBy: 0,
        extendedBy: 0,
      };
      injected.push(w);
      notes.push(`${title}: ${fmtDuration(m)} at ${fmtClock(d.start, tz)}.`);
    } else {
      const m = checkMinutes(d.minutes, `Disruption #${n} (lost_time)`);
      total += m;
      const starts = work.filter((w) => w.blocking).map((w) => w.start);
      const at = d.start ?? (starts.length ? Math.min(...starts) : plan.settings.horizon.start);
      injected.push({
        id: `disruption:lost_time:${n}`,
        title: 'Lost time',
        kind: 'event',
        start: at,
        duration: m,
        locked: true,
        priority: 5,
        deferrable: false,
        critical: false,
        blocking: true,
        origStart: at,
        origDuration: m,
        injected: true,
        shiftedBy: 0,
        extendedBy: 0,
      });
      notes.push(`You lose ${fmtDuration(m)} starting at ${fmtClock(at, tz)}.`);
    }
  }
  return { work: [...work, ...injected], injected, notes, total };
}

/**
 * Re-planning view of the disrupted day: what is locked (cannot move) and what the solver may place.
 * Mobility rules are baked into each floater's [release, deadline] window.
 */
export function buildWorld(plan: Plan, disruptions: readonly Disruption[]): World {
  const { work, injected, notes, total } = applyDisruptions(plan, disruptions);
  const { horizon, mobility } = plan.settings;
  const locked = work.filter((w) => w.locked && w.blocking);
  const floaters: Floater[] = [];
  for (const w of work) {
    if (w.locked || !w.blocking) continue;
    let release = Math.max(w.release ?? horizon.start, horizon.start);
    let deadline = Math.min(w.deadline ?? horizon.end, horizon.end);
    if (w.shiftedBy > 0) release = Math.max(release, w.start); // a delayed task cannot start before its new start
    if (mobility === 'fixed') {
      release = Math.max(release, w.start); // stick to the plan: never earlier than planned
    } else if (mobility === 'balanced') {
      // reorder freely, but never more than 3 hours from where the task sits now (a fixed window: recoverability stays monotone)
      release = Math.max(release, w.start - 180);
      deadline = Math.min(deadline, w.start + 180 + w.duration);
    }
    floaters.push({
      id: w.id,
      title: w.title,
      kind: w.kind,
      duration: w.duration,
      release,
      deadline,
      origStart: w.origStart,
      priority: w.priority,
      deferrable: w.kind === 'break' ? false : w.deferrable,
      critical: w.critical,
    });
  }
  floaters.sort((a, b) => a.origStart - b.origStart || a.id.localeCompare(b.id));
  return { settings: plan.settings, locked, floaters, work, injected, disruptionTotal: total, notes };
}

/** Human description of one disruption ("Practice runs 45m long"). */
export function describeDisruption(d: Disruption, plan: Plan): string {
  const tz = plan.settings.timezone;
  const title = (id: string) => plan.items.find((i) => i.id === id)?.title ?? id;
  switch (d.type) {
    case 'delay':
      return `${title(d.targetId)} starts ${fmtDuration(d.minutes)} late`;
    case 'overrun':
      return `${title(d.targetId)} runs ${fmtDuration(d.minutes)} long`;
    case 'unexpected':
      return `${d.title?.trim() || 'An unexpected commitment'} (${fmtDuration(d.duration)}) at ${fmtClock(d.start, tz)}`;
    case 'lost_time':
      return `You lose ${fmtDuration(d.minutes)}${d.start !== undefined ? ` at ${fmtClock(d.start, tz)}` : ' at the start of the day'}`;
  }
}

/** Time in which flexible items may be placed: availability inside the horizon, minus every locked block. */
export function freeTime(world: Pick<World, 'settings' | 'locked'>): Interval[] {
  const avail = intersectIntervals(world.settings.availability, [world.settings.horizon]);
  return subtractIntervals(avail, mergeIntervals(world.locked.map(lockedInterval)));
}
