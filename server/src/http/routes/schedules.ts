import { Hono } from 'hono';
import type { AppEnv } from '../context.ts';
import { HttpError, badRequest, notFound } from '../errors.ts';
import { itemPatchSchema, itemsBody, preferencesSchema, scheduleCreateSchema, schedulePatchSchema } from '../schemas.ts';
import { buildPreferences, currentUser, loadSchedule, scheduleDto, toStored } from './shared.ts';
import type { StoredItem } from '../../calendar/expand.ts';
import { itemCreateSchema } from '../schemas.ts';

export function scheduleRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const u = currentUser(c);
    const list = await c.get('deps').store.listSchedules(u.id);
    return c.json({ schedules: list.map((s) => scheduleDto(s, s.itemCount)) });
  });

  r.post('/', async (c) => {
    const deps = c.get('deps');
    const u = currentUser(c);
    const body = scheduleCreateSchema.parse(await c.req.json());
    const cap = u.isGuest ? deps.config.limits.maxSchedulesGuest : deps.config.limits.maxSchedulesUser;
    if ((await deps.store.countSchedules(u.id)) >= cap) throw new HttpError(409, 'limit_exceeded', `You can have at most ${cap} schedules${u.isGuest ? ' as a guest. Sign in to save more' : ''}.`);
    const tz = body.timezone ?? body.preferences?.timezone ?? 'UTC';
    const now = deps.now().toISOString();
    const s = { id: deps.newId(), userId: u.id, name: body.name, timezone: tz, preferences: buildPreferences(body.preferences, tz), sourceScheduleId: null, createdAt: now, updatedAt: now };
    await deps.store.createSchedule(s);
    return c.json({ schedule: scheduleDto(s, 0) }, 201);
  });

  r.get('/:id', async (c) => {
    const s = await loadSchedule(c, c.req.param('id'));
    const items = await c.get('deps').store.listItems(s.id);
    return c.json({ schedule: scheduleDto(s, items.length) });
  });

  r.patch('/:id', async (c) => {
    const deps = c.get('deps');
    const s = await loadSchedule(c, c.req.param('id'));
    const body = schedulePatchSchema.parse(await c.req.json());
    const tz = body.timezone ?? s.timezone;
    const prefs = body.preferences ? buildPreferences(body.preferences, tz) : body.timezone ? buildPreferences({ ...s.preferences } as never, tz) : undefined;
    await deps.store.updateSchedule(s.userId, s.id, { ...(body.name ? { name: body.name } : {}), ...(body.timezone ? { timezone: body.timezone } : {}), ...(prefs ? { preferences: prefs } : {}) }, deps.now().toISOString());
    return c.json({ schedule: scheduleDto((await deps.store.getSchedule(s.userId, s.id))!) });
  });

  /** replaces the preferences (priorities, flexibility, working hours, protected breaks). */
  r.put('/:id/preferences', async (c) => {
    const deps = c.get('deps');
    const s = await loadSchedule(c, c.req.param('id'));
    const body = preferencesSchema.parse(await c.req.json());
    const prefs = buildPreferences(body, s.timezone);
    await deps.store.updateSchedule(s.userId, s.id, { preferences: prefs }, deps.now().toISOString());
    return c.json({ preferences: prefs });
  });

  r.delete('/:id', async (c) => {
    const s = await loadSchedule(c, c.req.param('id'));
    await c.get('deps').store.deleteSchedule(s.userId, s.id);
    return c.body(null, 204);
  });

  /* ───────────── items ───────────── */

  r.get('/:id/items', async (c) => {
    const s = await loadSchedule(c, c.req.param('id'));
    return c.json({ items: await c.get('deps').store.listItems(s.id) });
  });

  r.post('/:id/items', async (c) => {
    const deps = c.get('deps');
    const s = await loadSchedule(c, c.req.param('id'));
    const parsed = itemsBody.parse(await c.req.json());
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const stored: StoredItem[] = list.map((i) => toStored(i, deps.newId(), s.timezone));
    await deps.store.insertItems(s.id, stored, deps.now().toISOString(), deps.config.limits.maxItemsPerSchedule);
    return c.json({ items: stored }, 201);
  });

  r.patch('/:id/items/:itemId', async (c) => {
    const deps = c.get('deps');
    const s = await loadSchedule(c, c.req.param('id'));
    const existing = await deps.store.getItem(s.id, c.req.param('itemId'));
    if (!existing) throw notFound('Item');
    const patch = itemPatchSchema.parse(await c.req.json());
    const merged = {
      kind: patch.kind ?? existing.kind,
      title: patch.title ?? existing.title,
      start: patch.start !== undefined ? patch.start : existing.start,
      durationMin: patch.durationMin ?? existing.durationMin,
      allDay: patch.allDay ?? existing.allDay,
      timezone: patch.timezone ?? existing.timezone,
      locked: patch.locked !== undefined ? patch.locked : existing.locked,
      priority: patch.priority !== undefined ? patch.priority : existing.priority,
      category: patch.category !== undefined ? patch.category : existing.category,
      deadline: patch.deadline !== undefined ? patch.deadline : existing.deadline,
      release: patch.release !== undefined ? patch.release : existing.release,
      deferrable: patch.deferrable !== undefined ? patch.deferrable : existing.deferrable,
      critical: patch.critical !== undefined ? patch.critical : existing.critical,
      blocking: patch.blocking ?? existing.blocking,
      recurrence: patch.recurrence !== undefined ? patch.recurrence : existing.recurrence,
    };
    const validated = itemCreateSchema.safeParse(merged);
    if (!validated.success) throw badRequest('validation_error', 'The updated item is not valid.', validated.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })));
    const next: StoredItem = { ...existing, ...toStored(validated.data, existing.id, s.timezone, existing.source), source: existing.source, externalId: existing.externalId };
    await deps.store.updateItem(s.id, existing.id, next, deps.now().toISOString());
    return c.json({ item: next });
  });

  r.delete('/:id/items/:itemId', async (c) => {
    const s = await loadSchedule(c, c.req.param('id'));
    if (!(await c.get('deps').store.deleteItem(s.id, c.req.param('itemId')))) throw notFound('Item');
    return c.body(null, 204);
  });

  return r;
}
