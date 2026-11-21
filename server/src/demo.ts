import { localParts, minToZonedIso, zonedToMin } from './engine/index.ts';
import type { PreferencesInput } from './http/schemas.ts';

/**
 * the scenario from the landing page: "tomorrow, 4 pm - 9 pm".
 * study 1h, practice 1h30, project 1h (hard deadline 8 pm), rest 30m (protected break).
 * a 45-minute overrun on practice pushes project past its deadline; the breaking point is 30 minutes.
 */
export interface DemoItem {
  id: string;
  kind: 'event' | 'task' | 'break';
  title: string;
  start: string;
  durationMin: number;
  timezone: string;
  priority: 1 | 2 | 3 | 4 | 5;
  deadline?: string;
  release?: string;
  deferrable?: boolean;
  category?: string;
}

export interface DemoSchedule {
  name: string;
  date: string;
  timezone: string;
  preferences: PreferencesInput;
  items: DemoItem[];
  /** ready-made requests for the guest demo */
  try: Record<string, unknown>;
}

export function tomorrowIn(tz: string, now: Date): string {
  const p = localParts(Math.floor(now.getTime() / 60000), tz);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

export function demoSchedule(tz: string, date: string): DemoSchedule {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = (h: number, mi = 0) => minToZonedIso(zonedToMin(y, m, d, h, mi, tz), tz);
  const base = { timezone: tz } as const;
  return {
    name: 'Tomorrow, 4 PM - 9 PM',
    date,
    timezone: tz,
    preferences: { timezone: tz, workingHours: { start: '16:00', end: '21:00' }, mobility: 'balanced', categoryPriority: { school: 4, rest: 5 } },
    items: [
      { id: 'study', kind: 'task', title: 'Study', start: t(16), durationMin: 60, priority: 3, category: 'School', ...base },
      { id: 'practice', kind: 'task', title: 'Practice', start: t(17), durationMin: 90, priority: 4, category: 'School', deferrable: false, ...base },
      { id: 'project', kind: 'task', title: 'Project', start: t(18, 30), durationMin: 60, priority: 3, category: 'School', deadline: t(20), deferrable: false, ...base },
      { id: 'rest', kind: 'break', title: 'Rest', start: t(19, 30), durationMin: 30, priority: 5, release: t(16), deadline: t(21), ...base },
    ],
    try: {
      simulate: { window: { date }, disruptions: [{ type: 'overrun', targetId: 'practice', minutes: 45 }] },
      breakingPoint: { window: { date }, probe: { type: 'overrun', targetId: 'practice' }, mode: 'both', weakLinks: true },
      futures: { window: { date }, disruptions: [{ type: 'overrun', targetId: 'practice', minutes: 45 }] },
      chaos: { window: { date }, scenarios: 200, seed: 1 },
      fortify: { window: { date } },
    },
  };
}
