import type { ImportedItem } from '../calendar/ics.ts';
import { ImportError } from '../calendar/ics.ts';
import { isoToMin, minToZonedIso } from '../engine/index.ts';
import type { Fetcher } from '../auth/google.ts';

/**
 * Google Calendar READ-ONLY connector. Only GET requests are ever made, with the calendar.readonly scope.
 * Breakpoint never creates, edits or deletes anything in Google Calendar.
 */
const API = 'https://www.googleapis.com/calendar/v3';
const MAX_EVENTS = 2000;

export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  timezone: string | null;
}

async function get(f: Fetcher, url: string, accessToken: string): Promise<Record<string, unknown>> {
  const res = await f(url, { method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
  if (res.status === 401) throw new ImportError('google_unauthorized', 'Google rejected the stored access. Reconnect Google Calendar.');
  if (res.status === 403 || res.status === 404) throw new ImportError('google_forbidden', 'That calendar is not available to this connection.');
  if (!res.ok) throw new ImportError('google_error', `Google Calendar returned ${res.status}.`);
  return (await res.json()) as Record<string, unknown>;
}

export async function listCalendars(f: Fetcher, accessToken: string): Promise<CalendarInfo[]> {
  const j = await get(f, `${API}/users/me/calendarList?minAccessRole=reader&maxResults=100&fields=items(id,summary,primary,timeZone)`, accessToken);
  const items = Array.isArray(j.items) ? (j.items as Record<string, unknown>[]) : [];
  return items.map((c) => ({ id: String(c.id), name: String(c.summary ?? c.id), primary: c.primary === true, timezone: typeof c.timeZone === 'string' ? c.timeZone : null }));
}

interface GEvent {
  id?: string;
  status?: string;
  summary?: string;
  transparency?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
}

/** Maps Google events to ImportedItems. Recurring events arrive already expanded (singleEvents=true). */
export function mapGoogleEvents(events: GEvent[], defaultTz: string, opts: { allDayBlocks?: boolean } = {}): { items: ImportedItem[]; skipped: number } {
  const items: ImportedItem[] = [];
  let skipped = 0;
  for (const e of events) {
    if (!e.id || e.status === 'cancelled' || !e.start) {
      skipped++;
      continue;
    }
    const title = (e.summary?.trim() || 'Busy').slice(0, 200);
    const transparent = e.transparency === 'transparent';
    if (e.start.date) {
      const startMin = isoToMin(`${e.start.date}T00:00:00Z`);
      const endMin = e.end?.date ? isoToMin(`${e.end.date}T00:00:00Z`) : startMin + 1440;
      items.push({
        externalId: e.id,
        kind: 'event',
        title,
        start: minToZonedIso(startMin, 'UTC').replace('+00:00', '+00:00'),
        durationMin: Math.max(1440, endMin - startMin),
        allDay: true,
        timezone: defaultTz,
        blocking: !transparent && opts.allDayBlocks === true,
      });
      continue;
    }
    if (!e.start.dateTime || !e.end?.dateTime) {
      skipped++;
      continue;
    }
    const tz = e.start.timeZone ?? defaultTz;
    const s = isoToMin(e.start.dateTime);
    const en = isoToMin(e.end.dateTime);
    items.push({ externalId: e.id, kind: 'event', title, start: minToZonedIso(s, tz), durationMin: Math.max(1, en - s), allDay: false, timezone: tz, blocking: !transparent });
  }
  return { items, skipped };
}

export async function fetchEvents(f: Fetcher, accessToken: string, calendarId: string, window: { from: string; to: string }, defaultTz: string): Promise<{ items: ImportedItem[]; skipped: number; truncated: boolean }> {
  const events: GEvent[] = [];
  let pageToken: string | undefined;
  let truncated = false;
  for (let page = 0; page < 20; page++) {
    const u = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`);
    u.searchParams.set('singleEvents', 'true');
    u.searchParams.set('orderBy', 'startTime');
    u.searchParams.set('timeMin', window.from);
    u.searchParams.set('timeMax', window.to);
    u.searchParams.set('maxResults', '250');
    // ask only for what planning needs (no descriptions, attendees, links or locations)
    u.searchParams.set('fields', 'nextPageToken,items(id,status,summary,transparency,start,end)');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const j = await get(f, u.toString(), accessToken);
    events.push(...(Array.isArray(j.items) ? (j.items as GEvent[]) : []));
    if (events.length >= MAX_EVENTS) {
      truncated = true;
      break;
    }
    pageToken = typeof j.nextPageToken === 'string' ? j.nextPageToken : undefined;
    if (!pageToken) break;
  }
  const mapped = mapGoogleEvents(events.slice(0, MAX_EVENTS), defaultTz);
  return { ...mapped, truncated };
}
