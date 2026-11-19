import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ZodType } from 'zod';
import type { AppEnv } from '../context.ts';
import { HttpError, notFound } from '../errors.ts';
import { rateLimit } from '../middleware.ts';
import {
  adoptBody, breakingPointBody, chaosBody, fortifyBody, futuresBody, inlineScheduleSchema, planBody, simulateBody, statelessWrap,
} from '../schemas.ts';
import { prepare, resolveHorizon, runEngine, toEngineDisruption } from '../engineService.ts';
import type { EngineKind, EngineRequest } from '../engineService.ts';
import { currentUser, loadSchedule, schedulePrefs, scheduleDto, toStored } from './shared.ts';
import { demoSchedule, tomorrowIn } from '../../demo.ts';
import { fortifyDay, isValidTimeZone, minToZonedIso, parallelFutures } from '../../engine/index.ts';
import type { StoredItem } from '../../calendar/expand.ts';
import type { RunKind } from '../../store/types.ts';
import type { PreferencesInput } from '../schemas.ts';
import { buildPreferences } from './shared.ts';
import { z } from 'zod';

const RUN_KIND: Record<Exclude<EngineKind, 'plan'>, RunKind> = { simulate: 'simulate', chaos: 'chaos', breaking_point: 'breaking_point', futures: 'futures', fortify: 'fortify' };

const ENGINE_ROUTES: { path: string; kind: EngineKind; schema: ZodType; heavy: boolean }[] = [
  { path: 'plan', kind: 'plan', schema: planBody, heavy: false },
  { path: 'simulate', kind: 'simulate', schema: simulateBody, heavy: false },
  { path: 'chaos', kind: 'chaos', schema: chaosBody, heavy: true },
  { path: 'breaking-point', kind: 'breaking_point', schema: breakingPointBody, heavy: true },
  { path: 'futures', kind: 'futures', schema: futuresBody, heavy: true },
  { path: 'fortify', kind: 'fortify', schema: fortifyBody, heavy: true },
];

type Body = { window: { date?: string; from?: string; to?: string }; save?: boolean } & EngineRequest;

