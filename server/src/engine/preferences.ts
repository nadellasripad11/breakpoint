import type { Interval, Mobility, Plan, PlanItem, PlanSettings, Priority } from './types.ts';
import { PlanError } from './types.ts';
import { localDays, parseHHMM, zonedToMin, isValidTimeZone } from './time.ts';
import { mergeIntervals } from './intervals.ts';

/**
 * user preferences. these come from onboarding ("what matters most?", "how flexible is your schedule?")
 * plus working hours and protected breaks.
 */
export interface ProtectedBreak {
  id: string;
  title: string;
  durationMin: number;
  /** the break must happen between these local times, e.g. lunch between 12:00 and 14:00 */
  windowStart: string;
  windowEnd: string;
  /** 0 = sunday … 6 = saturday. default: every day. */
  days?: number[];
}

export interface WorkingHours {
  /** hh:mm, local time. "24:00" is allowed as an end. */
  start: string;
  end: string;
  /** 0 = sunday … 6 = saturday. default: every day. */
  days?: number[];
}

export interface Preferences {
  timezone: string;
  workingHours: WorkingHours;
  protectedBreaks: ProtectedBreak[];
  /** category name (case-insensitive) -> priority, e.g. { school: 5, fitness: 4 } */
  categoryPriority: Record<string, Priority>;
  mobility: Mobility;
  criticalPriority: Priority;
}

export const DEFAULT_PREFERENCES: Preferences = {
  timezone: 'UTC',
  workingHours: { start: '07:00', end: '23:00' },
  protectedBreaks: [],
  categoryPriority: {},
  mobility: 'balanced',
  criticalPriority: 4,
};

export function normalizePreferences(p: Partial<Preferences> | undefined): Preferences {
  const merged: Preferences = { ...DEFAULT_PREFERENCES, ...(p ?? {}) };
  if (!isValidTimeZone(merged.timezone)) throw new PlanError('invalid_timezone', `Unknown timezone: ${merged.timezone}`);
  parseHHMM(merged.workingHours.start);
  parseHHMM(merged.workingHours.end);
  if (parseHHMM(merged.workingHours.end) <= parseHHMM(merged.workingHours.start)) throw new PlanError('invalid_working_hours', 'Working hours must end after they start.');
  const cat: Record<string, Priority> = {};
  for (const [k, v] of Object.entries(merged.categoryPriority)) cat[k.toLowerCase()] = v;
  return { ...merged, categoryPriority: cat };
}

/** windows (merged, sorted) in which flexible work may be placed. */
export function buildAvailability(horizon: Interval, prefs: Preferences): Interval[] {
  const wh = prefs.workingHours;
  const days = new Set(wh.days ?? [0, 1, 2, 3, 4, 5, 6]);
  const out: Interval[] = [];
  const s = parseHHMM(wh.start);
  const e = parseHHMM(wh.end);
  for (const day of localDays(horizon, prefs.timezone)) {
    if (!days.has(day.weekday)) continue;
    const start = zonedToMin(day.y, day.mo, day.d, Math.floor(s / 60), s % 60, prefs.timezone);
    const end = e === 1440 ? zonedToMin(day.y, day.mo, day.d + 1, 0, 0, prefs.timezone) : zonedToMin(day.y, day.mo, day.d, Math.floor(e / 60), e % 60, prefs.timezone);
    const clipped = { start: Math.max(start, horizon.start), end: Math.min(end, horizon.end) };
    if (clipped.end > clipped.start) out.push(clipped);
  }
  return mergeIntervals(out);
}

/** one flexible, non-deferrable break item per local day inside the horizon. unscheduled: the baseline places them. */
export function expandProtectedBreaks(horizon: Interval, prefs: Preferences): PlanItem[] {
  const out: PlanItem[] = [];
  for (const b of prefs.protectedBreaks) {
    const days = new Set(b.days ?? [0, 1, 2, 3, 4, 5, 6]);
    const ws = parseHHMM(b.windowStart);
    const we = parseHHMM(b.windowEnd);
    if (b.durationMin <= 0 || we - ws < b.durationMin) throw new PlanError('invalid_break', `Protected break "${b.title}" does not fit inside its own window.`);
    for (const day of localDays(horizon, prefs.timezone)) {
      if (!days.has(day.weekday)) continue;
      const release = zonedToMin(day.y, day.mo, day.d, Math.floor(ws / 60), ws % 60, prefs.timezone);
      const deadline = zonedToMin(day.y, day.mo, day.d, Math.floor(we / 60), we % 60, prefs.timezone);
      if (deadline <= horizon.start || release >= horizon.end) continue;
      const ymd = `${day.y}-${String(day.mo).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
      out.push({
        id: `break:${b.id}:${ymd}`,
        title: b.title,
        kind: 'break',
        duration: b.durationMin,
        locked: false,
        priority: 5,
        release,
        deadline,
        deferrable: false,
        critical: false,
        blocking: true,
        origin: { source: 'preferences', baseId: b.id },
      });
    }
  }
  return out;
}

export function settingsFor(horizon: Interval, prefs: Preferences): PlanSettings {
  return {
    horizon,
    availability: buildAvailability(horizon, prefs),
    mobility: prefs.mobility,
    criticalPriority: prefs.criticalPriority,
    timezone: prefs.timezone,
  };
}

export function resolvePriority(explicit: Priority | null | undefined, category: string | undefined, prefs: Preferences): Priority {
  if (explicit) return explicit;
  if (category) {
    const p = prefs.categoryPriority[category.toLowerCase()];
    if (p) return p;
  }
  return 3;
}

export function makePlan(items: PlanItem[], settings: PlanSettings): Plan {
  return { items, settings };
}
