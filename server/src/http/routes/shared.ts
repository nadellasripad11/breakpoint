import type { Context } from 'hono';
import type { AppEnv } from '../context.ts';
import { notFound, unauthorized } from '../errors.ts';
import type { Preferences } from '../../engine/index.ts';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../../engine/index.ts';
import type { StoredItem } from '../../calendar/expand.ts';
import type { Schedule, User } from '../../store/types.ts';
import type { ItemCreate, PreferencesInput } from '../schemas.ts';

export function currentUser(c: Context<AppEnv>): User {
  const u = c.get('user');
  if (!u) throw unauthorized();
  return u;
}

/** Object-level authorization: a schedule is only ever loaded through its owner. Others get a plain 404. */
export async function loadSchedule(c: Context<AppEnv>, id: string): Promise<Schedule> {
  const u = currentUser(c);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Schedule');
  const s = await c.get('deps').store.getSchedule(u.id, id);
  if (!s) throw notFound('Schedule');
  return s;
}

/** Preferences as the engine needs them; the schedule's timezone is authoritative. */
export function schedulePrefs(s: Schedule): Preferences {
  return normalizePreferences({ ...s.preferences, timezone: s.timezone });
}

export function buildPreferences(input: PreferencesInput | undefined, timezone: string): Preferences {
  return normalizePreferences({
    ...DEFAULT_PREFERENCES,
    ...(input?.workingHours ? { workingHours: input.workingHours } : {}),
    ...(input?.protectedBreaks ? { protectedBreaks: input.protectedBreaks } : {}),
    ...(input?.categoryPriority ? { categoryPriority: input.categoryPriority } : {}),
    ...(input?.mobility ? { mobility: input.mobility } : {}),
    ...(input?.criticalPriority ? { criticalPriority: input.criticalPriority } : {}),
    timezone,
  });
}

export function toStored(input: ItemCreate, id: string, tz: string, source: StoredItem['source'] = 'manual'): StoredItem {
  return {
    id,
    kind: input.kind,
    title: input.title,
    start: input.start ?? null,
    durationMin: input.durationMin,
    allDay: input.allDay ?? false,
    timezone: input.timezone ?? tz,
    locked: input.locked ?? null,
    priority: input.priority ?? null,
    category: input.category ?? null,
    deadline: input.deadline ?? null,
    release: input.release ?? null,
    deferrable: input.deferrable ?? null,
    critical: input.critical ?? null,
    blocking: input.blocking ?? true,
    recurrence: input.recurrence ? { rrule: input.recurrence.rrule, exdates: input.recurrence.exdates ?? [] } : null,
    source,
    externalId: null,
  };
}

export const scheduleDto = (s: Schedule, itemCount?: number) => ({
  id: s.id,
  name: s.name,
  timezone: s.timezone,
  preferences: s.preferences,
  sourceScheduleId: s.sourceScheduleId,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  ...(itemCount !== undefined ? { itemCount } : {}),
});