/** Engine endpoints bound to a saved schedule. Running one NEVER modifies the schedule; `save: true` only stores a history record. */
export function engineRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  for (const route of ENGINE_ROUTES) {
    r.post(`/schedules/:id/${route.path}`, rateLimit(route.heavy ? 'engine-heavy' : 'engine', route.heavy ? 20 : 120, 60_000, 'user'), async (c) => {
      const deps = c.get('deps');
      const s = await loadSchedule(c, c.req.param('id'));
      const body = route.schema.parse(await c.req.json()) as Body;
      const prefs = schedulePrefs(s);
      const stored = await deps.store.listItems(s.id);
      const out = runEngine(route.kind, prepare(stored, prefs, resolveHorizon(body.window, prefs.timezone)), body);
      if (body.save && route.kind !== 'plan') {
        const { save: _s, ...request } = body;
        await deps.store.saveRun({ id: deps.newId(), scheduleId: s.id, userId: s.userId, kind: RUN_KIND[route.kind], request, result: out, createdAt: deps.now().toISOString() }, deps.config.limits.maxRunsPerSchedule);
      }
      return c.json(out);
    });
  }

  r.get('/schedules/:id/runs', async (c) => {
    const s = await loadSchedule(c, c.req.param('id'));
    return c.json({ runs: await c.get('deps').store.listRuns(s.userId, s.id, 50) });
  });
  r.get('/runs/:runId', async (c) => {
    const run = await c.get('deps').store.getRun(currentUser(c).id, c.req.param('runId'));
    if (!run) throw notFound('Run');
    return c.json({ run });
  });

  /**
   * "Adopt": turn a Parallel Future (or a Fortify proposal) into a NEW schedule. The original schedule and every external
   * calendar are left exactly as they were. Deferred tasks need the user's explicit confirmation and are kept (unscheduled), never deleted.
   */
  r.post('/schedules/:id/adopt', rateLimit('engine-heavy', 20, 60_000, 'user'), async (c) => {
    const deps = c.get('deps');
    const u = currentUser(c);
    const s = await loadSchedule(c, c.req.param('id'));
    const body = adoptBody.parse(await c.req.json());
    const cap = u.isGuest ? deps.config.limits.maxSchedulesGuest : deps.config.limits.maxSchedulesUser;
    if ((await deps.store.countSchedules(u.id)) >= cap) throw new HttpError(409, 'limit_exceeded', `You can have at most ${cap} schedules.`);
    const prefs = schedulePrefs(s);
    const prep = prepare(await deps.store.listItems(s.id), prefs, resolveHorizon(body.window, prefs.timezone));
    const tz = prefs.timezone;
    const plan = prep.plan;

    const placed = new Map<string, { start: number; end: number }>();
    const deferred: string[] = [];
    let label: string;
    const injected: { id: string; title: string; start: number; end: number }[] = [];
    if (body.source.kind === 'future') {
      const ds = (body.source.disruptions ?? []).map(toEngineDisruption);
      const res = parallelFutures(plan, ds);
      const f = res.futures.find((x) => x.strategy === (body.source as { strategy: string }).strategy)!;
      if (!f.feasible) throw new HttpError(409, 'no_feasible_plan', f.diagnosis!.summary, f.diagnosis);
      const accepted = new Set(body.acceptDeferrals ?? []);
      const unconfirmed = f.deferred.filter((d) => !accepted.has(d.id));
      if (unconfirmed.length) throw new HttpError(409, 'deferral_not_confirmed', 'This plan defers tasks. Confirm each one in `acceptDeferrals` to continue. Nothing has been created.', unconfirmed.map((d) => ({ id: d.id, title: d.title, message: d.message })));
      for (const i of f.items) {
        if (i.injected) injected.push({ id: i.id, title: i.title, start: i.start, end: i.end });
        else placed.set(i.id, { start: i.start, end: i.end });
      }
      deferred.push(...f.deferred.map((d) => d.id));
      label = f.title;
    } else {
      const res = fortifyDay(plan, { ...(body.source.maxChanges ? { maxChanges: body.source.maxChanges } : {}), ...(body.source.maxShiftMinutes ? { maxShiftMinutes: body.source.maxShiftMinutes } : {}) });
      for (const p of res.proposedStarts) placed.set(p.id, { start: p.start, end: p.end });
      label = 'Fortified';
    }

    const now = deps.now().toISOString();
    const copy = { id: deps.newId(), userId: u.id, name: body.name ?? `${s.name} (${label})`.slice(0, 100), timezone: s.timezone, preferences: { ...prefs, protectedBreaks: [] }, sourceScheduleId: s.id, createdAt: now, updatedAt: now };
    const toIso = (m: number) => minToZonedIso(m, tz);
    const items: StoredItem[] = [];
    for (const it of plan.items) {
      const p = placed.get(it.id);
      const isDeferred = deferred.includes(it.id);
      if (!p && !isDeferred && it.blocking) continue;
      items.push({
        id: deps.newId(), kind: it.kind, title: it.title,
        start: p ? toIso(p.start) : it.blocking ? null : it.start !== undefined ? toIso(it.start) : null,
        durationMin: p ? p.end - p.start : it.duration, allDay: false, timezone: tz,
        locked: it.locked, priority: it.priority, category: it.category ?? null,
        deadline: it.deadline !== undefined ? toIso(it.deadline) : null, release: it.release !== undefined ? toIso(it.release) : null,
        deferrable: it.deferrable, critical: it.critical, blocking: it.blocking, recurrence: null, source: 'manual', externalId: null,
      });
    }
    for (const inj of injected) {
      items.push({ id: deps.newId(), kind: 'event', title: inj.title, start: toIso(inj.start), durationMin: inj.end - inj.start, allDay: false, timezone: tz, locked: true, priority: 5, category: null, deadline: null, release: null, deferrable: false, critical: false, blocking: true, recurrence: null, source: 'manual', externalId: null });
    }
    await deps.store.createSchedule(copy);
    await deps.store.insertItems(copy.id, items, now, deps.config.limits.maxItemsPerSchedule);
    await deps.store.audit(u.id, 'schedule.adopt', { from: s.id, to: copy.id, kind: body.source.kind }, deps.newId(), now);
    return c.json({ schedule: scheduleDto(copy, items.length), originalScheduleUnchanged: true, deferredKept: deferred.length, note: 'A new schedule was created. Protected breaks are stored as concrete items in this copy. Your original schedule and calendars were not changed.' }, 201);
  });

  return r;
}

