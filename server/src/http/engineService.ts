import type { Disruption, Interval, Plan, Preferences, Probe } from '../engine/index.ts';
import {
  PlanError,
  baselineIssues,
  breakingPoint,
  describeDisruption,
  fortifyDay,
  isoToMin,
  minToZonedIso,
  parallelFutures,
  rescueDay,
  runChaos,
  simulateCascade,
  weakLinkProfile,
  zonedToMin,
} from '../engine/index.ts';
import { buildPlan } from '../calendar/expand.ts';
import type { BuiltPlan, StoredItem } from '../calendar/expand.ts';
import type { DisruptionInput } from './schemas.ts';
import { withIsoTimes } from './serialize.ts';

export type EngineKind = 'plan' | 'simulate' | 'chaos' | 'breaking_point' | 'futures' | 'fortify' | 'rescue';

export interface Window {
  date?: string;
  from?: string;
  to?: string;
}

export function resolveHorizon(w: Window, tz: string): Interval {
  if (w.date) {
    const [y, m, d] = w.date.split('-').map(Number) as [number, number, number];
    return { start: zonedToMin(y, m, d, 0, 0, tz), end: zonedToMin(y, m, d + 1, 0, 0, tz) };
  }
  if (!w.from || !w.to) throw new PlanError('invalid_window', 'Give a `date` or both `from` and `to`.');
  return { start: isoToMin(w.from), end: isoToMin(w.to) };
}

export function toEngineDisruption(d: DisruptionInput): Disruption {
  switch (d.type) {
    case 'delay':
    case 'overrun':
      return { type: d.type, targetId: d.targetId, minutes: d.minutes };
    case 'unexpected':
      return { type: 'unexpected', start: isoToMin(d.start), duration: d.minutes, ...(d.title ? { title: d.title } : {}), ...(d.priority ? { priority: d.priority } : {}) };
    case 'lost_time':
      return { type: 'lost_time', minutes: d.minutes, ...(d.start ? { start: isoToMin(d.start) } : {}) };
  }
}

export interface PreparedPlan {
  built: BuiltPlan;
  /** the plan the engine runs on: every blocking item has a start */
  plan: Plan;
  tz: string;
  horizon: Interval;
  unscheduled: { id: string; title: string; message: string }[];
}

/** stored items -> baseline plan. items that cannot be placed are reported (never dropped) and excluded from the run. */
export function prepare(stored: readonly StoredItem[], prefs: Preferences, horizon: Interval): PreparedPlan {
  const built = buildPlan(stored, prefs, horizon);
  const plan: Plan = { ...built.plan, items: built.plan.items.filter((i) => !i.blocking || i.start !== undefined) };
  return { built, plan, tz: prefs.timezone, horizon, unscheduled: built.baseline.unscheduled };
}

const planItemDto = (i: Plan['items'][number]) => ({
  id: i.id,
  title: i.title,
  kind: i.kind,
  start: i.start ?? null,
  end: i.start !== undefined ? i.start + i.duration : null,
  durationMin: i.duration,
  locked: i.locked,
  priority: i.priority,
  category: i.category ?? null,
  deadline: i.deadline ?? null,
  release: i.release ?? null,
  deferrable: i.deferrable,
  critical: i.critical,
  blocking: i.blocking,
  source: i.origin?.source ?? null,
  seriesId: i.origin?.baseId ?? null,
});

export interface EngineRequest {
  disruptions?: DisruptionInput[];
  scenarios?: number;
  seed?: number;
  severity?: 'mild' | 'realistic' | 'severe';
  examples?: number;
  probe?: { type: Probe['type']; targetId?: string; at?: string };
  mode?: 'cascade' | 'recover' | 'both';
  limitMinutes?: number;
  weakLinks?: boolean;
  maxChanges?: number;
  maxShiftMinutes?: number;
}

/** runs one engine operation and returns a json-ready dto (iso times in the schedule's timezone). pure: writes nothing. */
export function runEngine(kind: EngineKind, p: PreparedPlan, req: EngineRequest): Record<string, unknown> {
  const { plan, tz } = p;
  const iso = (v: unknown) => withIsoTimes(v, tz);
  const common = {
    window: iso(p.horizon),
    timezone: tz,
    ...(p.unscheduled.length ? { unscheduled: p.unscheduled } : {}),
    ...(p.built.warnings.length ? { warnings: p.built.warnings } : {}),
  };
  const ds = (req.disruptions ?? []).map(toEngineDisruption);

  switch (kind) {
    case 'plan':
      return {
        ...common,
        // every item is listed, including ones that could not be placed (start: null): nothing is hidden
        items: iso(p.built.plan.items.map(planItemDto)),
        issues: baselineIssues(plan),
        ...(p.built.baseline.diagnosis ? { diagnosis: p.built.baseline.diagnosis } : {}),
        settings: iso({ horizon: plan.settings.horizon, availability: plan.settings.availability, mobility: plan.settings.mobility, criticalPriority: plan.settings.criticalPriority }),
      };
    case 'simulate': {
      const r = simulateCascade(plan, ds);
      return { ...common, disruptions: ds.map((d) => describeDisruption(d, plan)), baselineIssues: baselineIssues(plan), result: iso(r) };
    }
    case 'chaos': {
      const r = runChaos(plan, { ...(req.scenarios !== undefined ? { scenarios: req.scenarios } : {}), ...(req.seed !== undefined ? { seed: req.seed } : {}), ...(req.severity ? { severity: req.severity } : {}), ...(req.examples !== undefined ? { examples: req.examples } : {}) });
      return { ...common, result: iso(r) };
    }
    case 'breaking_point': {
      const probe: Probe = req.probe ? { type: req.probe.type, ...(req.probe.targetId ? { targetId: req.probe.targetId } : {}), ...(req.probe.at ? { at: isoToMin(req.probe.at) } : {}) } : { type: 'lost_time' };
      const r = breakingPoint(plan, probe, req.mode ?? 'both', req.limitMinutes ?? 480);
      let weak: unknown;
      if (req.weakLinks) {
        const n = plan.items.filter((i) => i.blocking).length;
        weak = n <= 40 ? weakLinkProfile(plan, Math.min(req.limitMinutes ?? 240, 240)) : { skipped: 'too_many_items', message: 'Weak-link analysis is limited to 40 items per window.' };
      }
      return { ...common, probe: iso(probe), result: iso(r), ...(weak !== undefined ? { weakLinks: iso(weak) } : {}) };
    }
    case 'futures': {
      const r = parallelFutures(plan, ds);
      return { ...common, result: iso(r) };
    }
    case 'rescue':
      return { ...common, result: iso(rescueDay(plan, ds)) };
    case 'fortify': {
      const r = fortifyDay(plan, { ...(req.maxChanges !== undefined ? { maxChanges: req.maxChanges } : {}), ...(req.maxShiftMinutes !== undefined ? { maxShiftMinutes: req.maxShiftMinutes } : {}), ...(req.scenarios !== undefined ? { scenarios: req.scenarios } : {}), ...(req.seed !== undefined ? { seed: req.seed } : {}), ...(req.severity ? { severity: req.severity } : {}) });
      return { ...common, result: iso(r) };
    }
  }
}

export { minToZonedIso };
