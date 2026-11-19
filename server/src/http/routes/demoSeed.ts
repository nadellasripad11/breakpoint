import type { Deps } from '../context.ts';
import { demoSchedule, tomorrowIn } from '../../demo.ts';
import { isValidTimeZone, normalizePreferences } from '../../engine/index.ts';
import type { StoredItem } from '../../calendar/expand.ts';

/** Creates the landing-page demo as a real saved schedule (used for guests). Returns the schedule id. */
export async function seedDemoSchedule(deps: Deps, userId: string, tzParam: string | undefined): Promise<string> {
  const tz = tzParam && isValidTimeZone(tzParam) ? tzParam : 'America/Chicago';
  const demo = demoSchedule(tz, tomorrowIn(tz, deps.now()));
  const now = deps.now().toISOString();
  const prefs = normalizePreferences({ timezone: tz, workingHours: demo.preferences.workingHours!, mobility: 'balanced', categoryPriority: demo.preferences.categoryPriority ?? {} });
  const id = deps.newId();
  await deps.store.createSchedule({ id, userId, name: demo.name, timezone: tz, preferences: prefs, sourceScheduleId: null, createdAt: now, updatedAt: now });
  const items: StoredItem[] = demo.items.map((i) => ({
    id: deps.newId(),
    kind: i.kind,
    title: i.title,
    start: i.start,
    durationMin: i.durationMin,
    allDay: false,
    timezone: tz,
    locked: null,
    priority: i.priority,
    category: i.category ?? null,
    deadline: i.deadline ?? null,
    release: i.release ?? null,
    deferrable: i.deferrable ?? null,
    critical: null,
    blocking: true,
    recurrence: null,
    source: 'demo',
    externalId: i.id,
  }));
  await deps.store.insertItems(id, items, now, deps.config.limits.maxItemsPerSchedule);
  return id;
}
