import type { BaselineResult, Interval, ItemKind, Minutes, Plan, PlanItem, Preferences, Priority } from '../engine/index.ts';
import { PlanError, buildBaseline, expandProtectedBreaks, isoToMin, localParts, minToZonedIso, resolvePriority, settingsFor } from '../engine/index.ts';
import { expandRecurrence, parseRRule } from './recurrence.ts';

/** how an item is stored (database rows and api payloads share this shape). times are iso-8601 strings. */
export interface StoredItem {
  id: string;
  kind: ItemKind;
  title: string;
  start: string | null;
  durationMin: number;
  allDay: boolean;
  timezone: string;
  /** null = use the default for the kind (events are locked, tasks are flexible) */
  locked: boolean | null;
  /** null = derive from the category preference, else 3 */
  priority: Priority | null;
  category: string | null;
  deadline: string | null;
  release: string | null;
  deferrable: boolean | null;
  critical: boolean | null;
  blocking: boolean;
  recurrence: { rrule: string; exdates: string[] } | null;
  source: 'manual' | 'ics' | 'google' | 'notion' | 'demo';
  externalId: string | null;
}

export const MAX_PLAN_ITEMS = 1500;
export const MAX_HORIZON_DAYS = 31;

export function checkHorizon(h: Interval): void {
  if (!(h.end > h.start)) throw new PlanError('invalid_horizon', '`to` must be after `from`.');
  if (h.end - h.start > MAX_HORIZON_DAYS * 1440) throw new PlanError('horizon_too_long', `The planning window may be at most ${MAX_HORIZON_DAYS} days.`);
}

function toPlanItem(s: StoredItem, id: string, start: Minutes | undefined, prefs: Preferences): PlanItem {
  const priority = resolvePriority(s.priority, s.category ?? undefined, prefs);
  // a break with a fixed time and no window is a locked break; with a window it is flexible
  const locked = s.locked ?? (s.kind === 'event' ? true : s.kind === 'break' ? start !== undefined && !s.release && !s.deadline : false);
  const critical = s.critical ?? priority >= prefs.criticalPriority;
  const deferrable = s.kind === 'break' ? false : s.deferrable ?? priority < prefs.criticalPriority;
  const item: PlanItem = {
    id,
    title: s.title,
    kind: s.kind,
    duration: Math.max(1, Math.round(s.durationMin)),
    locked,
    priority,
    deferrable,
    critical,
    blocking: s.blocking && !s.allDay,
    origin: { source: s.source, ...(s.externalId ? { externalId: s.externalId } : {}), baseId: s.id },
    ...(start !== undefined ? { start } : {}),
    ...(s.category ? { category: s.category } : {}),
    ...(s.release ? { release: isoToMin(s.release) } : {}),
    ...(s.deadline ? { deadline: isoToMin(s.deadline) } : {}),
  };
  return item;
}

export interface ExpandResult {
  items: PlanItem[];
  warnings: string[];
}

/** concrete items for a planning window: recurrences expanded, defaults and preferences applied. pure. */
export function expandItems(stored: readonly StoredItem[], prefs: Preferences, horizon: Interval): ExpandResult {
  checkHorizon(horizon);
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  for (const s of stored) {
    if (items.length > MAX_PLAN_ITEMS) throw new PlanError('too_many_items', `A planning window may contain at most ${MAX_PLAN_ITEMS} items.`);
    const tz = s.timezone || prefs.timezone;
    if (s.start && s.recurrence) {
      let rule;
      try {
        rule = parseRRule(s.recurrence.rrule);
      } catch (e) {
        warnings.push(`"${s.title}": ${(e as Error).message}. It was left out of the plan.`);
        continue;
      }
      const startMin = isoToMin(s.start);
      const lp = localParts(startMin, tz);
      const occ = expandRecurrence({
        start: { y: lp.year, mo: lp.month, d: lp.day, h: lp.hour, mi: lp.minute },
        timezone: tz,
        durationMin: s.durationMin,
        rule,
        exdates: s.recurrence.exdates.map((e) => isoToMin(e)),
        window: horizon,
      });
      for (const m of occ) items.push(toPlanItem(s, `${s.id}@${minToZonedIso(m, tz).slice(0, 16)}`, m, prefs));
      continue;
    }
    if (s.start) {
      const m = isoToMin(s.start);
      if (m < horizon.end && m + s.durationMin > horizon.start) items.push(toPlanItem(s, s.id, m, prefs));
      continue;
    }
    // unscheduled task: relevant if its window touches the horizon
    const deadline = s.deadline ? isoToMin(s.deadline) : Infinity;
    const release = s.release ? isoToMin(s.release) : -Infinity;
    if (deadline > horizon.start && release < horizon.end) items.push(toPlanItem(s, s.id, undefined, prefs));
  }
  return { items, warnings };
}

export interface BuiltPlan {
  plan: Plan;
  baseline: BaselineResult;
  warnings: string[];
}

/** stored schedule -> engine plan with every flexible item placed (the "baseline"). */
export function buildPlan(stored: readonly StoredItem[], prefs: Preferences, horizon: Interval): BuiltPlan {
  const { items, warnings } = expandItems(stored, prefs, horizon);
  const breaks = expandProtectedBreaks(horizon, prefs);
  const settings = settingsFor(horizon, prefs);
  const baseline = buildBaseline({ items: [...items, ...breaks], settings });
  return { plan: baseline.plan, baseline, warnings };
}
