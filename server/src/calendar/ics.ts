import { isValidTimeZone, minToZonedIso, zonedToMin } from '../engine/index.ts';

/**
 * Read-only .ics (RFC 5545) parser. It only READS text it is given; it never fetches URLs and never writes anywhere.
 * Hardened: size and count limits, bounded loops, no recursion, unknown properties ignored.
 */

export class ImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

export interface ImportedItem {
  externalId: string;
  kind: 'event' | 'task';
  title: string;
  /** ISO 8601 with offset; null for tasks that only have a due date */
  start: string | null;
  durationMin: number;
  allDay: boolean;
  timezone: string;
  recurrence?: { rrule: string; exdates: string[] };
  /** tasks: due date (hard deadline) */
  deadline?: string;
  /** tasks: earliest start */
  release?: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  category?: string;
  /** false for all-day banners and "free" (transparent) events */
  blocking: boolean;
}

export interface ParsedCalendar {
  items: ImportedItem[];
  warnings: string[];
  calendarName?: string;
}

export interface IcsOptions {
  /** used for floating times and unknown TZIDs */
  defaultTimezone?: string;
  defaultTaskMinutes?: number;
  /** all-day events block the day (default false: they are banners) */
  allDayBlocks?: boolean;
}

export const MAX_ICS_BYTES = 2 * 1024 * 1024;
export const MAX_COMPONENTS = 5000;

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** A handful of Windows time zone names Outlook exports. */
const WINDOWS_TZ: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  UTC: 'UTC',
};

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line: string): Prop | null {
  if (!line || line.length > 8192) return null;
  // split name;params from value at the first colon that is not inside quotes
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs: string[] = [];
  let cur = '';
  inQuote = false;
  for (const ch of head) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ';' && !inQuote) {
      segs.push(cur);
      cur = '';
    } else cur += ch;
  }
  segs.push(cur);
  const name = segs[0]!.toUpperCase();
  const params: Record<string, string> = {};
  for (const s of segs.slice(1)) {
    const eq = s.indexOf('=');
    if (eq > 0) params[s.slice(0, eq).toUpperCase()] = s.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

const unescapeText = (v: string) => v.replace(/\\[nN]/g, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();

function resolveTz(tzid: string | undefined, fallback: string, warn: (m: string) => void): string {
  if (!tzid) return fallback;
  if (isValidTimeZone(tzid)) return tzid;
  const w = WINDOWS_TZ[tzid];
  if (w) return w;
  warn(`Unknown time zone "${tzid.slice(0, 60)}"; used ${fallback} instead.`);
  return fallback;
}

interface When {
  min: number;
  allDay: boolean;
  tz: string;
  local: { y: number; mo: number; d: number; h: number; mi: number };
}

function parseWhen(p: Prop, fallbackTz: string, warn: (m: string) => void): When | null {
  const v = p.value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    const [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
    return { min: zonedToMin(y, mo, d, 0, 0, fallbackTz), allDay: true, tz: fallbackTz, local: { y, mo, d, h: 0, mi: 0 } };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  if (m[7] === 'Z') {
    const min = Math.round(Date.UTC(y, mo - 1, d, h, mi) / 60000);
    return { min, allDay: false, tz: 'UTC', local: { y, mo, d, h, mi } };
  }
  const tz = resolveTz(p.params.TZID, fallbackTz, warn);
  return { min: zonedToMin(y, mo, d, h, mi, tz), allDay: false, tz, local: { y, mo, d, h, mi } };
}

function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const mins = (+(m[2] ?? 0)) * 7 * 1440 + (+(m[3] ?? 0)) * 1440 + (+(m[4] ?? 0)) * 60 + (+(m[5] ?? 0)) + Math.round((+(m[6] ?? 0)) / 60);
  return m[1] === '-' ? -mins : mins;
}

/** RFC 5545 PRIORITY: 1 (highest) .. 9 (lowest), 0 = undefined. */
function mapPriority(v: string | undefined): 1 | 2 | 3 | 4 | 5 | undefined {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 9) return undefined;
  return n <= 2 ? 5 : n <= 4 ? 4 : n === 5 ? 3 : n <= 7 ? 2 : 1;
}

interface RawComponent {
  type: 'VEVENT' | 'VTODO';
  props: Prop[];
}

export function parseIcs(text: string, opts: IcsOptions = {}): ParsedCalendar {
  if (typeof text !== 'string') throw new ImportError('invalid_input', 'The calendar must be text.');
  if (text.length > MAX_ICS_BYTES) throw new ImportError('too_large', `Calendar files are limited to ${MAX_ICS_BYTES / 1024 / 1024} MB.`);
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new ImportError('not_ics', 'This does not look like an .ics calendar (no BEGIN:VCALENDAR).');
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (m: string) => {
    if (!warned.has(m) && warnings.length < 50) {
      warned.add(m);
      warnings.push(m);
    }
  };
  const defaultTz = opts.defaultTimezone && isValidTimeZone(opts.defaultTimezone) ? opts.defaultTimezone : 'UTC';
  const taskMin = opts.defaultTaskMinutes ?? 60;

  const lines = unfold(text);
  const comps: RawComponent[] = [];
  let cur: RawComponent | null = null;
  let skipDepth = 0;
  let calName: string | undefined;
  let calTz: string | undefined;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const t = p.value.toUpperCase();
      if (skipDepth > 0) skipDepth++;
      else if (t === 'VEVENT' || t === 'VTODO') {
        if (comps.length >= MAX_COMPONENTS) throw new ImportError('too_many_items', `Calendars are limited to ${MAX_COMPONENTS} events/tasks.`);
        cur = { type: t, props: [] };
      } else if (t !== 'VCALENDAR') skipDepth = 1; // VTIMEZONE, VALARM, VJOURNAL, ...
      continue;
    }
    if (p.name === 'END') {
      const t = p.value.toUpperCase();
      if (skipDepth > 0) skipDepth--;
      else if (cur && t === cur.type) {
        comps.push(cur);
        cur = null;
      }
      continue;
    }
    if (skipDepth > 0) continue;
    if (cur) cur.props.push(p);
    else if (p.name === 'X-WR-CALNAME') calName = unescapeText(p.value).slice(0, 120);
    else if (p.name === 'X-WR-TIMEZONE' && isValidTimeZone(p.value)) calTz = p.value;
  }
  const fallbackTz = calTz ?? defaultTz;

  const masters: ImportedItem[] = [];
  const overrides: { uid: string; recurrenceId: number; item: ImportedItem }[] = [];
  const seen = new Set<string>();

  for (const c of comps) {
    const get = (n: string) => c.props.find((p) => p.name === n);
    const all = (n: string) => c.props.filter((p) => p.name === n);
    const status = get('STATUS')?.value.toUpperCase();
    if (status === 'CANCELLED') continue;
    const title = (unescapeText(get('SUMMARY')?.value ?? '') || 'Untitled').slice(0, 200);
    const uid = (get('UID')?.value ?? '').trim().slice(0, 200);
    const category = unescapeText(get('CATEGORIES')?.value.split(',')[0] ?? '').slice(0, 60) || undefined;
    const priority = mapPriority(get('PRIORITY')?.value);

    if (c.type === 'VTODO') {
      if (status === 'COMPLETED' || get('PERCENT-COMPLETE')?.value === '100') continue;
      const due = get('DUE') ? parseWhen(get('DUE')!, fallbackTz, warn) : null;
      const dtstart = get('DTSTART') ? parseWhen(get('DTSTART')!, fallbackTz, warn) : null;
      const dur = get('DURATION') ? parseDuration(get('DURATION')!.value) : null;
      const tz = due?.tz ?? dtstart?.tz ?? fallbackTz;
      const id = uid || `todo:${title}:${due?.min ?? ''}`;
      if (seen.has(id)) {
        warn(`Duplicate task id skipped: ${id.slice(0, 40)}`);
        continue;
      }
      seen.add(id);
      masters.push({
        externalId: id,
        kind: 'task',
        title,
        start: null,
        durationMin: dur && dur > 0 ? dur : taskMin,
        allDay: false,
        timezone: tz,
        ...(due ? { deadline: minToZonedIso(due.allDay ? due.min + 1439 : due.min, tz) } : {}),
        ...(dtstart ? { release: minToZonedIso(dtstart.min, tz) } : {}),
        ...(priority ? { priority } : {}),
        ...(category ? { category } : {}),
        blocking: true,
      });
      continue;
    }

    const ds = get('DTSTART');
    const start = ds ? parseWhen(ds, fallbackTz, warn) : null;
    if (!start) {
      warn(`Skipped an event without a readable start time ("${title.slice(0, 40)}").`);
      continue;
    }
    if (ds && !ds.params.TZID && !/Z$/.test(ds.value.trim()) && !start.allDay) warn(`Floating times were read in ${fallbackTz}.`);
    let durationMin: number;
    const de = get('DTEND') ? parseWhen(get('DTEND')!, fallbackTz, warn) : null;
    const du = get('DURATION') ? parseDuration(get('DURATION')!.value) : null;
    if (de) durationMin = Math.max(0, de.min - start.min);
    else if (du !== null) durationMin = Math.max(0, du);
    else durationMin = start.allDay ? 1440 : 0;
    if (!start.allDay && durationMin === 0) {
      durationMin = 30;
      warn('Events with no end time were given 30 minutes.');
    }
    if (durationMin > 14 * 1440) {
      warn(`"${title.slice(0, 40)}" is longer than 14 days and was treated as an all-day banner.`);
    }
    const transparent = get('TRANSP')?.value.toUpperCase() === 'TRANSPARENT';
    const blocking = !transparent && (start.allDay ? opts.allDayBlocks === true : true) && durationMin <= 14 * 1440;
    const id = uid || `event:${title}:${start.min}`;
    const rr = get('RRULE');
    const exdates: string[] = [];
    for (const ex of all('EXDATE')) {
      for (const v of ex.value.split(',')) {
        const w = parseWhen({ ...ex, value: v }, fallbackTz, warn);
        if (w) exdates.push(minToZonedIso(w.min, start.tz));
      }
    }
    const item: ImportedItem = {
      externalId: id,
      kind: 'event',
      title,
      start: minToZonedIso(start.min, start.tz),
      durationMin,
      allDay: start.allDay,
      timezone: start.tz,
      ...(rr ? { recurrence: { rrule: rr.value.trim(), exdates } } : {}),
      ...(priority ? { priority } : {}),
      ...(category ? { category } : {}),
      blocking,
    };
    const rid = get('RECURRENCE-ID');
    if (rid) {
      const w = parseWhen(rid, fallbackTz, warn);
      if (w && uid) {
        overrides.push({ uid, recurrenceId: w.min, item: { ...item, externalId: `${uid}#${minToZonedIso(w.min, start.tz)}` } });
        continue;
      }
    }
    if (seen.has(id)) {
      warn(`Duplicate event id skipped: ${id.slice(0, 40)}`);
      continue;
    }
    seen.add(id);
    masters.push(item);
  }

  // modified single occurrences of a recurring event: hide the original instance, keep the edited one
  for (const o of overrides) {
    const master = masters.find((m) => m.externalId === o.uid);
    if (master?.recurrence) master.recurrence.exdates.push(minToZonedIso(o.recurrenceId, master.timezone));
    masters.push(o.item);
  }

  return { items: masters, warnings, ...(calName ? { calendarName: calName } : {}) };
}
