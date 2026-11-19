import type { ImportedItem } from '../calendar/ics.ts';
import { ImportError } from '../calendar/ics.ts';
import { isoToMin, minToZonedIso, zonedToMin } from '../engine/index.ts';
import type { Fetcher } from '../auth/google.ts';

/**
 * Notion READ-ONLY connector. Uses an internal integration token the user pastes after granting the integration
 * "Read content" only. The only POST requests made are /search and /databases/{id}/query, which are reads.
 */
const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const MAX_PAGES = 1000;

async function call(f: Fetcher, token: string, path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<Record<string, unknown>> {
  const res = await f(`${API}${path}`, {
    method: init.method,
    headers: { authorization: `Bearer ${token}`, 'notion-version': VERSION, 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (res.status === 401) throw new ImportError('notion_unauthorized', 'Notion rejected this token. Check the integration token and reconnect.');
  if (res.status === 403 || res.status === 404) throw new ImportError('notion_forbidden', 'That Notion database is not shared with your integration.');
  if (res.status === 429) throw new ImportError('notion_rate_limited', 'Notion is rate limiting requests. Try again in a minute.');
  if (!res.ok) throw new ImportError('notion_error', `Notion returned ${res.status}.`);
  return (await res.json()) as Record<string, unknown>;
}

export async function verifyToken(f: Fetcher, token: string): Promise<{ label: string }> {
  const j = await call(f, token, '/users/me', { method: 'GET' });
  const bot = j.bot as { workspace_name?: string } | undefined;
  return { label: String(bot?.workspace_name ?? j.name ?? 'Notion workspace').slice(0, 120) };
}

export interface NotionDatabase {
  id: string;
  title: string;
  properties: { name: string; type: string }[];
}

export async function listDatabases(f: Fetcher, token: string): Promise<NotionDatabase[]> {
  const j = await call(f, token, '/search', { method: 'POST', body: { filter: { property: 'object', value: 'database' }, page_size: 50 } });
  const results = Array.isArray(j.results) ? (j.results as Record<string, unknown>[]) : [];
  return results.map((d) => ({
    id: String(d.id),
    title: (Array.isArray(d.title) ? (d.title as { plain_text?: string }[]).map((t) => t.plain_text ?? '').join('') : '') || 'Untitled database',
    properties: Object.entries((d.properties ?? {}) as Record<string, { type?: string }>).map(([name, p]) => ({ name, type: String(p.type) })),
  }));
}

export interface NotionMapping {
  title?: string;
  /** a date property: becomes the hard deadline */
  date?: string;
  /** a number property: estimated minutes */
  duration?: string;
  /** a select/number property: High/Medium/Low or 1-5 */
  priority?: string;
  category?: string;
  /** a status/select/checkbox property that marks a task done (those are skipped) */
  status?: string;
  doneValues?: string[];
  defaultMinutes?: number;
}

type Prop = { type?: string; [k: string]: unknown };

const plain = (rt: unknown): string => (Array.isArray(rt) ? (rt as { plain_text?: string }[]).map((t) => t.plain_text ?? '').join('') : '');

function pickProp(props: Record<string, Prop>, name: string | undefined, type: string): [string, Prop] | null {
  if (name) return props[name] ? [name, props[name]!] : null;
  const hit = Object.entries(props).find(([, p]) => p.type === type);
  return hit ?? null;
}

function mapPriority(v: unknown): 1 | 2 | 3 | 4 | 5 | undefined {
  if (typeof v === 'number' && v >= 1 && v <= 5) return Math.round(v) as 1 | 2 | 3 | 4 | 5;
  if (typeof v !== 'string') return undefined;
  const t = v.toLowerCase();
  if (/urgent|critical|p0|highest/.test(t)) return 5;
  if (/high|p1/.test(t)) return 4;
  if (/medium|normal|p2/.test(t)) return 3;
  if (/low|p3/.test(t)) return 2;
  if (/lowest|someday|p4/.test(t)) return 1;
  const n = Number(t);
  return n >= 1 && n <= 5 ? (Math.round(n) as 1 | 2 | 3 | 4 | 5) : undefined;
}

export function mapNotionPages(pages: Record<string, unknown>[], mapping: NotionMapping, tz: string): { items: ImportedItem[]; skipped: number; warnings: string[] } {
  const items: ImportedItem[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  const done = new Set((mapping.doneValues ?? ['done', 'complete', 'completed', 'finished']).map((d) => d.toLowerCase()));
  for (const page of pages) {
    const props = (page.properties ?? {}) as Record<string, Prop>;
    if (page.archived === true || page.in_trash === true) {
      skipped++;
      continue;
    }
    const titleP = pickProp(props, mapping.title, 'title');
    const title = (titleP ? plain(titleP[1].title) : '').trim() || 'Untitled task';
    // done?
    const st = mapping.status ? props[mapping.status] : Object.values(props).find((p) => p.type === 'status');
    const stName = st?.type === 'status' ? (st.status as { name?: string } | null)?.name : st?.type === 'select' ? (st.select as { name?: string } | null)?.name : undefined;
    if (stName && done.has(stName.toLowerCase())) {
      skipped++;
      continue;
    }
    if (st?.type === 'checkbox' && st.checkbox === true) {
      skipped++;
      continue;
    }
    const dateP = pickProp(props, mapping.date, 'date');
    const date = dateP?.[1].date as { start?: string; end?: string | null } | null | undefined;
    let deadline: string | undefined;
    if (date?.start) {
      const raw = date.end ?? date.start;
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const [y, mo, d] = raw.split('-').map(Number) as [number, number, number];
        deadline = minToZonedIso(zonedToMin(y, mo, d, 23, 59, tz), tz); // a date-only due date means "by the end of that day"
      } else {
        try {
          deadline = minToZonedIso(isoToMin(raw), tz);
        } catch {
          warnings.push(`"${title.slice(0, 40)}": unreadable date.`);
        }
      }
    }
    const durP = mapping.duration ? props[mapping.duration] : undefined;
    const minutes = durP?.type === 'number' && typeof durP.number === 'number' && durP.number > 0 ? Math.min(Math.round(durP.number), 1440) : mapping.defaultMinutes ?? 60;
    const prP = mapping.priority ? props[mapping.priority] : undefined;
    const priority = prP?.type === 'select' ? mapPriority((prP.select as { name?: string } | null)?.name) : prP?.type === 'number' ? mapPriority(prP.number) : undefined;
    const catP = mapping.category ? props[mapping.category] : undefined;
    const category =
      catP?.type === 'select' ? (catP.select as { name?: string } | null)?.name : catP?.type === 'multi_select' ? (catP.multi_select as { name?: string }[])[0]?.name : undefined;
    items.push({
      externalId: String(page.id),
      kind: 'task',
      title: title.slice(0, 200),
      start: null,
      durationMin: minutes,
      allDay: false,
      timezone: tz,
      ...(deadline ? { deadline } : {}),
      ...(priority ? { priority } : {}),
      ...(category ? { category: category.slice(0, 60) } : {}),
      blocking: true,
    });
  }
  return { items, skipped, warnings };
}

export async function fetchDatabase(f: Fetcher, token: string, databaseId: string, mapping: NotionMapping, tz: string): Promise<{ items: ImportedItem[]; skipped: number; warnings: string[]; truncated: boolean }> {
  if (!/^[0-9a-fA-F-]{32,36}$/.test(databaseId)) throw new ImportError('invalid_database', 'That is not a valid Notion database id.');
  const pages: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let i = 0; i < 15; i++) {
    const j = await call(f, token, `/databases/${databaseId}/query`, { method: 'POST', body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } });
    pages.push(...(Array.isArray(j.results) ? (j.results as Record<string, unknown>[]) : []));
    if (pages.length >= MAX_PAGES) {
      truncated = true;
      break;
    }
    cursor = j.has_more === true && typeof j.next_cursor === 'string' ? j.next_cursor : undefined;
    if (!cursor) break;
  }
  return { ...mapNotionPages(pages.slice(0, MAX_PAGES), mapping, tz), truncated };
}
