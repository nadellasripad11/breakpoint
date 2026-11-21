import type { Interval, Minutes } from './types.ts';

const MS_PER_MIN = 60_000;
export const DAY = 1440;

/** parse an iso-8601 instant (must carry an offset or z) into epoch minutes. */
export function isoToMin(iso: string): Minutes {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`Invalid date-time: ${iso}`);
  return Math.round(ms / MS_PER_MIN);
}

export function minToDate(min: Minutes): Date {
  return new Date(min * MS_PER_MIN);
}

/** iso string in utc, e.g. 2026-11-20t23:00:00.000z */
export function minToUtcIso(min: Minutes): string {
  return minToDate(min).toISOString();
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = sunday … 6 = saturday */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(min: Minutes, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(minToDate(min));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: Math.max(0, WEEKDAYS.indexOf(get('weekday'))),
  };
}

/** offset of `tz` from utc at the given instant, in minutes (positive = ahead of utc). */
export function tzOffsetMin(min: Minutes, tz: string): number {
  const p = localParts(min, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / MS_PER_MIN;
  return Math.round(asUtc - min);
}

/**
 * convert a wall-clock time in `tz` to epoch minutes.
 * overlaps (clocks fall back) resolve to the earlier instant. gaps (clocks spring forward, the time does not exist)
 * resolve like temporal's "compatible" mode: shifted forward by the length of the gap (2:30 becomes 3:30).
 */
export function zonedToMin(y: number, mo: number, d: number, h: number, mi: number, tz: string): Minutes {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0) / MS_PER_MIN;
  const offBefore = tzOffsetMin(naive - DAY, tz);
  const offAfter = tzOffsetMin(naive + DAY, tz);
  const valid = [...new Set([naive - offBefore, naive - offAfter])]
    .sort((p, q) => p - q)
    .filter((c) => {
      const p = localParts(c, tz);
      return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi;
    });
  return valid.length ? valid[0]! : naive - offBefore;
}

/** iso string with the tz offset, e.g. 2026-11-20t17:00:00-06:00 */
export function minToZonedIso(min: Minutes, tz: string): string {
  const p = localParts(min, tz);
  const off = tzOffsetMin(min, tz);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** "5:00 pm" in the user's timezone (used in explanations). */
export function fmtClock(min: Minutes, tz: string): string {
  const p = localParts(min, tz);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/** "1h 30m", "45m", "2h". */
export function fmtDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new RangeError(`Invalid HH:MM time: ${s}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) throw new RangeError(`Invalid HH:MM time: ${s}`);
  return h * 60 + mi;
}

/** iterate the local calendar days that intersect [start, end) in `tz`. */
export function* localDays(horizon: Interval, tz: string): Generator<{ y: number; mo: number; d: number; weekday: number; startMin: Minutes }> {
  const first = localParts(horizon.start, tz);
  let cur = Date.UTC(first.year, first.month - 1, first.day);
  for (let guard = 0; guard < 400; guard++) {
    const dt = new Date(cur);
    const y = dt.getUTCFullYear();
    const mo = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    const startMin = zonedToMin(y, mo, d, 0, 0, tz);
    if (startMin >= horizon.end) return;
    yield { y, mo, d, weekday: dt.getUTCDay(), startMin };
    cur += DAY * MS_PER_MIN;
  }
}
