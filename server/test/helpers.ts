import type { Minutes, Plan, PlanItem, PlanSettings, Priority } from '../src/engine/index.ts';
import { buildAvailability, normalizePreferences, zonedToMin } from '../src/engine/index.ts';
import type { Preferences } from '../src/engine/index.ts';

export const TZ = 'America/Chicago';

/** minutes for a local time on 2026-11-dd in america/chicago (cst, utc-6). */
export function at(h: number, m = 0, day = 20): Minutes {
  return zonedToMin(2026, 11, day, h, m, TZ);
}

export function prefs(p: Partial<Preferences> = {}): Preferences {
  return normalizePreferences({ timezone: TZ, workingHours: { start: '07:00', end: '23:00' }, ...p });
}

export function settings(opts: { from?: Minutes; to?: Minutes; mobility?: 'fixed' | 'balanced' | 'flexible'; hours?: [string, string]; criticalPriority?: Priority } = {}): PlanSettings {
  const horizon = { start: opts.from ?? at(0), end: opts.to ?? at(24) };
  const p = prefs({ mobility: opts.mobility ?? 'balanced', workingHours: { start: opts.hours?.[0] ?? '07:00', end: opts.hours?.[1] ?? '23:00' }, criticalPriority: opts.criticalPriority ?? 4 });
  return { horizon, availability: buildAvailability(horizon, p), mobility: p.mobility, criticalPriority: p.criticalPriority, timezone: TZ };
}

type ItemInput = Partial<PlanItem> & { id: string; duration: number };

export function item(i: ItemInput): PlanItem {
  const kind = i.kind ?? 'task';
  const priority = i.priority ?? 3;
  const locked = i.locked ?? kind === 'event';
  return {
    title: i.title ?? i.id,
    kind,
    locked,
    priority,
    deferrable: i.deferrable ?? (kind === 'break' ? false : priority < 4),
    critical: i.critical ?? false,
    blocking: i.blocking ?? true,
    ...i,
  } as PlanItem;
}

export function mkPlan(items: ItemInput[], s: PlanSettings = settings()): Plan {
  return { items: items.map(item), settings: s };
}

/** the scenario from the landing page: 4-9 pm, study 1h, practice 1h30, project 1h (due 8 pm), rest 30m. */
export function landingPlan(opts: Parameters<typeof settings>[0] = {}): Plan {
  return mkPlan(
    [
      { id: 'study', title: 'Study', duration: 60, start: at(16), priority: 3, release: at(16) },
      { id: 'practice', title: 'Practice', duration: 90, start: at(17), priority: 4, release: at(16) },
      { id: 'project', title: 'Project', duration: 60, start: at(18, 30), priority: 3, deadline: at(20), deferrable: false },
      { id: 'rest', title: 'Rest', kind: 'break', duration: 30, start: at(19, 30), priority: 5, release: at(16), deadline: at(21) },
    ],
    settings({ from: at(15), to: at(21), hours: ['15:00', '21:00'], ...opts }),
  );
}