/* ───────────── stateless engine (guest demo: no login, nothing stored) ───────────── */

const statelessBodies: Record<string, ZodType> = {
  plan: statelessWrap(planBody),
  simulate: statelessWrap(simulateBody),
  chaos: statelessWrap(chaosBody),
  'breaking-point': statelessWrap(breakingPointBody),
  futures: statelessWrap(futuresBody),
  fortify: statelessWrap(fortifyBody),
};

export function statelessRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const small = bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: { code: 'too_large', message: 'Requests to /api/engine are limited to 512 KB.' } }, 413) });
  for (const route of ENGINE_ROUTES) {
    r.post(`/engine/${route.path}`, small, rateLimit(route.heavy ? 'stateless-heavy' : 'stateless', route.heavy ? 20 : 60, 60_000), async (c) => {
      const body = statelessBodies[route.path]!.parse(await c.req.json()) as Body & { schedule: z.infer<typeof inlineScheduleSchema> };
      const prefs = inlinePrefs(body.schedule.preferences);
      const stored: StoredItem[] = body.schedule.items.map((i) => ({ ...toStored(i, i.id, prefs.timezone, 'manual') }));
      const ids = new Set(stored.map((i) => i.id));
      if (ids.size !== stored.length) throw new HttpError(400, 'duplicate_ids', 'Item ids must be unique.');
      return c.json(runEngine(route.kind, prepare(stored, prefs, resolveHorizon(body.window, prefs.timezone)), body));
    });
  }
  return r;
}

function inlinePrefs(p: PreferencesInput | undefined) {
  const tz = p?.timezone ?? 'UTC';
  if (!isValidTimeZone(tz)) throw new HttpError(400, 'invalid_timezone', 'Unknown timezone.');
  return buildPreferences(p, tz);
}

/** Public demo data: the landing-page scenario, ready to POST to /api/engine/*. */
export function demoRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  /** What this server can do right now: lets the UI show the right connector states instead of guessing. */
  r.get('/capabilities', rateLimit('demo', 120, 60_000), (c) => {
    const deps = c.get('deps');
    return c.json({ ok: true, guest: true, ics: true, google: deps.config.google !== null, notion: true, accounts: deps.config.google !== null });
  });

  r.get('/demo/schedule', rateLimit('demo', 60, 60_000), (c) => {
    const deps = c.get('deps');
    const tzQ = c.req.query('tz');
    const tz = tzQ && isValidTimeZone(tzQ) ? tzQ : 'America/Chicago';
    const dateQ = c.req.query('date');
    const date = dateQ && /^\d{4}-\d{2}-\d{2}$/.test(dateQ) ? dateQ : tomorrowIn(tz, deps.now());
    const demo = demoSchedule(tz, date);
    return c.json({
      name: demo.name,
      date: demo.date,
      schedule: { preferences: demo.preferences, items: demo.items },
      try: Object.fromEntries(Object.entries(demo.try).map(([k, v]) => [k, { schedule: { preferences: demo.preferences, items: demo.items }, ...(v as object) }])),
      endpoints: { simulate: 'POST /api/engine/simulate', breakingPoint: 'POST /api/engine/breaking-point', futures: 'POST /api/engine/futures', chaos: 'POST /api/engine/chaos', fortify: 'POST /api/engine/fortify', plan: 'POST /api/engine/plan' },
    });
  });
  return r;
}
