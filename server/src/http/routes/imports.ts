import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import type { AppEnv } from '../context.ts';
import { notFound } from '../errors.ts';
import { rateLimit, requireAccount } from '../middleware.ts';
import { googleImportBody, icsImportBody, icsLinkBody, notionImportBody } from '../schemas.ts';
import { currentUser, loadSchedule } from './shared.ts';
import { googleAccessToken, notionToken } from './connections.ts';
import { parseIcs } from '../../calendar/ics.ts';
import { fetchCalendarLink, normalizeCalendarLink, trimOldEvents } from '../../calendar/link.ts';
import type { ImportedItem } from '../../calendar/ics.ts';
import { fetchEvents } from '../../integrations/googleCalendar.ts';
import { fetchDatabase } from '../../integrations/notion.ts';
import type { Schedule } from '../../store/types.ts';

/**
 * imports are read-only copies into the user's own breakpoint schedule. nothing is ever written back to the source.
 * re-importing is idempotent. items that disappeared from the source are reported as `missing` and kept.
 */
async function commit(c: Context<AppEnv>, s: Schedule, source: 'ics' | 'google' | 'notion', items: ImportedItem[], extra: { connectionId: string | null; consentAt: string; skipped: number; warnings: string[]; dryRun: boolean; truncated?: boolean }) {
  const deps = c.get('deps');
  const preview = items.slice(0, 50).map((i) => ({ externalId: i.externalId, kind: i.kind, title: i.title, start: i.start, durationMin: i.durationMin, allDay: i.allDay, blocking: i.blocking, recurring: !!i.recurrence, deadline: i.deadline ?? null }));
  if (extra.dryRun) return c.json({ dryRun: true, wouldImport: items.length, skipped: extra.skipped, warnings: extra.warnings, truncated: extra.truncated ?? false, preview });
  const res = await deps.store.upsertImported(s.id, source, items, deps.now().toISOString(), deps.config.limits.maxItemsPerSchedule, deps.newId);
  await deps.store.recordImport({
    id: deps.newId(),
    scheduleId: s.id,
    userId: s.userId,
    source,
    connectionId: extra.connectionId,
    consentAt: extra.consentAt,
    createdCount: res.created,
    updatedCount: res.updated,
    missingCount: res.missing.length,
    warnings: extra.warnings,
    createdAt: deps.now().toISOString(),
  });
  return c.json(
    {
      imported: { created: res.created, updated: res.updated },
      missing: res.missing,
      skipped: extra.skipped,
      warnings: extra.warnings,
      truncated: extra.truncated ?? false,
      note: res.missing.length ? 'Items that are no longer in the source were kept. Delete them yourself if you want them gone.' : undefined,
    },
    200,
  );
}

export function importRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const big = bodyLimit({ maxSize: 2.5 * 1024 * 1024, onError: (c) => c.json({ error: { code: 'too_large', message: 'Calendar files are limited to 2 MB.' } }, 413) });

  /** .ics: the file is sent by the user's own browser. (the only url the server ever fetches is a calendar link, below.) */
  r.post('/:id/import/ics', big, rateLimit('import', 20, 3_600_000, 'user'), async (c) => {
    const s = await loadSchedule(c, c.req.param('id'));
    const body = icsImportBody.parse(await c.req.json());
    const parsed = parseIcs(body.ics, { defaultTimezone: body.defaultTimezone ?? s.timezone, allDayBlocks: body.allDayBlocks ?? false, defaultTaskMinutes: body.defaultTaskMinutes ?? 60 });
    return commit(c, s, 'ics', parsed.items, { connectionId: null, consentAt: c.get('deps').now().toISOString(), skipped: 0, warnings: parsed.warnings, dryRun: body.dryRun ?? false });
  });

  /**
   * a calendar link (google "secret address in ical format", icloud public calendar): no oauth app and no verification needed.
   * the server fetches it once from an allow-listed calendar host (see calendar/link.ts) and never stores, logs or echoes it.
   */
  r.post('/:id/import/link', bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: { code: 'too_large', message: 'That link is too long.' } }, 413) }), rateLimit('import', 20, 3_600_000, 'user'), async (c) => {
    const deps = c.get('deps');
    const s = await loadSchedule(c, c.req.param('id'));
    const body = icsLinkBody.parse(await c.req.json());
    const url = normalizeCalendarLink(body.url, body.provider);
    const raw = await fetchCalendarLink(deps.fetch, url, body.provider ? { provider: body.provider } : {});
    const cutoff = new Date(deps.now().getTime() - 30 * 86_400_000);
    const ymd = `${cutoff.getUTCFullYear()}${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}${String(cutoff.getUTCDate()).padStart(2, '0')}`;
    const { text, dropped } = trimOldEvents(raw, ymd);
    const parsed = parseIcs(text, { defaultTimezone: body.defaultTimezone ?? s.timezone, allDayBlocks: body.allDayBlocks ?? false, defaultTaskMinutes: body.defaultTaskMinutes ?? 60 });
    const warnings = [...(dropped ? [`${dropped} ${dropped === 1 ? 'event' : 'events'} from before the last 30 days ${dropped === 1 ? 'was' : 'were'} left out.`] : []), ...parsed.warnings];
    return commit(c, s, 'ics', parsed.items, { connectionId: null, consentAt: deps.now().toISOString(), skipped: 0, warnings, dryRun: body.dryRun ?? false });
  });

  r.post('/:id/import/google', requireAccount(), rateLimit('import', 20, 3_600_000, 'user'), async (c) => {
    const deps = c.get('deps');
    const s = await loadSchedule(c, c.req.param('id'));
    const body = googleImportBody.parse(await c.req.json());
    const conn = await deps.store.getConnection(currentUser(c).id, body.connectionId);
    if (!conn || conn.provider !== 'google') throw notFound('Connection');
    const token = await googleAccessToken(deps, conn);
    const res = await fetchEvents(deps.fetch, token, body.calendarId, { from: body.from, to: body.to }, s.timezone);
    return commit(c, s, 'google', res.items, { connectionId: conn.id, consentAt: conn.consentAt, skipped: res.skipped, warnings: res.truncated ? ['Only the first 2000 events were read.'] : [], dryRun: body.dryRun ?? false, truncated: res.truncated });
  });

  r.post('/:id/import/notion', rateLimit('import', 20, 3_600_000, 'user'), async (c) => {
    const deps = c.get('deps');
    const s = await loadSchedule(c, c.req.param('id'));
    const body = notionImportBody.parse(await c.req.json());
    const conn = await deps.store.getConnection(currentUser(c).id, body.connectionId);
    if (!conn || conn.provider !== 'notion') throw notFound('Connection');
    const res = await fetchDatabase(deps.fetch, notionToken(deps, conn), body.databaseId, body.mapping, s.timezone);
    return commit(c, s, 'notion', res.items, { connectionId: conn.id, consentAt: conn.consentAt, skipped: res.skipped, warnings: [...res.warnings, ...(res.truncated ? ['Only the first 1000 pages were read.'] : [])], dryRun: body.dryRun ?? false, truncated: res.truncated });
  });

  return r;
}
